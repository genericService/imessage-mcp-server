import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import {
  WatcherService,
  WatcherConfig,
  computeHmacSignature,
  ruleMatchesEvent,
  deliverWebhook,
  parseWatcherConfig,
} from '../src/watcher.js';

const PYTHON = '/usr/bin/python3';
const FIXTURE_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');

interface CapturedWebhook {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  payload: any;
}

let webhookServer: http.Server;
let webhookPort: number;
let receivedWebhooks: CapturedWebhook[] = [];

function startWebhookServer(): Promise<number> {
  return new Promise((resolve) => {
    receivedWebhooks = [];
    webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let payload: any = null;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          payload = rawBody;
        }
        receivedWebhooks.push({
          path: req.url || '/',
          method: req.method || 'POST',
          headers: req.headers,
          rawBody,
          payload,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });

    webhookServer.listen(0, '127.0.0.1', () => {
      const addr = webhookServer.address() as import('net').AddressInfo;
      webhookPort = addr.port;
      resolve(addr.port);
    });
  });
}

function stopWebhookServer(): Promise<void> {
  return new Promise((resolve) => {
    if (webhookServer) {
      webhookServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

function waitForWebhooks(count: number, timeoutMs = 4000): Promise<CapturedWebhook[]> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (receivedWebhooks.length >= count) {
        resolve([...receivedWebhooks]);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        resolve([...receivedWebhooks]);
        return;
      }
      setTimeout(check, 30);
    };
    check();
  });
}

function insertDbMessage(
  dbPath: string,
  params: {
    rowid: number;
    chat_id: number;
    handle_id: number;
    is_from_me: number;
    text: string;
    assoc_type?: number;
    assoc_guid?: string;
    is_delivered?: number;
    date_delivered?: number;
    is_read?: number;
    date_read?: number;
  }
): void {
  const script = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("""
INSERT INTO message (
    ROWID, guid, text, handle_id, date, is_from_me,
    associated_message_type, associated_message_guid,
    is_delivered, date_delivered, is_read, date_read
) VALUES (?, ?, ?, ?, 800000000000000000, ?, ?, ?, ?, ?, ?, ?)
""", (
    ${params.rowid},
    'MSG-GUID-${params.rowid}',
    '${params.text.replace(/'/g, "\\'")}',
    ${params.handle_id},
    ${params.is_from_me},
    ${params.assoc_type || 0},
    ${params.assoc_guid ? `'${params.assoc_guid}'` : 'None'},
    ${params.is_delivered || 0},
    ${params.date_delivered || 0},
    ${params.is_read || 0},
    ${params.date_read || 0},
))
c.execute("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, 800000000000000000)", (${params.chat_id}, ${params.rowid}))
conn.commit()
conn.close()
`;
  execFileSync(PYTHON, ['-c', script, dbPath]);
}

function updateDbReceipt(
  dbPath: string,
  rowid: number,
  updates: {
    is_delivered?: number;
    date_delivered?: number;
    is_read?: number;
    date_read?: number;
  }
): void {
  const sets: string[] = [];
  if (updates.is_delivered !== undefined) sets.push(`is_delivered = ${updates.is_delivered}`);
  if (updates.date_delivered !== undefined) sets.push(`date_delivered = ${updates.date_delivered}`);
  if (updates.is_read !== undefined) sets.push(`is_read = ${updates.is_read}`);
  if (updates.date_read !== undefined) sets.push(`date_read = ${updates.date_read}`);

  const script = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("UPDATE message SET ${sets.join(', ')} WHERE ROWID = ${rowid}")
conn.commit()
conn.close()
`;
  execFileSync(PYTHON, ['-c', script, dbPath]);
}

describe('iMessage Watcher & Webhook Notification System', () => {
  let testDbPath: string;
  let testStatePath: string;

  beforeAll(async () => {
    await startWebhookServer();
  });

  afterAll(async () => {
    await stopWebhookServer();
  });

  beforeEach(() => {
    receivedWebhooks = [];
    testDbPath = path.join(os.tmpdir(), `watch-test-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    testStatePath = path.join(os.tmpdir(), `watch-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    execFileSync(PYTHON, [FIXTURE_BUILDER, testDbPath]);
    process.env.IMESSAGE_DB_PATH = testDbPath;
    process.env.IMESSAGE_SSH_FDA = 'false';
  });

  afterEach(() => {
    fs.rmSync(testDbPath, { force: true });
    fs.rmSync(testStatePath, { force: true });
  });

  it('debounces multiple inserts in a rapid burst into a single aggregated webhook POST', async () => {
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          debounce_ms: 250,
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    // Insert 3 new incoming messages for chat 7 in rapid succession
    insertDbMessage(testDbPath, { rowid: 301, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Arrakis report 1' });
    insertDbMessage(testDbPath, { rowid: 302, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Arrakis report 2' });
    insertDbMessage(testDbPath, { rowid: 303, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Arrakis report 3' });

    await watcher.checkChanges();

    // Wait for the 250ms debounce window to fire
    const webhooks = await waitForWebhooks(1, 2000);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    const post = webhooks[0];
    expect(post.method).toBe('POST');
    expect(post.payload.event).toBe('message_in');
    expect(post.payload.chat_id).toBe(7);
    expect(post.payload.count).toBe(3);
    expect(post.payload.newest_msg_id).toBe(303);
    expect(post.payload.since_msg_id_hint).toBe(300);
    expect(typeof post.payload.occurred_at_iso).toBe('string');
  });

  it('filters by chat and does not trigger for unconfigured chats', async () => {
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7], // Only Chat 7 (Chani), NOT Chat 8 (Paul)
          debounce_ms: 100,
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    // Insert message for chat 7 and an unrelated message for chat 8
    insertDbMessage(testDbPath, { rowid: 310, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Message for Chani' });
    insertDbMessage(testDbPath, { rowid: 311, chat_id: 8, handle_id: 2, is_from_me: 0, text: 'Message for Paul' });

    await watcher.checkChanges();

    const webhooks = await waitForWebhooks(1, 1500);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    expect(webhooks[0].payload.chat_id).toBe(7);
    expect(webhooks[0].payload.newest_msg_id).toBe(310);
  });

  it('contains NO message text, sender names, or contact handles in webhook payload', async () => {
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          debounce_ms: 100,
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    insertDbMessage(testDbPath, {
      rowid: 320,
      chat_id: 7,
      handle_id: 1,
      is_from_me: 0,
      text: 'Top Secret Spice Guild Coordinates',
    });

    await watcher.checkChanges();
    const webhooks = await waitForWebhooks(1, 1500);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    const payload = webhooks[0].payload;

    // Check payload fields strictly
    expect(Object.keys(payload).sort()).toEqual([
      'chat_id',
      'count',
      'event',
      'newest_msg_id',
      'occurred_at_iso',
      'since_msg_id_hint',
    ]);

    expect((payload as any).text).toBeUndefined();
    expect((payload as any).sender).toBeUndefined();
    expect((payload as any).handle).toBeUndefined();
    expect((payload as any).participant).toBeUndefined();
    expect((payload as any).display_name).toBeUndefined();
    expect((payload as any).name).toBeUndefined();
    expect((payload as any).guid).toBeUndefined();
  });

  it('includes an HMAC-SHA256 signature header when secret is configured', async () => {
    const secret = 'arrakis-secret-key-42';
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          debounce_ms: 100,
          secret,
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    insertDbMessage(testDbPath, { rowid: 330, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Signed message' });
    await watcher.checkChanges();

    const webhooks = await waitForWebhooks(1, 1500);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    const signatureHeader = webhooks[0].headers['x-signature-sha256'];
    expect(signatureHeader).toBeDefined();

    const expectedHash = computeHmacSignature(webhooks[0].rawBody, secret);
    expect(signatureHeader).toBe(`sha256=${expectedHash}`);
  });

  it('persists state across restarts and avoids replaying previously seen messages', async () => {
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          debounce_ms: 100,
        },
      ],
    };

    // First run
    const watcher1 = new WatcherService(config);
    await watcher1.start();

    insertDbMessage(testDbPath, { rowid: 340, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'First run message' });
    await watcher1.checkChanges();
    await waitForWebhooks(1, 1500);
    await watcher1.stop();

    // Verify state file persisted
    expect(fs.existsSync(testStatePath)).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(testStatePath, 'utf8'));
    expect(savedState.last_seen_msg_id).toBe(340);

    // Clear received webhooks
    receivedWebhooks = [];

    // Simulate insert while server is offline
    insertDbMessage(testDbPath, { rowid: 341, chat_id: 7, handle_id: 1, is_from_me: 0, text: 'Offline message' });

    // Restart watcher with the same state file
    const watcher2 = new WatcherService(config);
    await watcher2.start();

    const webhooks = await waitForWebhooks(1, 1500);
    await watcher2.stop();

    expect(webhooks.length).toBe(1);
    expect(webhooks[0].payload.newest_msg_id).toBe(341);
    expect(webhooks[0].payload.count).toBe(1);
    // Verified: it did NOT replay message 340
    expect(webhooks[0].payload.since_msg_id_hint).toBe(340);
  });

  it('detects delivered and read_receipt transitions on outgoing messages', async () => {
    // Insert an initial outgoing unread message
    insertDbMessage(testDbPath, {
      rowid: 350,
      chat_id: 7,
      handle_id: 1,
      is_from_me: 1,
      text: 'Outgoing message awaiting receipt',
      is_delivered: 0,
      date_delivered: 0,
      is_read: 0,
      date_read: 0,
    });

    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          events: ['delivered', 'read_receipt'],
          debounce_ms: 100,
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    // Baseline check recorded message 350 as undelivered / unread
    receivedWebhooks = [];

    // Simulate Apple APNs delivered receipt update
    updateDbReceipt(testDbPath, 350, { is_delivered: 1, date_delivered: 800000001000000000 });
    await watcher.checkChanges();

    let webhooks = await waitForWebhooks(1, 1500);
    expect(webhooks.length).toBe(1);
    expect(webhooks[0].payload.event).toBe('delivered');
    expect(webhooks[0].payload.chat_id).toBe(7);
    expect(webhooks[0].payload.newest_msg_id).toBe(350);

    receivedWebhooks = [];

    // Simulate recipient read receipt update
    updateDbReceipt(testDbPath, 350, { is_read: 1, date_read: 800000005000000000 });
    await watcher.checkChanges();

    webhooks = await waitForWebhooks(1, 1500);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    expect(webhooks[0].payload.event).toBe('read_receipt');
    expect(webhooks[0].payload.chat_id).toBe(7);
    expect(webhooks[0].payload.newest_msg_id).toBe(350);
  });

  it('filters out outgoing messages by default unless message_out is explicitly listed', async () => {
    const config: WatcherConfig = {
      enabled: true,
      poll_interval_ms: 10000,
      state_file: testStatePath,
      rules: [
        {
          webhook_url: `http://127.0.0.1:${webhookPort}/webhook`,
          chats: [7],
          debounce_ms: 100,
          // default events: ['message_in', 'reaction']
        },
      ],
    };

    const watcher = new WatcherService(config);
    await watcher.start();

    // Outgoing message should NOT trigger
    insertDbMessage(testDbPath, { rowid: 360, chat_id: 7, handle_id: 1, is_from_me: 1, text: 'Outgoing text' });
    await watcher.checkChanges();

    let webhooks = await waitForWebhooks(1, 400);
    expect(webhooks.length).toBe(0);

    // Incoming reaction SHOULD trigger
    insertDbMessage(testDbPath, {
      rowid: 361,
      chat_id: 7,
      handle_id: 1,
      is_from_me: 0,
      text: 'Loved',
      assoc_type: 2000,
      assoc_guid: 'p:0/MSG-GUID-360',
    });
    await watcher.checkChanges();

    webhooks = await waitForWebhooks(1, 1500);
    await watcher.stop();

    expect(webhooks.length).toBe(1);
    expect(webhooks[0].payload.event).toBe('reaction');
    expect(webhooks[0].payload.newest_msg_id).toBe(361);
  });

  it('enforces that chats is required and rules without chats are rejected', () => {
    process.env.WATCH_ENABLED = 'true';
    process.env.WATCH_RULES = JSON.stringify([
      { webhook_url: 'http://example.com/missing-chats' },
      { webhook_url: 'http://example.com/empty-chats', chats: [] },
      { webhook_url: 'http://example.com/valid', chats: [7] },
    ]);

    const parsed = parseWatcherConfig();
    expect(parsed).toBeDefined();
    expect(parsed!.rules.length).toBe(1);
    expect(parsed!.rules[0].webhook_url).toBe('http://example.com/valid');

    delete process.env.WATCH_RULES;
    delete process.env.WATCH_ENABLED;
  });
});
