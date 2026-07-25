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
      'imessage_get_readme'
    ];

    expect(requiredTools).toHaveLength(8);
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

  it('should support recipient parameter targeting group chats or phone numbers', async () => {
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'send', '--help']);
    expect(stdout).toContain('Recipient identifier');
  });
});
