import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IdentityGraph } from '../src/identity_graph.js';

describe('IdentityGraph (TypeScript / Node 24 SQLite)', () => {
  let tempDir: string;
  let dbPath: string;
  let graph: IdentityGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-graph-test-'));
    dbPath = path.join(tempDir, 'identity_graph.db');
    graph = new IdentityGraph(dbPath);
  });

  afterEach(() => {
    graph.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes schema and tables', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    const resolved = graph.resolveContact('Paul Atreides');
    expect(resolved).toBeNull();
  });

  it('links and resolves a contact across platforms', () => {
    graph.linkContactIdentity('Paul Atreides', 'imessage', '+15551234567', 'phone');
    graph.linkContactIdentity('Paul Atreides', 'instagram', 'muaddib', 'username');

    const contact = graph.resolveContact('Paul Atreides');
    expect(contact).not.toBeNull();
    expect(contact?.displayName).toBe('Paul Atreides');
    expect(contact?.identities).toHaveLength(2);

    const imessageId = contact?.identities.find(i => i.platform === 'imessage');
    expect(imessageId?.identifierValue).toBe('+15551234567');

    const igId = contact?.identities.find(i => i.platform === 'instagram');
    expect(igId?.identifierValue).toBe('muaddib');

    // Also resolve by phone number directly
    const byPhone = graph.resolveContact('+15551234567');
    expect(byPhone?.displayName).toBe('Paul Atreides');
  });

  it('seeds contacts from iMessage array', () => {
    graph.seedContacts([
      { name: 'Chani', phone: '+15559876543' },
      { name: 'Duncan Idaho', email: 'duncan@caladan.gov' },
    ]);

    const chani = graph.resolveContact('Chani');
    expect(chani).not.toBeNull();
    expect(chani?.identities[0].identifierValue).toBe('+15559876543');

    const duncan = graph.resolveContact('duncan@caladan.gov');
    expect(duncan).not.toBeNull();
    expect(duncan?.displayName).toBe('Duncan Idaho');
  });
});
