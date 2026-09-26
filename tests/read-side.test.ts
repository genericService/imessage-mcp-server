import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';

const execFileAsync = promisify(execFile);
const PYTHON = '/usr/bin/python3';
const CLI = path.resolve(__dirname, '../bin/imessage');
const FIXTURE_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');
const FIXTURE_DB = path.join(os.tmpdir(), `imessage-read-side-${process.pid}.db`);

process.env.NODE_ENV = 'test';
process.env.IMESSAGE_DB_PATH = FIXTURE_DB;
process.env.IMESSAGE_SSH_FDA = 'false';
process.env.TZ = 'America/Los_Angeles';

const ENV = {
  ...process.env,
  IMESSAGE_DB_PATH: FIXTURE_DB,
  IMESSAGE_SSH_FDA: 'false',
  TZ: 'America/Los_Angeles',
  LC_ALL: 'C',
  LANG: 'C',
};

async function cli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PYTHON, [CLI, ...args], { env: ENV });
    return stdout;
  } catch (err: any) {
    const detail = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    throw new Error(detail);
  }
}

async function cliJson(args: string[]): Promise<any> {
  return JSON.parse(await cli(args));
}

beforeAll(() => {
  fs.rmSync(FIXTURE_DB, { force: true });
  execFileSync(PYTHON, [FIXTURE_BUILDER, FIXTURE_DB], { env: ENV });
});

afterAll(() => {
  fs.rmSync(FIXTURE_DB, { force: true });
});

describe('incremental polling (since_msg_id)', () => {
  it('returns only messages in that chat with id strictly greater than since_msg_id', async () => {
    const data = await cliJson(['recent', '7', '--since-msg-id', '105', '--limit', '20', '--json']);
    expect(Array.isArray(data)).toBe(true);
    const ids = data.map((m: any) => m.msg_id);
    expect(ids.every((id: number) => id > 105)).toBe(true);
    expect(ids).not.toContain(200);
    expect(ids).toContain(107);
    expect(ids).toContain(111);
  });

  it('keeps the cursor cheap and pageable via next_since_msg_id and has_more', async () => {
    const page = await cliJson(['recent', '7', '--since-msg-id', '100', '--limit', '2', '--with-meta', '--json']);
    expect(page.messages).toHaveLength(2);
    expect(page.messages.every((m: any) => m.msg_id > 100)).toBe(true);
    expect(page.has_more).toBe(true);
    expect(page.next_since_msg_id).toBe(page.messages[page.messages.length - 1].next_since_msg_id);
    const next = await cliJson([
      'recent', '7', '--since-msg-id', String(page.next_since_msg_id), '--limit', '20', '--json'
    ]);
    expect(next.every((m: any) => m.msg_id > page.next_since_msg_id)).toBe(true);
  });

  it('applies since_msg_id on read and search as well', async () => {
    const read = await cliJson(['read', '7', '--days', '30', '--since-msg-id', '107', '--json']);
    expect(read.map((m: any) => m.msg_id).every((id: number) => id > 107)).toBe(true);
    const search = await cliJson(['search', 'spice', '--since-msg-id', '100', '--limit', '20', '--json']);
    expect(search.length).toBeGreaterThan(0);
    expect(search.every((m: any) => m.msg_id > 100)).toBe(true);
  });

  it('supports --since-message-id, --after-id, and --since-id aliases identically', async () => {
    const canonical = await cliJson(['recent', '7', '--since-msg-id', '105', '--limit', '20', '--json']);
    const aliasMessageId = await cliJson(['recent', '7', '--since-message-id', '105', '--limit', '20', '--json']);
    const aliasAfterId = await cliJson(['recent', '7', '--after-id', '105', '--limit', '20', '--json']);
    const aliasSinceId = await cliJson(['recent', '7', '--since-id', '105', '--limit', '20', '--json']);
    expect(aliasMessageId).toEqual(canonical);
    expect(aliasAfterId).toEqual(canonical);
    expect(aliasSinceId).toEqual(canonical);
  });
});

describe('link previews', () => {
  it('surfaces Spotify NSKeyedArchiver metadata without hiding the raw attachment', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const spotify = data.find((m: any) => m.msg_id === 102);
    expect(spotify.text).toContain('https://open.spotify.com/track/spice-melange');
    expect(spotify.link_preview).toEqual({
      url: 'https://open.spotify.com/track/spice-melange',
      title: 'Fear is the Mind-Killer',
      subtitle: 'Paul Atreides',
      artist: 'Paul Atreides',
      site_name: 'Spotify',
    });
    expect(spotify.attachments.length).toBeGreaterThan(0);
    expect(spotify.attachments[0].transfer_name).toBe('pluginPayloadAttachment');
    expect(String(spotify.attachments[0].filename)).toContain('pluginPayloadAttachment');
    expect(spotify.attachments[0].uti).toContain('pluginPayload');
  });

  it('reads a plain binary plist link preview', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const gazette = data.find((m: any) => m.msg_id === 111);
    expect(gazette.link_preview).toMatchObject({
      url: 'https://www.arrakis.example/spice',
      title: 'Spice Melange',
      subtitle: 'The spice must flow',
      site_name: 'Arrakis Gazette',
    });
    expect(gazette.link_preview.artist).toBeNull();
  });
});

describe('tapbacks', () => {
  it('attaches reactions to their target and does not repeat them as text', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const blob = JSON.stringify(data);
    expect(blob).not.toContain('Loved');
    expect(blob).not.toContain('Liked');
    expect(blob).not.toContain('Removed a heart');
    expect(blob).not.toContain('Reacted');
    const target = data.find((m: any) => m.msg_id === 100);
    const types = target.reactions.map((r: any) => `${r.type}:${r.action}`);
    expect(types).toContain('love:added');
    expect(types).toContain('love:removed');
    const added = target.reactions.find((r: any) => r.action === 'added');
    expect(added.sender).toBe('+15550199480');
    expect(added.is_from_me).toBe(false);
    expect(added.target_msg_id).toBe(100);
    expect(added.target_guid).toBe('A1000000-0000-4000-8000-000000000100');
    expect(added.associated_message_guid).toContain(added.target_guid);
    const mine = data.find((m: any) => m.msg_id === 102).reactions[0];
    expect(mine.type).toBe('like');
    expect(mine.action).toBe('added');
    expect(mine.sender).toBe('Me');
    expect(mine.handle).toBe('');
    expect(mine.is_from_me).toBe(true);
    const emoji = data.find((m: any) => m.msg_id === 105).reactions[0];
    expect(emoji.type).toBe('emoji');
    expect(emoji.emoji).toBe('🪱');
    expect(emoji.action).toBe('added');
    expect(emoji.target_msg_id).toBe(105);
  });

  it('can list reactions separately without duplicating them on the target', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--reactions', 'separate', '--json']);
    const love = data.find((m: any) => m.msg_id === 103);
    expect(love.kind).toBe('reaction');
    expect(love.text).toBeNull();
    expect(love.reaction).toMatchObject({
      type: 'love',
      action: 'added',
      target_msg_id: 100,
    });
    const target = data.find((m: any) => m.msg_id === 100);
    expect(target.reactions).toEqual([]);
  });
});

describe('timestamps', () => {
  it('keeps the human timestamp and adds ISO 8601 with the host offset', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const first = data.find((m: any) => m.msg_id === 100);
    expect(first.timestamp).toBe('2026-09-25 09:25 PM');
    expect(first.timestamp_iso).toBe('2026-09-25T21:25:00-07:00');
  });

  it('adds timestamp_iso on edit history without dropping the human timestamp', async () => {
    const data = await cliJson(['edits', '107', '--json']);
    expect(data.edit_history[0].timestamp).toMatch(/PM|AM/);
    expect(data.edit_history[0].timestamp_iso).toBe('2026-09-25T21:32:00-07:00');
    expect(data.edit_history[1].timestamp_iso).toBe('2026-09-25T21:34:00-07:00');
    expect(data.last_edited).toBe(data.edit_history[1].timestamp);
    expect(data.last_edited_iso).toBe('2026-09-25T21:34:00-07:00');
    expect(data.timestamp_iso).toMatch(/-07:00$/);
  });
});

describe('me rows and id gaps', () => {
  it('does not present the other participant as the sender handle on is_from_me rows', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const mine = data.find((m: any) => m.msg_id === 101);
    expect(mine.is_from_me).toBe(true);
    expect(mine.sender).toBe('Me');
    expect(mine.handle).toBe('');
    expect(mine.participant).toBe('+15550199480');
    expect(mine.chat).toBe('Chani');
    expect(mine.chat_id).toBe(7);
    const theirs = data.find((m: any) => m.msg_id === 100);
    expect(theirs.sender).toBe('+15550199480');
    expect(theirs.handle).toBe('+15550199480');
  });

  it('explains filtered tapbacks and does not count unrelated id holes', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--with-meta', '--json']);
    expect(data.filtered).toEqual({ reaction: 4 });
    const ids = data.messages.map((m: any) => m.msg_id);
    expect(ids).not.toContain(103);
    expect(ids).not.toContain(109);
    const last = data.messages.find((m: any) => m.msg_id === 111);
    expect(last.skipped_before).toEqual({ reaction: 1 });
    expect(data.next_since_msg_id).toBe(111);
    const included = await cliJson(['recent', '7', '--limit', '20', '--include-filtered', '--json']);
    expect(included.map((m: any) => m.msg_id)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 111]);
    expect(included.find((m: any) => m.msg_id === 103).kind).toBe('reaction');
  });

  it('returns an orphan reaction when its target is outside the since window', async () => {
    const data = await cliJson(['recent', '7', '--since-msg-id', '105', '--limit', '20', '--json']);
    const removed = data.find((m: any) => m.msg_id === 108);
    expect(removed.kind).toBe('reaction');
    expect(removed.reaction).toMatchObject({ type: 'love', action: 'removed', target_msg_id: 100 });
    expect(removed.text).toBeNull();
  });
});

describe('edit history does not regress', () => {
  it('still returns chronological revisions for an edited message', async () => {
    const data = await cliJson(['edits', '107', '--json']);
    expect(data.msg_id).toBe(107);
    expect(data.is_edited).toBe(true);
    expect(data.has_edits).toBe(true);
    expect(data.edit_count).toBe(1);
    expect(data.edit_history).toHaveLength(2);
    expect(data.edit_history[0]).toMatchObject({ revision: 0, label: 'original', text: 'Original spice report' });
    expect(data.edit_history[1]).toMatchObject({ revision: 1, label: 'edit_1', text: 'Revised spice report' });
    expect(data.current_text).toBe('Revised spice report');
    const text = await cli(['edits', '107']);
    expect(text).toContain('EDIT HISTORY FOR MESSAGE #107');
    expect(text).toContain('[Original]');
    expect(text).toContain('[Edit 1]');
  });

  it('still reports an unedited message as a single original revision', async () => {
    const data = await cliJson(['edits', '100', '--json']);
    expect(data.is_edited).toBe(false);
    expect(data.has_edits).toBe(false);
    expect(data.edit_count).toBe(0);
    expect(data.last_edited).toBeNull();
    expect(data.edit_history).toHaveLength(1);
    expect(data.edit_history[0].label).toBe('original');
  });

  it('still rejects incoming edits and edits outside the 15 minute window', async () => {
    await expect(cli(['edit', '100', '--text', 'nope', '--json'])).rejects.toThrow(/incoming/);
    await expect(cli(['edit', '101', '--text', 'nope', '--json'])).rejects.toThrow(/15 minutes/);
  });
});

describe('parameter aliases', () => {
  it('documents chat as the list ROWID and accepts chat_id and since_message_id aliases', async () => {
    process.env.IMESSAGE_DB_PATH = FIXTURE_DB;
    process.env.IMESSAGE_SSH_FDA = 'false';
    process.env.NODE_ENV = 'test';
    process.env.TZ = 'America/Los_Angeles';
    const { TOOLS, readChatArg, readIntArg } = await import('../src/index.js');
    const recent = TOOLS.find((tool) => tool.name === 'imessage_get_recent_messages');
    expect(recent).toBeTruthy();
    const schema = recent!.inputSchema as any;
    expect(schema.properties.chat.description).toContain('rowid');
    expect(schema.properties.chat.description).toContain('imessage_list_chats');
    expect(schema.properties.chat_id.description).toContain('Alias of chat');
    expect(schema.properties.since_msg_id).toBeTruthy();
    expect(schema.properties.since_message_id.description).toContain('Alias of since_msg_id');
    expect(schema.properties.after_id.description).toContain('Alias of since_msg_id');
    expect(schema.properties.afterId.description).toContain('Alias of since_msg_id');
    expect(schema.properties.sinceMessageId.description).toContain('Alias of since_msg_id');
    expect(readChatArg({ chat_id: '7' })).toBe('7');
    expect(readChatArg({ chatId: 7 })).toBe('7');
    expect(readChatArg({ thread_id: 'Chani' })).toBe('Chani');
    expect(readIntArg({ since: '105' }, ['since_msg_id', 'since'])).toBe(105);
    expect(readIntArg({ since_message_id: '105' }, ['since_msg_id', 'since_message_id'])).toBe(105);
    expect(readIntArg({ after_id: 105 }, ['since_msg_id', 'after_id'])).toBe(105);
  });

  it('serves recent messages when the tool is called with chat_id and since_message_id', async () => {
    process.env.IMESSAGE_DB_PATH = FIXTURE_DB;
    process.env.IMESSAGE_SSH_FDA = 'false';
    process.env.NODE_ENV = 'test';
    process.env.BEARER_TOKEN = 'fixture-token';
    process.env.TZ = 'America/Los_Angeles';
    const { app } = await import('../src/index.js');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as import('net').AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'imessage_get_recent_messages',
            arguments: { chat_id: '7', since_message_id: 107, limit: 10, with_meta: true },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeTruthy();
      const payload = JSON.parse(dataLine!.slice('data: '.length));
      const parsed = JSON.parse(payload.result.content[0].text);
      const ids = parsed.messages.map((m: { msg_id: number }) => m.msg_id);
      expect(ids).toContain(111);
      expect(ids).not.toContain(100);
      expect(parsed.next_since_msg_id).toBe(111);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('delivery and read receipts on message records', () => {
  it('surfaces delivery and read receipts with ISO timestamps on outgoing messages', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const msg101 = data.find((m: any) => m.msg_id === 101);
    expect(msg101).toBeDefined();
    expect(msg101.is_from_me).toBe(true);
    expect(msg101.is_delivered).toBe(true);
    expect(typeof msg101.delivered_at).toBe('string');
    expect(typeof msg101.delivered_at_iso).toBe('string');
    expect(msg101.is_read).toBe(true);
    expect(typeof msg101.read_at).toBe('string');
    expect(typeof msg101.read_at_iso).toBe('string');
  });

  it('surfaces unread outgoing message with delivery timestamp but null read timestamp', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const msg107 = data.find((m: any) => m.msg_id === 107);
    expect(msg107).toBeDefined();
    expect(msg107.is_from_me).toBe(true);
    expect(msg107.is_delivered).toBe(true);
    expect(typeof msg107.delivered_at_iso).toBe('string');
    expect(msg107.is_read).toBe(false);
    expect(msg107.read_at).toBeNull();
    expect(msg107.read_at_iso).toBeNull();
  });

  it('surfaces incoming message receipt fields cleanly', async () => {
    const data = await cliJson(['recent', '7', '--limit', '20', '--json']);
    const msg100 = data.find((m: any) => m.msg_id === 100);
    expect(msg100).toBeDefined();
    expect(msg100.is_from_me).toBe(false);
    expect(msg100.is_delivered).toBe(false);
    expect(msg100.delivered_at).toBeNull();
    expect(msg100.delivered_at_iso).toBeNull();
    expect(msg100.is_read).toBe(true);
    expect(typeof msg100.read_at_iso).toBe('string');
  });
});
