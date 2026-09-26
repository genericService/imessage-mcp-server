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
const CHAT_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');
const CALL_BUILDER = path.resolve(__dirname, 'fixtures/build_call_history_db.py');

const FIXTURE_CHAT_DB = path.join(os.tmpdir(), `imessage-call-test-chat-${process.pid}.db`);
const FIXTURE_CALL_DB = path.join(os.tmpdir(), `imessage-call-test-call-${process.pid}.storedata`);

const REAL_CALL_DB = path.expanduser
  ? path.expanduser('~/Library/Application Support/CallHistoryDB/CallHistory.storedata')
  : path.join(process.env.HOME || '/Users/matthias', 'Library/Application Support/CallHistoryDB/CallHistory.storedata');
const HAS_REAL_CALL_DB = fs.existsSync(REAL_CALL_DB);
const realDbIt = HAS_REAL_CALL_DB ? it : it.skip;

process.env.NODE_ENV = 'test';
process.env.IMESSAGE_DB_PATH = FIXTURE_CHAT_DB;
process.env.CALL_HISTORY_DB_PATH = FIXTURE_CALL_DB;
process.env.IMESSAGE_SSH_FDA = 'false';
process.env.TZ = 'America/Los_Angeles';

const ENV = {
  ...process.env,
  IMESSAGE_DB_PATH: FIXTURE_CHAT_DB,
  CALL_HISTORY_DB_PATH: FIXTURE_CALL_DB,
  IMESSAGE_SSH_FDA: 'false',
  TZ: 'America/Los_Angeles',
  LC_ALL: 'C',
  LANG: 'C',
};

async function cli(args: string[], customEnv = ENV): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PYTHON, [CLI, ...args], { env: customEnv });
    return stdout;
  } catch (err: any) {
    const detail = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    throw new Error(detail);
  }
}

async function cliJson(args: string[], customEnv = ENV): Promise<any> {
  return JSON.parse(await cli(args, customEnv));
}

beforeAll(() => {
  fs.rmSync(FIXTURE_CHAT_DB, { force: true });
  fs.rmSync(FIXTURE_CALL_DB, { force: true });
  execFileSync(PYTHON, [CHAT_BUILDER, FIXTURE_CHAT_DB], { env: ENV });
  execFileSync(PYTHON, [CALL_BUILDER, FIXTURE_CALL_DB], { env: ENV });
});

afterAll(() => {
  fs.rmSync(FIXTURE_CHAT_DB, { force: true });
  fs.rmSync(FIXTURE_CALL_DB, { force: true });
});

describe('imessage_get_call_history (CLI & Core Functionality)', () => {
  it('returns all call records with standard contract fields', async () => {
    const calls = await cliJson(['calls', '--limit', '20', '--json']);
    expect(Array.isArray(calls)).toBe(true);
    expect(calls.length).toBe(7);

    const first = calls[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('handle');
    expect(first).toHaveProperty('contact_name');
    expect(first).toHaveProperty('direction');
    expect(first).toHaveProperty('answered');
    expect(first).toHaveProperty('missed');
    expect(first).toHaveProperty('duration_seconds');
    expect(first).toHaveProperty('call_type');
    expect(first).toHaveProperty('timestamp');
    expect(first).toHaveProperty('timestamp_iso');
  });

  it('correctly maps call types, directions, and missed status', async () => {
    const calls = await cliJson(['calls', '--limit', '20', '--json']);

    // CALL-0001: incoming answered phone call
    const c1 = calls.find((c: any) => c.id === 'CALL-0001');
    expect(c1).toBeDefined();
    expect(c1.call_type).toBe('phone');
    expect(c1.direction).toBe('incoming');
    expect(c1.answered).toBe(true);
    expect(c1.missed).toBe(false);
    expect(c1.duration_seconds).toBe(120.0);

    // CALL-0002: incoming missed phone call
    const c2 = calls.find((c: any) => c.id === 'CALL-0002');
    expect(c2).toBeDefined();
    expect(c2.call_type).toBe('phone');
    expect(c2.direction).toBe('incoming');
    expect(c2.answered).toBe(false);
    expect(c2.missed).toBe(true);
    expect(c2.duration_seconds).toBe(0.0);

    // CALL-0003: outgoing phone call
    const c3 = calls.find((c: any) => c.id === 'CALL-0003');
    expect(c3).toBeDefined();
    expect(c3.call_type).toBe('phone');
    expect(c3.direction).toBe('outgoing');
    expect(c3.answered).toBe(true);
    expect(c3.missed).toBe(false);

    // CALL-0004: incoming FaceTime video call
    const c4 = calls.find((c: any) => c.id === 'CALL-0004');
    expect(c4).toBeDefined();
    expect(c4.call_type).toBe('facetime_video');
    expect(c4.direction).toBe('incoming');
    expect(c4.answered).toBe(true);

    // CALL-0005: outgoing FaceTime audio call to email handle
    const c5 = calls.find((c: any) => c.id === 'CALL-0005');
    expect(c5).toBeDefined();
    expect(c5.call_type).toBe('facetime_audio');
    expect(c5.direction).toBe('outgoing');
    expect(c5.handle).toBe('paul@caladan.org');

    // CALL-0006: unknown call type code (99) passes through raw value
    const c6 = calls.find((c: any) => c.id === 'CALL-0006');
    expect(c6).toBeDefined();
    expect(c6.call_type).toBe(99);

    // CALL-0007: missed FaceTime video call
    const c7 = calls.find((c: any) => c.id === 'CALL-0007');
    expect(c7).toBeDefined();
    expect(c7.call_type).toBe('facetime_video');
    expect(c7.missed).toBe(true);
  });

  it('filters calls by phone number handle', async () => {
    const calls = await cliJson(['calls', '--handle', '+15550199480', '--json']);
    expect(calls.every((c: any) => c.handle === '+15550199480')).toBe(true);
    expect(calls.map((c: any) => c.id)).not.toContain('CALL-0005');
    expect(calls.map((c: any) => c.id)).not.toContain('CALL-0006');
  });

  it('filters calls by email handle', async () => {
    const calls = await cliJson(['calls', '--handle', 'paul@caladan.org', '--json']);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('CALL-0005');
    expect(calls[0].handle).toBe('paul@caladan.org');
  });

  it('filters calls by call_type', async () => {
    const phoneCalls = await cliJson(['calls', '--call-type', 'phone', '--json']);
    expect(phoneCalls.every((c: any) => c.call_type === 'phone')).toBe(true);
    expect(phoneCalls.length).toBe(3);

    const videoCalls = await cliJson(['calls', '--call-type', 'facetime_video', '--json']);
    expect(videoCalls.every((c: any) => c.call_type === 'facetime_video')).toBe(true);
    expect(videoCalls.length).toBe(2);

    const audioCalls = await cliJson(['calls', '--call-type', 'facetime_audio', '--json']);
    expect(audioCalls.every((c: any) => c.call_type === 'facetime_audio')).toBe(true);
    expect(audioCalls.length).toBe(1);
  });

  it('filters calls by chat ROWID participant resolution', async () => {
    // Chat 7 has participant Chani (+15550199480). Calls for Chani should be returned, but not Paul or Baron.
    const calls = await cliJson(['calls', '--chat', '7', '--json']);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c: any) => c.handle === '+15550199480')).toBe(true);
    expect(calls.map((c: any) => c.id)).not.toContain('CALL-0005');
    expect(calls.map((c: any) => c.id)).not.toContain('CALL-0006');
  });

  it('returns a non-fatal error object when CallHistory database is missing', async () => {
    const customEnv = { ...ENV, CALL_HISTORY_DB_PATH: '/nonexistent/path/CallHistory.storedata' };
    const res = await cliJson(['calls', '--json'], customEnv);
    expect(res.available).toBe(false);
    expect(res.calls).toEqual([]);
    expect(res.error).toContain('not found');
  });
});

describe('Timeline Merging via include_calls', () => {
  it('merges calls into recent messages timeline in chronological order', async () => {
    const items = await cliJson(['recent', '7', '--limit', '20', '--include-calls', '--json']);
    expect(Array.isArray(items)).toBe(true);

    const callItems = items.filter((it: any) => it.kind === 'call');
    const msgItems = items.filter((it: any) => it.kind === 'message');
    expect(callItems.length).toBeGreaterThan(0);
    expect(msgItems.length).toBeGreaterThan(0);

    // Call items must have text: null and required call fields
    for (const call of callItems) {
      expect(call.text).toBeNull();
      expect(call.call_type).toBeDefined();
      expect(call.direction).toBeDefined();
      expect(call.answered).toBeDefined();
      expect(call.missed).toBeDefined();
      expect(call.duration_seconds).toBeDefined();
    }

    // Verify chronological ordering by timestamp_iso
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1].timestamp_iso;
      const curr = items[i].timestamp_iso;
      expect(prev <= curr).toBe(true);
    }
  });

  it('does not alter next_since_msg_id when polling with include_calls and with_meta', async () => {
    const withoutCalls = await cliJson([
      'recent', '7', '--since-msg-id', '105', '--with-meta', '--json'
    ]);
    const withCalls = await cliJson([
      'recent', '7', '--since-msg-id', '105', '--include-calls', '--with-meta', '--json'
    ]);

    expect(withCalls.next_since_msg_id).toBe(withoutCalls.next_since_msg_id);
    expect(withCalls.next_since_msg_id).toBe(111);

    // withCalls contains call items, but filtered reaction counts and cursor remain identical
    const callItems = withCalls.messages.filter((m: any) => m.kind === 'call');
    expect(callItems.length).toBeGreaterThan(0);
    expect(withCalls.filtered).toEqual(withoutCalls.filtered);
  });

  it('merges calls into read_messages history', async () => {
    const items = await cliJson(['read', '7', '--days', '30', '--include-calls', '--json']);
    const callItems = items.filter((it: any) => it.kind === 'call');
    expect(callItems.length).toBeGreaterThan(0);
    expect(callItems.every((c: any) => c.text === null)).toBe(true);
  });
});

describe('MCP Server Integration (imessage_get_call_history & include_calls)', () => {
  it('exposes imessage_get_call_history in TOOLS and inputSchema', async () => {
    const { TOOLS } = await import('../src/index.js');
    const callTool = TOOLS.find((t) => t.name === 'imessage_get_call_history');
    expect(callTool).toBeDefined();
    const props = (callTool!.inputSchema as any).properties;
    expect(props.handle).toBeDefined();
    expect(props.chat).toBeDefined();
    expect(props.call_type).toBeDefined();
    expect(props.since).toBeDefined();
    expect(props.until).toBeDefined();

    const recentTool = TOOLS.find((t) => t.name === 'imessage_get_recent_messages');
    const recentProps = (recentTool!.inputSchema as any).properties;
    expect(recentProps.include_calls).toBeDefined();
    expect(recentProps.includeCalls).toBeDefined();
  });

  it('serves call history via /mcp JSON-RPC tool call', async () => {
    process.env.BEARER_TOKEN = 'call-test-token';
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
            name: 'imessage_get_call_history',
            arguments: { limit: 10, call_type: 'phone' },
          },
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice('data: '.length));
      const parsed = JSON.parse(payload.result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      expect(parsed.every((c: any) => c.call_type === 'phone')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves merged recent messages with include_calls via /mcp tool call', async () => {
    process.env.BEARER_TOKEN = 'call-test-token';
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
          id: 2,
          method: 'tools/call',
          params: {
            name: 'imessage_get_recent_messages',
            arguments: { chat_id: '7', limit: 20, include_calls: true },
          },
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice('data: '.length));
      const parsed = JSON.parse(payload.result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      const calls = parsed.filter((it: any) => it.kind === 'call');
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Live CallHistory database (when present on host Mac)', () => {
  realDbIt('reads real CallHistory.storedata without throwing', async () => {
    const realEnv = {
      ...process.env,
      CALL_HISTORY_DB_PATH: REAL_CALL_DB,
      LC_ALL: 'C',
      LANG: 'C',
    };
    const calls = await cliJson(['calls', '--limit', '5', '--json'], realEnv);
    expect(Array.isArray(calls)).toBe(true);
    if (calls.length > 0) {
      expect(calls[0]).toHaveProperty('id');
      expect(calls[0]).toHaveProperty('direction');
      expect(calls[0]).toHaveProperty('call_type');
    }
  });
});
