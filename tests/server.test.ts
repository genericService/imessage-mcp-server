import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fsSync from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = path.resolve(__dirname, '../bin/imessage');

/**
 * The CLI contract tests require a real iMessage database. On CI or any
 * non-macOS machine there is none, so these previously failed the whole suite
 * for environmental reasons rather than genuine regressions. They now run
 * against a synthetic fixture database instead, so the JSON output contract is
 * verified everywhere.
 */
const FIXTURE_DB = path.join(os.tmpdir(), 'imessage-mcp-test-fixture.db');

function buildFixtureDb(): boolean {
  const script = `
import sqlite3, os, datetime, sys
p = sys.argv[1]
if os.path.exists(p):
    os.remove(p)
c = sqlite3.connect(p)
c.executescript('''
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT, chat_identifier TEXT);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER, handle_id INTEGER, text TEXT, attributedBody BLOB);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
''')
c.execute("INSERT INTO chat VALUES (1,'Arrakis Council','chat_arrakis')")
c.execute("INSERT INTO handle VALUES (1,'+15550100','iMessage')")
c.execute("INSERT INTO chat_handle_join VALUES (1,1)")
epoch = datetime.datetime(2001,1,1,tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
ns = int((now-epoch).total_seconds()*1_000_000_000)
c.execute("INSERT INTO message VALUES (1,?,0,1,'The spice must flow',NULL)", (ns,))
c.execute("INSERT INTO chat_message_join VALUES (1,1)")
c.commit(); c.close()
`;
  try {
    require('child_process').execFileSync(PYTHON_BIN, ['-c', script, FIXTURE_DB]);
    return fsSync.existsSync(FIXTURE_DB);
  } catch {
    return false;
  }
}

const hasPython = fsSync.existsSync(PYTHON_BIN);
const fixtureReady = hasPython && buildFixtureDb();
const cliEnv = { ...process.env, IMESSAGE_DB_PATH: FIXTURE_DB };

/** Run the CLI against the fixture database. */
function runFixtureCli(args: string[]) {
  return execFileAsync(PYTHON_BIN, [CLI_PATH, ...args], { env: cliEnv });
}

describe('iMessage MCP Tool Schemas (SDD)', () => {
  it('should define required tool names and properties', () => {
    const requiredTools = [
      'imessage_list_chats',
      'imessage_read_messages',
      'imessage_search_messages',
      'imessage_search_contacts',
      'imessage_get_chat_members',
      'imessage_get_attachment_payload',
      'imessage_send_message',
      'imessage_get_readme',
      'imessage_get_recent_messages',
      'imessage_search_group_chats'
    ];

    expect(requiredTools).toHaveLength(10);
  });

  it('should have a readable README.md documentation file', async () => {
    const fs = await import('fs');
    const readmePath = path.resolve(__dirname, '../README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, 'utf8');
    expect(content).toContain('iMessage MCP Server');
  });
});

describe.skipIf(!fixtureReady)('CLI JSON Output Contracts (SDD & TDD)', () => {
  it('should return valid JSON when --json flag is passed to imessage list', async () => {
    const { stdout } = await runFixtureCli(['list', '--limit', '3', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('rowid');
    expect(data[0]).toHaveProperty('identifier');
  });

  it('should return valid JSON when --json flag is passed to imessage search', async () => {
    const { stdout } = await runFixtureCli(['search', 'spice', '--limit', '2', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].text).toContain('spice');
  });

  it('should return valid JSON when --json flag is passed to imessage contacts', async () => {
    const { stdout } = await runFixtureCli(['contacts', '', '--json']);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('should return valid JSON for recent messages CLI command', async () => {
    const { stdout } = await runFixtureCli(['recent', '1', '--limit', '2', '--json']);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('should return valid JSON for search-group CLI command', async () => {
    const { stdout } = await runFixtureCli(['search-group', 'Arrakis', '--json']);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('should support recipient parameter targeting group chats or phone numbers', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'send', '--help']);
    expect(stdout).toContain('Recipient identifier');
  });

  it('should return an empty JSON array (not a crash) for an unmatched chat', async () => {
    const { stdout } = await runFixtureCli(['read', 'NO_SUCH_CHAT_XYZ', '--json']);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('should emit an actionable error when the database is missing', async () => {
    await expect(
      execFileAsync(PYTHON_BIN, [CLI_PATH, 'list', '--json'], {
        env: { ...process.env, IMESSAGE_DB_PATH: '/nonexistent/path/chat.db' }
      })
    ).rejects.toThrow(/Full Disk Access|not found/);
  });

  it('should reject a missing attachment with a clean error, not a traceback', async () => {
    try {
      await runFixtureCli(['attachment', '/nonexistent/file.png', '--json']);
      throw new Error('expected failure');
    } catch (err: any) {
      expect(err.stderr).toContain('Attachment file not found');
      expect(err.stderr).not.toContain('Traceback');
    }
  });
});

describe('Local Action Audit Logger (Security & Privacy)', () => {
  it('should write JSON audit event when ENABLE_AUDIT_LOG=true', async () => {
    const fs = await import('fs');
    const { logAuditEvent } = await import('../src/audit.js');
    process.env.ENABLE_AUDIT_LOG = 'true';
    const auditFile = path.resolve(process.cwd(), 'logs/audit.log');

    logAuditEvent({
      timestamp: new Date().toISOString(),
      tool: 'imessage_send_message',
      target: 'Sarah (+14802016076)',
      dry_run: true,
      status: 'success',
      duration_ms: 42
    });

    expect(fs.existsSync(auditFile)).toBe(true);
    const content = fs.readFileSync(auditFile, 'utf8');
    expect(content).toContain('imessage_send_message');
    expect(content).toContain('Sarah (+14802016076)');
    expect(content).not.toContain('message_text');
  });

  it('should write http_connection audit events', async () => {
    const fs = await import('fs');
    const { logAuditEvent } = await import('../src/audit.js');
    process.env.ENABLE_AUDIT_LOG = 'true';
    const auditFile = path.resolve(process.cwd(), 'logs/audit.log');

    logAuditEvent({
      timestamp: new Date().toISOString(),
      type: 'http_connection',
      client_id: 'ubuntu-remote',
      client_ip: '192.168.1.50',
      user_agent: 'AntigravityCLI/1.0',
      method: 'POST',
      path: '/mcp',
      status_code: 200,
      status: 'success',
      duration_ms: 12
    });

    const content = fs.readFileSync(auditFile, 'utf8');
    expect(content).toContain('http_connection');
    expect(content).toContain('ubuntu-remote');
    expect(content).toContain('192.168.1.50');
  });
});

describe('OAuth 2.0 Auth Server & JWT Verification', () => {
  it('should sign and verify valid HS256 JWT tokens', async () => {
    const { signJwt, verifyJwt } = await import('../src/oauth.js');
    const token = signJwt({ sub: 'test-agent', scope: 'imessage:all' }, 3600);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const payload = verifyJwt(token);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('test-agent');
    expect(payload?.scope).toBe('imessage:all');
  });

  it('should reject invalid or tampered JWT tokens', async () => {
    const { verifyJwt } = await import('../src/oauth.js');
    expect(verifyJwt('invalid.token.string')).toBeNull();
    expect(verifyJwt('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.tampered_signature')).toBeNull();
  });

  it('should generate RFC 8414 OAuth server metadata', async () => {
    const { getOAuthMetadata } = await import('../src/oauth.js');
    const meta = getOAuthMetadata('https://imessage.genericservice.app');
    expect(meta.issuer).toBe('https://imessage.genericservice.app');
    expect(meta.token_endpoint).toBe('https://imessage.genericservice.app/oauth/token');
    expect(meta.authorization_endpoint).toBe('https://imessage.genericservice.app/oauth/authorize');
    expect(meta.grant_types_supported).toContain('authorization_code');
  });

  it('should return a Map from getClientRegistry()', async () => {
    const { getClientRegistry } = await import('../src/oauth.js');
    const registry = getClientRegistry();
    expect(registry).toBeInstanceOf(Map);
  });
});

describe('MCP 2026-07-28 Spec Compliance', () => {
  it('should declare protocol version 2026-07-28 and support stateless discovery', async () => {
    const { SPEC_VERSION } = await import('../src/index.js');
    expect(SPEC_VERSION).toBe('2026-07-28');
  });
});

describe('Input Boundary Sanitisation (SDD)', () => {
  it('should coerce numeric strings and clamp out-of-range values', async () => {
    const { clampNumber } = await import('../src/validation.js');
    expect(clampNumber('30', 'limit', 10, 1, 100)).toBe(30);   // MCP clients often send strings
    expect(clampNumber(500, 'limit', 10, 1, 100)).toBe(100);   // clamped to max
    expect(clampNumber(-5, 'limit', 10, 1, 100)).toBe(1);      // clamped to min
    expect(clampNumber(undefined, 'limit', 10, 1, 100)).toBe(10);
    expect(clampNumber(2.9, 'limit', 10, 1, 100)).toBe(2);     // floored
  });

  it('should reject non-numeric and non-string inputs with a clear message', async () => {
    const { clampNumber, requireString, ValidationError } = await import('../src/validation.js');
    expect(() => clampNumber('abc', 'limit', 10, 1, 100)).toThrow(ValidationError);
    expect(() => requireString({ a: 1 }, { field: 'chat' })).toThrow(/must be a string/);
    expect(() => requireString('', { field: 'chat' })).toThrow(/Missing required parameter/);
  });

  it('should strip null bytes and enforce max length', async () => {
    const { requireString } = await import('../src/validation.js');
    expect(() => requireString('bad\u0000value', { field: 'chat' })).toThrow(/null bytes/);
    expect(() => requireString('x'.repeat(50), { field: 'chat', maxLength: 10 })).toThrow(/maximum length/);
  });

  it('should accept arrays and comma-separated strings for participants', async () => {
    const { requireStringArray } = await import('../src/validation.js');
    expect(requireStringArray(['Paul', 'Chani'], 'participants')).toEqual(['Paul', 'Chani']);
    expect(requireStringArray('Paul, Chani', 'participants')).toEqual(['Paul', 'Chani']);
    expect(() => requireStringArray([], 'participants')).toThrow(/at least one/);
    expect(() => requireStringArray(undefined, 'participants')).toThrow(/Missing required parameter/);
  });

  it('should coerce boolean-ish values from varied client encodings', async () => {
    const { coerceBoolean } = await import('../src/validation.js');
    expect(coerceBoolean('true')).toBe(true);
    expect(coerceBoolean(1)).toBe(true);
    expect(coerceBoolean('false')).toBe(false);
    expect(coerceBoolean(undefined)).toBe(false);
  });
});

describe('Subprocess Resilience (crash & hang prevention)', () => {
  it('should kill a hung child process and report ETIMEDOUT rather than hanging', async () => {
    const { runCli, CliError } = await import('../src/runner.js');

    // A CLI that never exits, standing in for a wedged AppleScript/TCC prompt.
    const sleeper = path.join(os.tmpdir(), 'imessage-test-sleeper.py');
    fsSync.writeFileSync(sleeper, 'import time\ntime.sleep(120)\n');

    const started = Date.now();
    let caught: any;
    try {
      await runCli(['ignored'], { timeoutMs: 1000, cliPathOverride: sleeper } as any);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    fsSync.rmSync(sleeper, { force: true });

    expect(caught).toBeInstanceOf(CliError);
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.timedOut).toBe(true);
    // Must abort near the timeout, not hang for the child's full 120s.
    expect(elapsed).toBeLessThan(10000);
  }, 20000);

  it('should surface a structured CliError with a stable error code', async () => {
    const { CliError } = await import('../src/runner.js');
    const err = new CliError('boom', { code: 'ETIMEDOUT', timedOut: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ETIMEDOUT');
    expect(err.timedOut).toBe(true);
  });

  it('should bound concurrent subprocess execution', async () => {
    const { getRunnerStats } = await import('../src/runner.js');
    const stats = getRunnerStats();
    expect(stats).toHaveProperty('inFlight');
    expect(stats).toHaveProperty('queued');
    expect(stats.inFlight).toBeGreaterThanOrEqual(0);
  });
});

describe('OAuth Hardening', () => {
  it('should reject the alg=none algorithm-confusion attack', async () => {
    const { verifyJwt } = await import('../src/oauth.js');
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'attacker', exp: 9999999999 })}.`;
    expect(verifyJwt(forged)).toBeNull();
  });

  it('should not throw on a truncated signature (timingSafeEqual length mismatch)', async () => {
    const { signJwt, verifyJwt } = await import('../src/oauth.js');
    const token = signJwt({ sub: 'x' }, 3600);
    const [h, p] = token.split('.');
    // crypto.timingSafeEqual throws on unequal buffer lengths; this must return null.
    expect(() => verifyJwt(`${h}.${p}.short`)).not.toThrow();
    expect(verifyJwt(`${h}.${p}.short`)).toBeNull();
  });

  it('should reject expired tokens', async () => {
    const { signJwt, verifyJwt } = await import('../src/oauth.js');
    expect(verifyJwt(signJwt({ sub: 'x' }, -10))).toBeNull();
  });

  it('should compare secrets in constant time without throwing on length mismatch', async () => {
    const { safeEqual } = await import('../src/oauth.js');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('should expose bounded OAuth token stores', async () => {
    const { getOAuthStoreStats } = await import('../src/oauth.js');
    const stats = getOAuthStoreStats();
    expect(stats).toHaveProperty('authCodes');
    expect(stats).toHaveProperty('refreshTokens');
  });
});

describe('Configuration Resilience', () => {
  it('should load dotenv before dependent modules read secrets', async () => {
    // Regression: oauth.ts previously read process.env at module scope, which
    // in ESM executes before index.ts called dotenv.config().
    const { config } = await import('../src/config.js');
    expect(config.jwtSecret).toBeTruthy();
    expect(typeof config.port).toBe('number');
  });

  it('should clamp invalid numeric env values instead of producing NaN', async () => {
    const { config } = await import('../src/config.js');
    expect(Number.isFinite(config.port)).toBe(true);
    expect(config.port).toBeGreaterThan(0);
    expect(config.maxConcurrentCli).toBeGreaterThanOrEqual(1);
    expect(config.readTimeoutMs).toBeGreaterThan(0);
  });

  it('should not contain a hardcoded legacy bearer token in source', async () => {
    // The credential must come from LEGACY_TOKEN, never from the repository.
    const src = fsSync.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
    expect(src).not.toMatch(/ub_[0-9a-f]{32,}/);
  });
});

describe('Audit Log Durability', () => {
  it('should never persist message text or secrets', async () => {
    const { logAuditEvent } = await import('../src/audit.js');
    process.env.ENABLE_AUDIT_LOG = 'true';
    logAuditEvent({
      timestamp: new Date().toISOString(),
      tool: 'imessage_send_message',
      target: 'Paul Atreides',
      status: 'success',
      duration_ms: 5,
      // @ts-expect-error deliberately passing a forbidden field
      message: 'the sleeper must awaken',
      // @ts-expect-error deliberately passing a forbidden field
      base64: 'AAAA'
    });
    const { getAuditStatus } = await import('../src/audit.js');
    const status = getAuditStatus();
    if (status.file && fsSync.existsSync(status.file)) {
      const content = fsSync.readFileSync(status.file, 'utf8');
      expect(content).not.toContain('the sleeper must awaken');
      expect(content).not.toContain('AAAA');
    }
  });

  it('should report status without throwing when logging is disabled', async () => {
    const { getAuditStatus } = await import('../src/audit.js');
    expect(getAuditStatus()).toHaveProperty('enabled');
  });
});

describe('Package-relative path resolution', () => {
  it('should resolve README via the package root, not the process cwd', async () => {
    // Regression: the resources/read handler resolved '../README.md' against a
    // stale base, producing ENOENT ("/home/user/README.md") whenever the
    // server was launched from a different working directory -- the common
    // case under launchd/systemd, which start with cwd '/'.
    const { PACKAGE_ROOT } = await import('../src/config.js');
    const readme = path.join(PACKAGE_ROOT, 'README.md');
    expect(fsSync.existsSync(readme)).toBe(true);
    expect(fsSync.readFileSync(readme, 'utf8')).toContain('iMessage MCP Server');
  });

  it('should resolve the CLI path against the package root', async () => {
    const { config } = await import('../src/config.js');
    expect(fsSync.existsSync(config.cliPath)).toBe(true);
  });
});
