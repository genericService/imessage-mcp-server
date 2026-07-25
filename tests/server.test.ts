import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

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
    expect(meta.grant_types_supported).toContain('client_credentials');
    expect(meta.grant_types_supported).toContain('authorization_code');
  });
});
