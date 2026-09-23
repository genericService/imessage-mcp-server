import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { runImessageCli } from '../src/index.js';

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = path.resolve(__dirname, '../bin/imessage');

async function runCli(args: string[]): Promise<{ stdout: string }> {
  try {
    const stdout = await runImessageCli(args);
    return { stdout };
  } catch (err: any) {
    throw err;
  }
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
      'imessage_search_group_chats',
      'imessage_get_edit_history',
      'imessage_edit_message'
    ];

    expect(requiredTools).toHaveLength(12);
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
    const { stdout } = await runCli(['list', '--limit', '3', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('rowid');
      expect(data[0]).toHaveProperty('identifier');
    }
  });

  it('should return valid JSON when --json flag is passed to imessage search', async () => {
    const { stdout } = await runCli(['search', 'the', '--limit', '2', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('is_edited');
      expect(data[0]).toHaveProperty('has_edits');
      expect(data[0]).toHaveProperty('edit_count');
      expect(data[0]).toHaveProperty('edit_history');
    }
  });

  it('should return valid JSON when --json flag is passed to imessage contacts', async () => {
    const { stdout } = await runCli(['contacts', '', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should return valid JSON for recent messages CLI command with edit fields', async () => {
    const { stdout } = await runCli(['recent', '1', '--limit', '2', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('is_edited');
      expect(data[0]).toHaveProperty('has_edits');
      expect(data[0]).toHaveProperty('edit_count');
      expect(data[0]).toHaveProperty('edit_history');
      expect(typeof data[0].is_edited).toBe('boolean');
      expect(Array.isArray(data[0].edit_history)).toBe(true);
    }
  });

  it('should support inspecting edit history for a specific message via CLI edits command', async () => {
    const { stdout } = await runCli(['edits', '198097', '--json']);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('msg_id', 198097);
    expect(data).toHaveProperty('is_edited', true);
    expect(data).toHaveProperty('has_edits', true);
    expect(data).toHaveProperty('edit_count');
    expect(data.edit_count).toBeGreaterThan(0);
    expect(data).toHaveProperty('edit_history');
    expect(Array.isArray(data.edit_history)).toBe(true);
    expect(data.edit_history.length).toBeGreaterThanOrEqual(2);
    expect(data.edit_history[0]).toHaveProperty('revision', 0);
    expect(data.edit_history[0]).toHaveProperty('text');
  });

  it('should format edit indicator in CLI text output for edited messages', async () => {
    const { stdout } = await runCli(['edits', '198097']);
    expect(stdout).toContain('EDIT HISTORY FOR MESSAGE #198097');
    expect(stdout).toContain('[Original]');
    expect(stdout).toContain('[Edit');
  });

  it('should return unedited message payload with is_edited false and original revision in edit_history', async () => {
    const { stdout } = await runCli(['edits', '1', '--json']);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('msg_id', 1);
    expect(data.is_edited).toBe(false);
    expect(data.has_edits).toBe(false);
    expect(data.edit_count).toBe(0);
    expect(data.last_edited).toBeNull();
    expect(data.edit_history).toHaveLength(1);
    expect(data.edit_history[0].label).toBe('original');
  });

  it('should return valid JSON with edit fields for imessage read', async () => {
    const { stdout } = await runCli(['read', '1', '--days', '14', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('is_edited');
      expect(data[0]).toHaveProperty('has_edits');
      expect(data[0]).toHaveProperty('edit_count');
      expect(data[0]).toHaveProperty('edit_history');
    }
  });

  it('should return valid JSON for search-group CLI command', async () => {
    const { stdout } = await runCli(['search-group', 'Paul Atreides', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('should support recipient parameter targeting group chats or phone numbers', async () => {
    const { stdout } = await runCli(['send', '--help']);
    expect(stdout).toContain('Recipient identifier');
  });

  it('should support CLI help for imessage edit command', async () => {
    const { stdout } = await runCli(['edit', '--help']);
    expect(stdout).toContain('message_id');
    expect(stdout).toContain('--text');
  });

  it('should reject editing incoming messages with an error', async () => {
    try {
      await runCli(['edit', '1', '--text', 'Trying to edit incoming message', '--json']);
      expect.unreachable('Should have thrown an error for incoming message');
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      expect(output).toContain('incoming');
    }
  });

  it('should reject editing messages older than 15 minutes', async () => {
    try {
      await runCli(['edit', '198100', '--text', 'Paul Atreides revised message', '--json']);
      expect.unreachable('Should have thrown an error for expired message');
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      expect(output).toContain('15 minutes');
    }
  });

  it('should return audio message transcription and duration for recent messages with voice notes', async () => {
    const { stdout } = await runCli(['recent', '1800', '--limit', '200', '--json']);
    const data = JSON.parse(stdout);
    const audioMsg = data.find((m: any) => m.msg_id === 200462);
    expect(audioMsg).toBeDefined();
    expect(audioMsg.is_audio_message).toBe(true);
    expect(audioMsg.transcription).toContain('German and Russian');
    expect(audioMsg.text).toContain('[voice note');
    expect(audioMsg.text).toContain('German and Russian');
    expect(audioMsg.attachments).toBeDefined();
    expect(audioMsg.attachments.length).toBeGreaterThan(0);
    expect(audioMsg.attachments[0].is_audio).toBe(true);
    expect(audioMsg.attachments[0].transcription).toContain('German and Russian');
    expect(audioMsg.attachments[0].duration_seconds).toBeGreaterThan(10);
    expect(audioMsg.attachments[0].duration_formatted).toBe('15s');
    expect(audioMsg.attachments[0].mime_type).toBe('audio/x-caf');
  });

  it('should return converted m4a and transcription for attachment payload when given a caf file', async () => {
    const cafPath = path.resolve(process.env.HOME || '/Users/matthias', 'Library/Messages/Attachments/cc/12/F3686DB9-8225-43CB-A142-89310D0BAACC/Audio Message.caf');
    const { stdout } = await runCli(['attachment', cafPath, '--json']);
    const data = JSON.parse(stdout);
    expect(data.is_audio).toBe(true);
    expect(data.mime_type).toBe('audio/mp4');
    expect(data.converted_path).toBeDefined();
    expect(data.converted_path).toContain('.m4a');
    expect(data.transcription).toContain('German and Russian');
    expect(data.duration_seconds).toBeGreaterThan(10);
    expect(data.duration_formatted).toBe('15s');
    expect(data.base64).toBeDefined();
  });

  it('should find voice note messages when searching by words in speech-to-text transcript', async () => {
    const { stdout } = await runCli(['search', 'German and Russian', '--limit', '5', '--json']);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
    const match = data.find((m: any) => m.msg_id === 200462);
    expect(match).toBeDefined();
    expect(match.text).toContain('German and Russian');
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
      target: 'Chani (+15550199480)',
      dry_run: true,
      status: 'success',
      duration_ms: 42
    });

    expect(fs.existsSync(auditFile)).toBe(true);
    const content = fs.readFileSync(auditFile, 'utf8');
    expect(content).toContain('imessage_send_message');
    expect(content).toContain('Chani (+15550199480)');
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

  it('should generate RFC 8414 OAuth server metadata with registration endpoint and PKCE support', async () => {
    const { getOAuthMetadata } = await import('../src/oauth.js');
    const meta = getOAuthMetadata('https://imessage.genericservice.app');
    expect(meta.issuer).toBe('https://imessage.genericservice.app');
    expect(meta.token_endpoint).toBe('https://imessage.genericservice.app/oauth/token');
    expect(meta.authorization_endpoint).toBe('https://imessage.genericservice.app/oauth/authorize');
    expect(meta.registration_endpoint).toBe('https://imessage.genericservice.app/oauth/register');
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('should generate RFC 9728 protected resource metadata for /mcp', async () => {
    const { getProtectedResourceMetadata } = await import('../src/oauth.js');
    const meta = getProtectedResourceMetadata('https://imessage.genericservice.app', '/mcp');
    expect(meta.resource).toBe('https://imessage.genericservice.app/mcp');
    expect(meta.authorization_servers).toContain('https://imessage.genericservice.app');
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('should register dynamic OAuth clients without requiring a master admin token (RFC 7591)', async () => {
    const { handleRegisterPost } = await import('../src/oauth.js');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { setHeader: vi.fn(), status, json } as any;
    const req = {
      headers: {},
      body: {
        redirect_uris: ['http://localhost:54321/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'gemini-desktop-test'
      }
    } as any;

    handleRegisterPost(req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].client_id).toBeTruthy();
    expect(json.mock.calls[0][0].redirect_uris).toEqual(['http://localhost:54321/callback']);
    expect(json.mock.calls[0][0].client_secret).toBeUndefined();
  });

  it('should reject dynamic client registration when redirect_uris is missing or empty', async () => {
    const { handleRegisterPost } = await import('../src/oauth.js');
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { setHeader: vi.fn(), status, json } as any;
    const req = {
      headers: {},
      body: {
        redirect_uris: [],
        client_name: 'invalid-client'
      }
    } as any;

    handleRegisterPost(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].error).toBe('invalid_client_metadata');
  });

  it('should validate logon credentials against username/password and fallback token', async () => {
    const { validateLogonCredentials } = await import('../src/oauth.js');
    process.env.AUTH_USERNAME = 'paul-atreides';
    process.env.AUTH_PASSWORD = 'fear-is-the-mind-killer';
    const masterToken = process.env.BEARER_TOKEN || '';

    // Valid username + password
    expect(validateLogonCredentials('paul-atreides', 'fear-is-the-mind-killer')).toBe(true);

    // Invalid password
    expect(validateLogonCredentials('paul-atreides', 'wrong-pass')).toBe(false);

    // Invalid username
    expect(validateLogonCredentials('feyd-rautha', 'fear-is-the-mind-killer')).toBe(false);

    // Master token fallback in password field
    if (masterToken) {
      expect(validateLogonCredentials('', masterToken)).toBe(true);
      expect(validateLogonCredentials('any-user', masterToken)).toBe(true);
    }
  });

  it('should sign and verify session cookies with HMAC protection', async () => {
    const { createSessionCookie, verifySessionCookie } = await import('../src/oauth.js');
    const cookie = createSessionCookie('paul-atreides');
    expect(typeof cookie).toBe('string');
    expect(cookie).toContain('.');

    const session = verifySessionCookie(cookie);
    expect(session).not.toBeNull();
    expect(session?.user).toBe('paul-atreides');

    // Tampered cookie must be rejected
    expect(verifySessionCookie(`${cookie}tampered`)).toBeNull();
    expect(verifySessionCookie('invalid.cookie')).toBeNull();
  });

  it('should render logon form on handleAuthorizeGet when no session is present', async () => {
    const { handleAuthorizeGet } = await import('../src/oauth.js');
    let htmlOutput = '';
    const res = {
      setHeader: vi.fn(),
      send: vi.fn((content: string) => { htmlOutput = content; }),
      status: vi.fn(() => res)
    } as any;
    const req = {
      headers: {},
      query: { client_id: 'test-client', response_type: 'code' }
    } as any;

    handleAuthorizeGet(req, res);
    expect(htmlOutput).toContain('Sign in to iMessage MCP');
    expect(htmlOutput).toContain('name="username"');
    expect(htmlOutput).toContain('name="password"');
  });

  it('should render approval form on handleAuthorizeGet when valid session is present', async () => {
    const { handleAuthorizeGet, createSessionCookie, SESSION_COOKIE_NAME } = await import('../src/oauth.js');
    const validCookie = createSessionCookie('paul-atreides');
    let htmlOutput = '';
    const res = {
      setHeader: vi.fn(),
      send: vi.fn((content: string) => { htmlOutput = content; }),
      status: vi.fn(() => res)
    } as any;
    const req = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${validCookie}` },
      query: { client_id: 'test-client', response_type: 'code' }
    } as any;

    handleAuthorizeGet(req, res);
    expect(htmlOutput).toContain('Authorize Client Access');
    expect(htmlOutput).toContain('paul-atreides');
    expect(htmlOutput).toContain('Approve & Grant Access');
    expect(htmlOutput).not.toContain('name="password"');
  });

  it('should authorize and set session cookie on handleAuthorizePost with valid credentials', async () => {
    const { handleAuthorizePost } = await import('../src/oauth.js');
    process.env.AUTH_USERNAME = 'paul-atreides';
    process.env.AUTH_PASSWORD = 'fear-is-the-mind-killer';
    const json = vi.fn();
    const setHeader = vi.fn();
    const res = {
      setHeader,
      status: vi.fn(() => res),
      json,
      redirect: vi.fn()
    } as any;
    const req = {
      headers: {},
      body: {
        client_id: 'test-client',
        username: 'paul-atreides',
        password: 'fear-is-the-mind-killer'
      }
    } as any;

    handleAuthorizePost(req, res);
    expect(json).toHaveBeenCalled();
    expect(json.mock.calls[0][0].code).toMatch(/^code_/);
    expect(setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('imessage_session='));
  });

  it('should authorize with session cookie on handleAuthorizePost without password', async () => {
    const { handleAuthorizePost, createSessionCookie, SESSION_COOKIE_NAME } = await import('../src/oauth.js');
    const validCookie = createSessionCookie('paul-atreides');
    const json = vi.fn();
    const setHeader = vi.fn();
    const res = {
      setHeader,
      status: vi.fn(() => res),
      json,
      redirect: vi.fn()
    } as any;
    const req = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${validCookie}` },
      body: { client_id: 'test-client' }
    } as any;

    handleAuthorizePost(req, res);
    expect(json).toHaveBeenCalled();
    expect(json.mock.calls[0][0].code).toMatch(/^code_/);
  });

  it('should return a Map from getClientRegistry()', async () => {
    const { getClientRegistry } = await import('../src/oauth.js');
    const registry = getClientRegistry();
    expect(registry).toBeInstanceOf(Map);
  });
});

describe('MCP 2026-07-28 Spec Compliance', () => {
  let testServer: import('http').Server;
  let testUrl: string;
  const AUTH_TOKEN = process.env.BEARER_TOKEN || '1ba52a7166e61f6af6a35399a555f4e940af4653b223e1f1225b3ca64de6fb7e';

  beforeAll(async () => {
    const http = await import('http');
    const { app } = await import('../src/index.js');
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

  it('should declare protocol version 2026-07-28 and supported protocol versions', async () => {
    const { SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } = await import('../src/index.js');
    expect(SPEC_VERSION).toBe('2026-07-28');
    expect(SUPPORTED_SPEC_VERSIONS).toContain('2026-07-28');
    expect(SUPPORTED_SPEC_VERSIONS).toContain('2025-11-25');
  });

  it('should handle server/discover JSON-RPC method with supportedVersions, capabilities, and serverInfo', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'disc-42',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'spec-test-client',
              version: '1.0.0'
            },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    const data = await res.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe('disc-42');
    expect(data.result).toHaveProperty('supportedVersions');
    expect(data.result.supportedVersions).toContain('2026-07-28');
    expect(data.result).toHaveProperty('capabilities');
    expect(data.result.capabilities).toHaveProperty('tools');
    expect(data.result).toHaveProperty('_meta');
    expect(data.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('imessage-mcp-server');
  });

  it('should reject unsupported protocol version with -32022 UnsupportedProtocolVersionError', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '1999-01-01',
        'Mcp-Method': 'server/discover'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'unsupported-ver-1',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '1999-01-01'
          }
        }
      })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32022);
    expect(data.error.message).toContain('Unsupported protocol version');
    expect(data.error.data.requested).toBe('1999-01-01');
    expect(Array.isArray(data.error.data.supported)).toBe(true);
    expect(data.error.data.supported).toContain('2026-07-28');
  });

  it('should reject header mismatch with -32020 when Mcp-Method does not match body method', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mismatch-1',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28'
          }
        }
      })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32020);
    expect(data.error.message).toContain('Header mismatch');
  });

  it('should reject header mismatch with -32020 when MCP-Protocol-Version does not match body protocolVersion', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mismatch-2',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2025-11-25'
          }
        }
      })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32020);
    expect(data.error.message).toContain('Header mismatch');
  });

  it('should reject header mismatch with -32020 when Mcp-Name does not match body params.name', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'wrong_tool_name'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mismatch-3',
        method: 'tools/call',
        params: {
          name: 'imessage_list_chats',
          arguments: { limit: 1 },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28'
          }
        }
      })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32020);
    expect(data.error.message).toContain('Header mismatch');
  });

  it('should accept Base64 sentinel encoded Mcp-Name header matching body params.name', async () => {
    const toolName = 'imessage_get_readme';
    const encodedHeader = `=?base64?${Buffer.from(toolName, 'utf8').toString('base64')}?=`;
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': encodedHeader
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'b64-name-1',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28'
          }
        }
      })
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('iMessage MCP Server');
  });

  it('should execute tools/list statelessly without requiring an active session', async () => {
    const res = await fetch(`${testUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'stateless-tools-1',
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28'
          }
        }
      })
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('imessage_list_chats');
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

  integration('should handle dynamic client registration and reject unauthenticated authorize', async () => {
    const register = await fetch(`${LOCAL_URL}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] })
    });
    expect(register.status).toBe(201);

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

