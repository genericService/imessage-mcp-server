import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  app,
  executeToolCall,
  cliRunner,
  SERVER_VERSION,
  readServerVersion,
  getHealthTelemetry,
  resolveHandleViaIdentityGraph
} from '../src/index.js';
import { IdentityGraph, identityGraph } from '../src/identity_graph.js';
import { WATCHER_USER_AGENT } from '../src/watcher.js';

describe('v1.15.0 Improvements: Dynamic Version, Dashboard Hygiene, Identity Graph & Telemetry (TDD)', () => {
  let testServer: http.Server;
  let testUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      testServer = http.createServer(app);
      testServer.listen(0, '127.0.0.1', () => {
        const addr = testServer.address() as import('net').AddressInfo;
        testUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      testServer.close(() => resolve());
    });
  });

  describe('1. Dynamic Version Sync from package.json', () => {
    it('exports SERVER_VERSION matching package.json and reads version dynamically via readServerVersion', () => {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      expect(SERVER_VERSION).toBe(pkg.version);
      expect(WATCHER_USER_AGENT).toBe(`imessage-mcp-server/${pkg.version}`);

      // Verify dynamic reader with a custom package.json fixture
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-ver-test-'));
      const customPkg = path.join(tmpDir, 'package.json');
      fs.writeFileSync(customPkg, JSON.stringify({ name: 'imessage-mcp-server', version: '9.99.0-arrakis' }));
      try {
        expect(readServerVersion(customPkg)).toBe('9.99.0-arrakis');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('reports dynamic package.json version across /health, /discover, and GET / HTML dashboard', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

      const healthRes = await fetch(`${testUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.version).toBe(pkg.version);

      const discRes = await fetch(`${testUrl}/discover`);
      expect(discRes.status).toBe(200);
      const discData = await discRes.json();
      expect(discData.version).toBe(pkg.version);

      const htmlRes = await fetch(`${testUrl}/`, { headers: { Accept: 'text/html' } });
      expect(htmlRes.status).toBe(200);
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain(`v${pkg.version}`);
    });
  });

  describe('2. Security & HTML Dashboard Hygiene', () => {
    it('renders client config snippet with "Bearer YOUR_AUTH_TOKEN" placeholder and never leaks actual AUTH_TOKEN', async () => {
      const res = await fetch(`${testUrl}/`, { headers: { Accept: 'text/html' } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Bearer YOUR_AUTH_TOKEN');
      const activeSecret = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN;
      if (activeSecret && activeSecret.length > 8) {
        expect(html).not.toContain(activeSecret);
      }
    });
  });

  describe('3. SQLite / Identity Graph / Contact Resolution Performance', () => {
    let tempDir: string;
    let dbPath: string;
    let graph: IdentityGraph;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-graph-perf-'));
      dbPath = path.join(tempDir, 'identity_graph.db');
      graph = new IdentityGraph(dbPath);
    });

    afterEach(() => {
      graph.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('configures WAL mode, busy_timeout, and composite indexes on identities table', () => {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const journalRow = checkDb.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
        expect(journalRow.journal_mode.toLowerCase()).toBe('wal');

        const indexRows = checkDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'identities'")
          .all() as Array<{ name: string }>;
        const indexNames = indexRows.map((r) => r.name);

        expect(indexNames).toContain('idx_identities_platform_val');
        expect(indexNames).toContain('idx_identities_contact_platform');
        expect(indexNames).toContain('idx_identities_type_val');
      } finally {
        checkDb.close();
      }
    });

    it('uses a 5-second TTL cache for resolveContact to prevent N+1 queries and invalidates on writes', () => {
      graph.linkContactIdentity('Paul Atreides', 'imessage', '+15550199808', 'phone');
      graph.linkContactIdentity('Chani', 'imessage', '+15550199480', 'phone');

      // Clear stats before testing cache hits
      graph.clearCache();
      expect(graph.getCacheStats().hits).toBe(0);
      expect(graph.getCacheStats().misses).toBe(0);

      // First lookup is a cache miss
      const first = graph.resolveContact('Paul Atreides');
      expect(first?.displayName).toBe('Paul Atreides');
      expect(graph.getCacheStats().misses).toBe(1);
      expect(graph.getCacheStats().hits).toBe(0);

      // Subsequent lookups within TTL window are cache hits
      const second = graph.resolveContact('Paul Atreides');
      const third = graph.resolveContact('paul atreides');
      expect(second?.displayName).toBe('Paul Atreides');
      expect(third?.displayName).toBe('Paul Atreides');
      expect(graph.getCacheStats().hits).toBe(2);
      expect(graph.getCacheStats().misses).toBe(1);

      // Linking a new identity invalidates the cache immediately
      graph.linkContactIdentity('Paul Atreides', 'whatsapp', '15550199808@s.whatsapp.net', 'jid');
      expect(graph.getCacheStats().size).toBe(0);

      const updated = graph.resolveContact('Paul Atreides');
      expect(updated?.identities.length).toBe(2);
    });
  });

  describe('4. Ergonomics & Health Telemetry', () => {
    it('includes ftsIndexReady, identityGraphExists, and chatDbAccessible booleans on GET /health with HTTP 200 status ok', async () => {
      const res = await fetch(`${testUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(typeof data.ftsIndexReady).toBe('boolean');
      expect(typeof data.identityGraphExists).toBe('boolean');
      expect(typeof data.chatDbAccessible).toBe('boolean');

      const directTelemetry = getHealthTelemetry();
      expect(typeof directTelemetry.ftsIndexReady).toBe('boolean');
      expect(typeof directTelemetry.identityGraphExists).toBe('boolean');
      expect(typeof directTelemetry.chatDbAccessible).toBe('boolean');
    });

    it('resolves contact display names via Identity Graph in imessage_send_message and send_message', async () => {
      identityGraph.linkContactIdentity('Stilgar Sietch Tabr', 'imessage', '+15550199485', 'phone');

      // 1. Test dry_run preview resolves display name to phone handle
      const previewRes = await executeToolCall('imessage_send_message', {
        recipient: 'Stilgar Sietch Tabr',
        message: 'Wormsign reported in the deep desert',
        dry_run: true
      });
      expect(previewRes.isError).toBeFalsy();
      const previewData = JSON.parse(previewRes.content[0].type === 'text' ? previewRes.content[0].text : '{}');
      expect(previewData.target_recipient).toBe('+15550199485');

      // 2. Test live send_message alias resolves display name to phone handle
      const cliSpy = vi.spyOn(cliRunner, 'run').mockResolvedValueOnce('Message sent successfully!');
      try {
        const sendRes = await executeToolCall('send_message', {
          recipient: 'Stilgar Sietch Tabr',
          message: 'Gather the Fremen at Caladan Ridge',
          dry_run: false
        });
        expect(sendRes.isError).toBeFalsy();
        expect(cliSpy).toHaveBeenCalledWith([
          'send',
          '+15550199485',
          '-m',
          'Gather the Fremen at Caladan Ridge'
        ]);
      } finally {
        cliSpy.mockRestore();
      }
    });

    it('resolves contact display names via Identity Graph in get_recent_messages and get_last_interaction', async () => {
      identityGraph.linkContactIdentity('Duke Leto Atreides', 'imessage', '+15550199777', 'phone');

      const mockMessages = JSON.stringify([
        {
          msg_id: 501,
          sender: 'Duke Leto Atreides',
          handle: '+15550199777',
          text: 'Desert power is the key to Arrakis',
          timestamp: '2026-10-13 05:00 PM',
          timestamp_iso: '2026-10-13T17:00:00-07:00'
        }
      ]);

      const cliSpy = vi.spyOn(cliRunner, 'run').mockResolvedValue(mockMessages);
      try {
        // 1. get_recent_messages with chat display name
        const recentRes = await executeToolCall('get_recent_messages', {
          chat: 'Duke Leto Atreides',
          limit: 5
        });
        expect(recentRes.isError).toBeFalsy();
        expect(cliSpy).toHaveBeenCalledWith(['recent', '+15550199777', '--limit', '5', '--json']);

        // 2. get_last_interaction with contact display name
        const lastRes = await executeToolCall('get_last_interaction', {
          contact: 'Duke Leto Atreides'
        });
        expect(lastRes.isError).toBeFalsy();
        const lastData = JSON.parse(lastRes.content[0].type === 'text' ? lastRes.content[0].text : '{}');
        expect(lastData.success).toBe(true);
        expect(lastData.chat_id).toBe('+15550199777');
        expect(lastData.last_message?.text).toBe('Desert power is the key to Arrakis');
      } finally {
        cliSpy.mockRestore();
      }
    });

    it('preserves raw phone numbers, emails, chat ROWIDs, and parenthesized handles in resolveHandleViaIdentityGraph', () => {
      identityGraph.linkContactIdentity('Lady Jessica Atreides', 'imessage', '+15550199481', 'phone');
      expect(resolveHandleViaIdentityGraph('Lady Jessica Atreides')).toBe('+15550199481');
      expect(resolveHandleViaIdentityGraph('46')).toBe('46');
      expect(resolveHandleViaIdentityGraph('+15550199999')).toBe('+15550199999');
      expect(resolveHandleViaIdentityGraph('paul@caladan.org')).toBe('paul@caladan.org');
      expect(resolveHandleViaIdentityGraph('Lady Jessica Atreides (+15550199481)')).toBe('Lady Jessica Atreides (+15550199481)');
    });
  });
});
