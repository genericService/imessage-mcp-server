import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const PYTHON = '/usr/bin/python3';
const CLI = path.resolve(__dirname, '../bin/imessage');
const FIXTURE_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');

const TEST_DIR = path.join(os.tmpdir(), `imessage-index-test-${process.pid}`);
const FIXTURE_DB = path.join(TEST_DIR, 'chat.db');
const INDEX_DIR = path.join(TEST_DIR, 'index_store');
const INDEX_DB = path.join(INDEX_DIR, 'index.db');

const BASE_ENV = {
  ...process.env,
  IMESSAGE_DB_PATH: FIXTURE_DB,
  INDEX_DB_PATH: INDEX_DB,
  IMESSAGE_SSH_FDA: 'false',
  TZ: 'America/Los_Angeles',
  LC_ALL: 'C',
  LANG: 'C',
};

async function cli(args: string[], customEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON, [CLI, ...args], {
      env: { ...BASE_ENV, ...customEnv },
    });
    return { stdout, stderr };
  } catch (err: any) {
    const stdout = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    throw new Error(`CLI failed: ${stderr || stdout || err.message}`);
  }
}

async function cliJson(args: string[], customEnv: Record<string, string> = {}): Promise<any> {
  const { stdout } = await cli(args, customEnv);
  return JSON.parse(stdout);
}

async function querySqlite(dbPath: string, sql: string, params: any[] = []): Promise<any[]> {
  const script = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute(sys.argv[2], json.loads(sys.argv[3]))
rows = [dict(zip([col[0] for col in c.description], r)) for r in c.fetchall()] if c.description else []
conn.close()
print(json.dumps(rows))
`;
  const { stdout } = await execFileAsync(PYTHON, ['-c', script, dbPath, sql, JSON.stringify(params)]);
  return JSON.parse(stdout);
}

async function runSqlite(dbPath: string, sql: string, params: any[] = []): Promise<void> {
  const script = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute(sys.argv[2], json.loads(sys.argv[3]))
conn.commit()
conn.close()
`;
  await execFileAsync(PYTHON, ['-c', script, dbPath, sql, JSON.stringify(params)]);
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.rmSync(FIXTURE_DB, { force: true });
  fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  execFileSync(PYTHON, [FIXTURE_BUILDER, FIXTURE_DB], { env: BASE_ENV });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('iMessage Local Sidecar Index', () => {
  it('builds initial index with strict 0700 dir and 0600 file permissions and WAL mode', async () => {
    const { stderr } = await cli(['index', 'build'], { INDEX_ENABLED: 'true' });
    expect(fs.existsSync(INDEX_DB)).toBe(true);

    const dirStat = fs.statSync(INDEX_DIR);
    // 0700: directory permissions (rwx------)
    expect(dirStat.mode & 0o777).toBe(0o700);

    const fileStat = fs.statSync(INDEX_DB);
    // 0600: file permissions (rw-------)
    expect(fileStat.mode & 0o777).toBe(0o600);

    // Progress output reported on stderr
    expect(stderr.length).toBeGreaterThan(0);

    const journalMode = await querySqlite(INDEX_DB, 'PRAGMA journal_mode');
    expect(journalMode[0].journal_mode.toLowerCase()).toBe('wal');

    const metaRows = await querySqlite(INDEX_DB, 'SELECT * FROM meta');
    expect(metaRows.length).toBe(1);
    expect(metaRows[0].schema_version).toBe(1);
    expect(metaRows[0].last_indexed_msg_id).toBeGreaterThan(0);

    const messages = await querySqlite(INDEX_DB, 'SELECT COUNT(*) as count FROM messages_idx');
    expect(messages[0].count).toBeGreaterThan(0);

    const attachments = await querySqlite(INDEX_DB, 'SELECT COUNT(*) as count FROM attachments_idx');
    expect(attachments[0].count).toBeGreaterThanOrEqual(1);
  });

  it('reports status with lag and row counts via index status command', async () => {
    const status = await cliJson(['index', 'status', '--json'], { INDEX_ENABLED: 'true' });
    expect(status.enabled).toBe(true);
    expect(status.exists).toBe(true);
    expect(status.schema_version).toBe(1);
    expect(status.lag).toBe(0);
    expect(status.is_caught_up).toBe(true);
    expect(status.messages_count).toBeGreaterThan(0);
    expect(status.file_size_bytes).toBeGreaterThan(0);
  });

  it('indexes new rows incrementally', async () => {
    // Insert new message directly into chat.db
    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me)
       VALUES (999, 'GUID-999', 'Spice harvester sighting on Dune', 1, 812200000000000000, 0)`
    );
    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO chat_message_join (chat_id, message_id, message_date)
       VALUES (7, 999, 812200000000000000)`
    );

    // Verify lag detected before sync
    const statusBefore = await cliJson(['index', 'status', '--json'], { INDEX_ENABLED: 'true' });
    expect(statusBefore.lag).toBeGreaterThan(0);
    expect(statusBefore.is_caught_up).toBe(false);

    // Sync incrementally
    await cli(['index', 'sync'], { INDEX_ENABLED: 'true' });

    const statusAfter = await cliJson(['index', 'status', '--json'], { INDEX_ENABLED: 'true' });
    expect(statusAfter.lag).toBe(0);
    expect(statusAfter.is_caught_up).toBe(true);

    // Verify searchable via FTS
    const searchResult = await cliJson(['search', 'sighting', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchResult.some((m: any) => m.msg_id === 999)).toBe(true);
  });

  it('refreshes edited messages on recheck without changing other data', async () => {
    await runSqlite(
      FIXTURE_DB,
      `UPDATE message SET text = 'Updated spice harvester sighting on Arrakis', date_edited = 800000050000000000
       WHERE ROWID = 999`
    );

    // Run sync with recheck
    await cli(['index', 'sync', '--recheck-days', '30'], { INDEX_ENABLED: 'true' });

    // FTS now matches 'Updated'
    const searchResult = await cliJson(['search', 'Updated', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchResult.some((m: any) => m.msg_id === 999)).toBe(true);

    const row = await querySqlite(INDEX_DB, 'SELECT text_decoded FROM messages_idx WHERE msg_id = 999');
    expect(row[0].text_decoded).toContain('Updated spice harvester');
  });

  it('removes deleted rows from index on recheck', async () => {
    await runSqlite(FIXTURE_DB, `DELETE FROM message WHERE ROWID = 999`);
    await runSqlite(FIXTURE_DB, `DELETE FROM chat_message_join WHERE message_id = 999`);

    // Run sync with recheck
    await cli(['index', 'sync', '--recheck-days', '30'], { INDEX_ENABLED: 'true' });

    const row = await querySqlite(INDEX_DB, 'SELECT * FROM messages_idx WHERE msg_id = 999');
    expect(row.length).toBe(0);

    const fts = await querySqlite(INDEX_DB, 'SELECT * FROM messages_fts WHERE messages_fts MATCH "Updated"');
    expect(fts.length).toBe(0);
  });

  it('indexes and searches attributedBody-only text', async () => {
    const insertScript = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
body = b"streamtyped\\x81\\xe8\\x03\\x84\\x01@\\x84\\x84\\x84\\x12NSAttributedString\\x00\\x84\\x84\\x08NSObject\\x00\\x85\\x92\\x84\\x84\\x84\\x08NSString\\x01\\x94\\x84\\x01+\\x12MuadDib of Arrakis\\x86"
c.execute("INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me) VALUES (1001, 'GUID-1001', NULL, ?, 1, 812200000000000000, 0)", (body,))
c.execute("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (7, 1001, 812200000000000000)")
conn.commit()
conn.close()
`;
    await execFileAsync(PYTHON, ['-c', insertScript, FIXTURE_DB]);

    await cli(['index', 'sync'], { INDEX_ENABLED: 'true' });

    const searchResult = await cliJson(['search', 'MuadDib', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchResult.some((m: any) => m.msg_id === 1001)).toBe(true);
    const item = searchResult.find((m: any) => m.msg_id === 1001);
    expect(item.text).toContain('MuadDib of Arrakis');
  });

  it('performs Spanish accent-insensitive searches (remove_diacritics)', async () => {
    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me)
       VALUES (1002, 'GUID-1002', 'El señor Paul Atreides está en el desierto', 1, 812200000000000000, 0)`
    );
    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO chat_message_join (chat_id, message_id, message_date)
       VALUES (7, 1002, 812200000000000000)`
    );

    await cli(['index', 'sync'], { INDEX_ENABLED: 'true' });

    // Search without accents: "senor" should match "señor"
    const searchNoAccent = await cliJson(['search', 'senor', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchNoAccent.some((m: any) => m.msg_id === 1002)).toBe(true);

    // Search without accents: "esta" should match "está"
    const searchEsta = await cliJson(['search', 'esta', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchEsta.some((m: any) => m.msg_id === 1002)).toBe(true);

    // Search with accent: "señor" should match
    const searchWithAccent = await cliJson(['search', 'señor', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchWithAccent.some((m: any) => m.msg_id === 1002)).toBe(true);
  });

  it('indexes attachments by metadata only and never copies attachment files', async () => {
    const attachmentDir = path.join(TEST_DIR, 'Attachments');
    fs.mkdirSync(attachmentDir, { recursive: true });
    const dummyFile = path.join(attachmentDir, 'ornithopter.jpg');
    fs.writeFileSync(dummyFile, 'fake-jpeg-bytes-for-test');

    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes, uti)
       VALUES (501, 'ATT-501', ?, 'image/jpeg', 'ornithopter.jpg', 24, 'public.jpeg')`,
      [dummyFile]
    );
    await runSqlite(
      FIXTURE_DB,
      `INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1002, 501)`
    );

    await cli(['index', 'sync'], { INDEX_ENABLED: 'true' });

    const attRows = await querySqlite(INDEX_DB, 'SELECT * FROM attachments_idx WHERE attachment_id = 501');
    expect(attRows.length).toBe(1);
    expect(attRows[0].path).toBe(dummyFile);
    expect(attRows[0].mime_type).toBe('image/jpeg');
    expect(attRows[0].transfer_name).toBe('ornithopter.jpg');

    // Verify NO files exist in INDEX_DIR other than index.db and WAL/SHM files
    const indexFiles = fs.readdirSync(INDEX_DIR);
    for (const f of indexFiles) {
      expect(['index.db', 'index.db-wal', 'index.db-shm']).toContain(f);
    }
  });

  it('falls back to chat.db when index is missing, corrupt, or behind, and logs warning', async () => {
    const missingDbPath = path.join(TEST_DIR, 'nonexistent', 'index.db');
    const { stdout, stderr } = await cli(['search', 'spice', '--json'], {
      INDEX_ENABLED: 'true',
      INDEX_DB_PATH: missingDbPath,
    });
    // Fallback succeeds and returns results
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    // Warning logged to stderr
    expect(stderr).toContain('[Index]');

    // Corrupt database test
    const corruptDbPath = path.join(TEST_DIR, 'corrupt.db');
    fs.writeFileSync(corruptDbPath, 'not a valid sqlite database file header');
    const corruptRun = await cli(['search', 'spice', '--json'], {
      INDEX_ENABLED: 'true',
      INDEX_DB_PATH: corruptDbPath,
    });
    const corruptResults = JSON.parse(corruptRun.stdout);
    expect(corruptResults.length).toBeGreaterThan(0);
    expect(corruptRun.stderr).toContain('[Index]');
  });

  it('returns identical output when INDEX_ENABLED is unset vs legacy chat.db search', async () => {
    const withoutIndex = await cliJson(['search', 'spice', '--limit', '5', '--json'], {
      INDEX_ENABLED: 'false',
    });
    const withIndex = await cliJson(['search', 'spice', '--limit', '5', '--json'], {
      INDEX_ENABLED: 'true',
    });

    expect(withIndex.length).toBe(withoutIndex.length);
    for (let i = 0; i < withIndex.length; i++) {
      expect(withIndex[i].msg_id).toBe(withoutIndex[i].msg_id);
      expect(withIndex[i].text).toBe(withoutIndex[i].text);
      expect(withIndex[i].chat_id).toBe(withoutIndex[i].chat_id);
      expect(withIndex[i].is_from_me).toBe(withoutIndex[i].is_from_me);
    }
  });

  it('never logs message text, handles, or contact names', async () => {
    const { stderr: buildStderr } = await cli(['index', 'build'], { INDEX_ENABLED: 'true' });
    const { stderr: searchStderr } = await cli(['search', 'spice', '--json'], { INDEX_ENABLED: 'true' });
    const { stderr: syncStderr } = await cli(['index', 'sync', '--recheck-days', '14'], { INDEX_ENABLED: 'true' });

    const combinedStderr = `${buildStderr}\n${searchStderr}\n${syncStderr}`;
    // Assert message contents and handles are never printed to stderr
    expect(combinedStderr).not.toContain('The spice must flow');
    expect(combinedStderr).not.toContain('MuadDib of Arrakis');
    expect(combinedStderr).not.toContain('El señor Paul Atreides');
    expect(combinedStderr).not.toContain('paul@caladan.org');
    expect(combinedStderr).not.toContain('+15550199480');
  });

  it('supports search order by recent and relevance (bm25)', async () => {
    const recent = await cliJson(['search', 'spice', '--order', 'recent', '--json'], {
      INDEX_ENABLED: 'true',
    });
    const relevance = await cliJson(['search', 'spice', '--order', 'relevance', '--json'], {
      INDEX_ENABLED: 'true',
    });

    expect(recent.length).toBeGreaterThan(0);
    expect(relevance.length).toBeGreaterThan(0);
  });

  it('exposes imessage_index_status tool schema and search order in TOOLS array', async () => {
    const { TOOLS } = await import('../src/index.js');
    const indexStatusTool = TOOLS.find((t) => t.name === 'imessage_index_status');
    expect(indexStatusTool).toBeDefined();
    expect(indexStatusTool?.description).toContain('Inspect the status of the local search index');

    const searchTool = TOOLS.find((t) => t.name === 'imessage_search_messages');
    expect(searchTool).toBeDefined();
    const props = searchTool?.inputSchema.properties as Record<string, any>;
    expect(props.order).toBeDefined();
    expect(props.order.enum).toEqual(['recent', 'relevance']);
    expect(props.chat).toBeDefined();
  });

  it('reports comprehensive status via imessage index status --json', async () => {
    const status = await cliJson(['index', 'status', '--json'], {
      INDEX_ENABLED: 'true',
    });
    expect(status.enabled).toBe(true);
    expect(status.exists).toBe(true);
    expect(status.schema_version).toBe(1);
    expect(status.is_caught_up).toBe(true);
    expect(status.lag).toBe(0);
    expect(status.messages_count).toBeGreaterThan(0);
    expect(status.file_size_bytes).toBeGreaterThan(0);
  });

  it('activates watcher when INDEX_ENABLED is true even without WATCH_ENABLED or webhook rules', async () => {
    const { parseWatcherConfig } = await import('../src/watcher.js');
    const prevIndex = process.env.INDEX_ENABLED;
    const prevWatch = process.env.WATCH_ENABLED;
    const prevRules = process.env.WATCH_RULES;

    try {
      process.env.INDEX_ENABLED = 'true';
      delete process.env.WATCH_ENABLED;
      delete process.env.WATCH_RULES;

      const config = parseWatcherConfig();
      expect(config).toBeDefined();
      expect(config?.enabled).toBe(true);
      expect(config?.rules).toEqual([]);
    } finally {
      if (prevIndex !== undefined) process.env.INDEX_ENABLED = prevIndex;
      else delete process.env.INDEX_ENABLED;

      if (prevWatch !== undefined) process.env.WATCH_ENABLED = prevWatch;
      else delete process.env.WATCH_ENABLED;

      if (prevRules !== undefined) process.env.WATCH_RULES = prevRules;
      else delete process.env.WATCH_RULES;
    }
  });
});

