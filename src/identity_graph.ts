/**
 * Unified Contact Identity Graph for comms MCP servers (Node 24 node:sqlite).
 * Connects to ~/.local/share/comms/identity_graph.db
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface IdentityRecord {
  id?: number;
  contactId?: string;
  platform: string;
  identifierType: string;
  identifierValue: string;
  isPrimary?: boolean;
}

export interface ContactRecord {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  notes?: string | null;
  identities: IdentityRecord[];
}

export class IdentityGraph {
  public dbPath: string;
  private db: DatabaseSync;

  constructor(customPath?: string) {
    this.dbPath =
      customPath ||
      path.join(os.homedir(), '.local', 'share', 'comms', 'identity_graph.db');

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        nickname TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        identifier_value TEXT NOT NULL,
        is_primary INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
        UNIQUE(platform, identifier_type, identifier_value)
      );

      CREATE INDEX IF NOT EXISTS idx_identities_val ON identities (identifier_value);
      CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities (contact_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts (display_name);
    `);
  }

  public resolveContact(nameOrQuery: string): ContactRecord | null {
    if (!nameOrQuery || !nameOrQuery.trim()) return null;
    const q = nameOrQuery.trim();

    // 1. Direct match by identifier_value (phone, email, username, jid)
    const idRow = this.db
      .prepare('SELECT contact_id FROM identities WHERE identifier_value = ? LIMIT 1')
      .get(q) as { contact_id: string } | undefined;

    let contactId = idRow?.contact_id;

    // 2. Direct match by contact display_name
    if (!contactId) {
      const contactRow = this.db
        .prepare('SELECT id FROM contacts WHERE LOWER(display_name) = LOWER(?) LIMIT 1')
        .get(q) as { id: string } | undefined;
      contactId = contactRow?.id;
    }

    // 3. Substring match by contact display_name or nickname
    if (!contactId) {
      const partialRow = this.db
        .prepare(
          'SELECT id FROM contacts WHERE display_name LIKE ? OR nickname LIKE ? ORDER BY LENGTH(display_name) ASC LIMIT 1'
        )
        .get(`%${q}%`, `%${q}%`) as { id: string } | undefined;
      contactId = partialRow?.id;
    }

    // 4. Normalized phone number match
    if (!contactId && /^[0-9+()\- ]{7,}$/.test(q)) {
      const cleaned = q.replace(/[^0-9]/g, '');
      const phoneRow = this.db
        .prepare(
          "SELECT contact_id FROM identities WHERE identifier_type = 'phone' AND REPLACE(REPLACE(REPLACE(identifier_value, '+', ''), '-', ''), ' ', '') LIKE ? LIMIT 1"
        )
        .get(`%${cleaned}%`) as { contact_id: string } | undefined;
      contactId = phoneRow?.contact_id;
    }

    if (!contactId) return null;

    const contact = this.db
      .prepare('SELECT * FROM contacts WHERE id = ?')
      .get(contactId) as Record<string, unknown> | undefined;

    if (!contact) return null;

    const identities = (this.db
      .prepare('SELECT * FROM identities WHERE contact_id = ?')
      .all(contactId) as Record<string, unknown>[]).map(row => ({
      id: row.id as number,
      contactId: row.contact_id as string,
      platform: row.platform as string,
      identifierType: row.identifier_type as string,
      identifierValue: row.identifier_value as string,
      isPrimary: Boolean(row.is_primary),
    }));

    return {
      id: contact.id as string,
      displayName: contact.display_name as string,
      firstName: (contact.first_name as string) || null,
      lastName: (contact.last_name as string) || null,
      nickname: (contact.nickname as string) || null,
      notes: (contact.notes as string) || null,
      identities,
    };
  }

  public linkContactIdentity(
    name: string,
    platform: string,
    identifier: string,
    identifierType?: string
  ): ContactRecord {
    const trimmedName = name.trim();
    const trimmedIdent = identifier.trim();
    const plat = platform.toLowerCase().trim();

    let idType = identifierType;
    if (!idType) {
      if (trimmedIdent.includes('@') && !trimmedIdent.endsWith('@s.whatsapp.net') && !trimmedIdent.endsWith('@lid')) {
        idType = 'email';
      } else if (trimmedIdent.startsWith('+') || /^\d{10,}$/.test(trimmedIdent)) {
        idType = 'phone';
      } else if (trimmedIdent.endsWith('@s.whatsapp.net')) {
        idType = 'jid';
      } else if (trimmedIdent.endsWith('@lid')) {
        idType = 'lid';
      } else {
        idType = 'username';
      }
    }

    const nowIso = new Date().toISOString();

    // Check if contact already exists
    let existingContact = this.db
      .prepare('SELECT * FROM contacts WHERE LOWER(display_name) = LOWER(?) LIMIT 1')
      .get(trimmedName) as { id: string } | undefined;

    let contactId: string;
    if (existingContact) {
      contactId = existingContact.id;
      this.db
        .prepare('UPDATE contacts SET updated_at = ? WHERE id = ?')
        .run(nowIso, contactId);
    } else {
      contactId = `c_${crypto.randomBytes(6).toString('hex')}`;
      this.db
        .prepare(
          'INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run(contactId, trimmedName, nowIso, nowIso);
    }

    // Insert or update identity
    this.db
      .prepare(
        `INSERT INTO identities (contact_id, platform, identifier_type, identifier_value, is_primary, created_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(platform, identifier_type, identifier_value) DO UPDATE SET
           contact_id = excluded.contact_id;`
      )
      .run(contactId, plat, idType, trimmedIdent, nowIso);

    return this.resolveContact(trimmedName)!;
  }

  public seedContacts(
    contacts: Array<{ name?: string; phone?: string; email?: string }>
  ): number {
    let seeded = 0;
    for (const c of contacts) {
      const name = c.name?.trim();
      if (!name) continue;

      if (c.phone?.trim()) {
        this.linkContactIdentity(name, 'imessage', c.phone.trim(), 'phone');
        seeded++;
      }
      if (c.email?.trim()) {
        this.linkContactIdentity(name, 'imessage', c.email.trim(), 'email');
        seeded++;
      }
    }
    return seeded;
  }

  public close(): void {
    this.db.close();
  }
}

export const identityGraph = new IdentityGraph();
