import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TOOLS, executeToolCall } from '../src/index.js';
import { identityGraph } from '../src/identity_graph.js';

describe('iMessage Parity & Identity Graph Tools', () => {
  it('registers all universal aliases and identity tools in TOOLS', () => {
    const toolNames = TOOLS.map(t => t.name);

    // Universal aliases
    expect(toolNames).toContain('list_chats');
    expect(toolNames).toContain('list_messages');
    expect(toolNames).toContain('send_message');
    expect(toolNames).toContain('get_recent_messages');
    expect(toolNames).toContain('search_messages');
    expect(toolNames).toContain('search_contacts');

    // Identity Graph tools
    expect(toolNames).toContain('resolve_contact');
    expect(toolNames).toContain('link_contact_identity');

    // Context and interaction parity tools
    expect(toolNames).toContain('get_last_interaction');
    expect(toolNames).toContain('get_message_context');
  });

  it('resolves contact and links identities via MCP tools', async () => {
    // Link contact
    const linkRes = await executeToolCall('link_contact_identity', {
      name: 'Gurney Halleck',
      platform: 'imessage',
      identifier: '+15554443322',
      identifier_type: 'phone'
    });

    expect(linkRes.content).toBeDefined();
    const linked = JSON.parse(linkRes.content[0].text);
    expect(linked.displayName).toBe('Gurney Halleck');

    // Resolve contact
    const resolveRes = await executeToolCall('resolve_contact', {
      query: 'Gurney Halleck'
    });

    const resolved = JSON.parse(resolveRes.content[0].text);
    expect(resolved.displayName).toBe('Gurney Halleck');
    expect(resolved.identities.some((i: any) => i.identifierValue === '+15554443322')).toBe(true);
  });
});
