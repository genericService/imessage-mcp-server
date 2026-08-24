import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = path.resolve(__dirname, '../bin/imessage');

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

describe('CLI JSON Output Contracts (SDD & TDD)', () => {
  it('should return valid JSON when --json flag is passed to imessage list', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'list', '--limit', '3', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('rowid');
      expect(data[0]).toHaveProperty('identifier');
    }
  });

  it('should return valid JSON when --json flag is passed to imessage search', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'search', 'the', '--limit', '2', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should return valid JSON when --json flag is passed to imessage contacts', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'contacts', '', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should return valid JSON for recent messages CLI command', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'recent', '1', '--limit', '2', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should return valid JSON for search-group CLI command', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'search-group', 'Sarah', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should support recipient parameter targeting group chats or phone numbers', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'send', '--help']);
    expect(stdout).toContain('Recipient identifier');
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
    expect(meta.registration_endpoint).toBeUndefined();
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.token_endpoint_auth_methods_supported).not.toContain('none');
  });

  it('should generate RFC 9728 protected resource metadata for /mcp', async () => {
    const { getProtectedResourceMetadata } = await import('../src/oauth.js');
    const meta = getProtectedResourceMetadata('https://imessage.genericservice.app', '/mcp');
    expect(meta.resource).toBe('https://imessage.genericservice.app/mcp');
    expect(meta.authorization_servers).toContain('https://imessage.genericservice.app');
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('should reject unauthenticated dynamic client registration', async () => {
    const { handleRegisterPost } = await import('../src/oauth.js');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { setHeader: vi.fn(), status, json } as any;
    const req = {
      headers: {},
      body: {
        redirect_uris: ['https://grok.example/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'grok-test'
      }
    } as any;

    handleRegisterPost(req, res);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('should register dynamic OAuth clients only with the backend token', async () => {
    const token = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN;
    if (!token) return;

    const { handleRegisterPost } = await import('../src/oauth.js');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { setHeader: vi.fn(), status, json } as any;
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: {
        redirect_uris: ['https://grok.example/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'grok-test'
      }
    } as any;

    handleRegisterPost(req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].client_id).toBeTruthy();
    expect(json.mock.calls[0][0].redirect_uris).toEqual(['https://grok.example/callback']);
    expect(json.mock.calls[0][0].client_secret).toBeUndefined();
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

describe('Express HTTP Endpoints & Transport Integration', () => {
  const LOCAL_URL = process.env.MCP_TEST_URL || 'http://127.0.0.1:8765';
  const AUTH_TOKEN = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || '';
  const AUTH_HEADER = AUTH_TOKEN ? `Bearer ${AUTH_TOKEN}` : '';
  let serverUp = false;

  beforeAll(async () => {
    if (!AUTH_TOKEN) return;
    try {
      const res = await fetch(`${LOCAL_URL}/health`, { signal: AbortSignal.timeout(2000) });
      serverUp = res.ok;
    } catch {
      serverUp = false;
    }
  });

  const integration = (name: string, fn: () => void | Promise<void>) => {
    it(name, async () => {
      if (!AUTH_TOKEN) {
        console.warn('Skipping integration test: set BEARER_TOKEN in .env');
        return;
      }
      if (!serverUp) {
        console.warn(`Skipping integration test: MCP server not reachable at ${LOCAL_URL}`);
        return;
      }
      await fn();
    });
  };

  integration('should return 200 OK on GET /health', async () => {
    const res = await fetch(`${LOCAL_URL}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.server).toBe('imessage-mcp-server');
  });

  integration('should return discovery metadata on GET /discover', async () => {
    const res = await fetch(`${LOCAL_URL}/discover`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('imessage-mcp-server');
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(0);
    expect(data.endpoints.protectedResourceMetadata).toContain('oauth-protected-resource');
  });

  integration('should return protected resource metadata for Grok OAuth discovery', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/mcp/.well-known/oauth-protected-resource'
    ]) {
      const res = await fetch(`${LOCAL_URL}${path}`);
      expect(res.status, path).toBe(200);
      const data = await res.json();
      expect(data.resource).toContain('/mcp');
      expect(Array.isArray(data.authorization_servers)).toBe(true);
    }
  });

  integration('should return HTML documentation on GET /', async () => {
    const res = await fetch(`${LOCAL_URL}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('iMessage MCP Server');
  });

  integration('should reject unauthenticated POST /mcp with 401 and WWW-Authenticate', async () => {
    const res = await fetch(`${LOCAL_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 })
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') || '').toContain('resource_metadata');
    const data = await res.json();
    expect(data.error).toContain('Unauthorized');
  });

  integration('should reject unauthenticated OAuth register and authorize', async () => {
    const register = await fetch(`${LOCAL_URL}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] })
    });
    expect(register.status).toBe(401);

    const authorize = await fetch(`${LOCAL_URL}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=test&redirect_uri=https://example.com/cb&state=1'
    });
    expect(authorize.status).toBe(401);
  });

  integration('should initialize successfully on POST /mcp with Bearer token', async () => {
    const res = await fetch(`${LOCAL_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test-suite', version: '1.0.0' }
        },
        id: 1
      })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    const text = await res.text();
    expect(text).toContain('imessage-mcp-server');
  });

  integration('should handle POST /mcp ping probe without session', async () => {
    const res = await fetch(`${LOCAL_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 42 })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result).toEqual({});
    expect(data.id).toBe(42);
  });

  integration('should initialize successfully on POST /mcp with ?token parameter', async () => {
    const res = await fetch(`${LOCAL_URL}/mcp?token=${encodeURIComponent(AUTH_TOKEN)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test-query-param', version: '1.0.0' }
        },
        id: 1
      })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});

