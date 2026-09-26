import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dir, '../.env') });
import cors from 'cors';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { Server, Tool } from "@modelcontextprotocol/server";
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logAuditEvent } from './audit.js';
import {
  getOAuthMetadata,
  getProtectedResourceMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleLogoutGet,
  handleRegisterPost,
  handleTokenPost,
  verifyJwt,
  getClientRegistry,
  secretsEqual
} from './oauth.js';
import { isRateLimited, recordAuthFailure } from './ratelimit.js';
import {
  initGlobalWatcher,
  stopGlobalWatcher,
  WatcherService,
  deliverWebhook,
  parseWatcherConfig,
} from './watcher.js';

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = path.resolve(__dir, '../bin/imessage');
// launchd node lacks Full Disk Access; sshd has it. Route CLI via localhost SSH
// so chat.db reads work without GUI TCC grants (SIP blocks writing TCC.db).
const IMESSAGE_SSH_FDA = process.env.IMESSAGE_SSH_FDA !== 'false';
const SSH_BIN = process.env.SSH_BIN || '/usr/bin/ssh';
const SSH_FDA_HOST = process.env.IMESSAGE_SSH_FDA_HOST || 'localhost';
const CLI_MAX_BUFFER = 32 * 1024 * 1024;

// ssh joins remote command words with spaces and hands them to the login
// shell unquoted, so every word must be single-quoted to survive the hop.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function useSshForCli(): boolean {
  // An explicit database override is a local fixture or copy; do not hop over SSH.
  if (process.env.IMESSAGE_DB_PATH) return false;
  return process.env.IMESSAGE_SSH_FDA !== 'false';
}

export async function runImessageCli(cliArgs: string[]): Promise<string> {
  try {
    if (useSshForCli()) {
      const remoteCommand = [PYTHON_BIN, CLI_PATH, ...cliArgs]
        .map(shellQuote)
        .join(' ');
      const { stdout } = await execFileAsync(
        SSH_BIN,
        [
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'IdentitiesOnly=yes',
          '-o', 'ConnectTimeout=15',
          '-o', 'LogLevel=ERROR',
          SSH_FDA_HOST,
          remoteCommand,
        ],
        { maxBuffer: CLI_MAX_BUFFER },
      );
      return stdout;
    }
    const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, ...cliArgs], {
      maxBuffer: CLI_MAX_BUFFER,
    });
    return stdout;
  } catch (err: any) {
    const detail = [err.stderr, err.stdout, err.message]
      .map((v) => (typeof v === 'string' ? v : v?.toString?.() || ''))
      .find((s) => s.trim()) || String(err);
    throw new Error(`imessage CLI failed: ${detail.trim().slice(0, 2000)}`);
  }
}


const PORT = parseInt(process.env.PORT || '8765', 10);
// Dual-stack: '::' accepts IPv6 + IPv4-mapped (Node default ipv6Only=false).
// Override with HOST=0.0.0.0 for IPv4-only.
const HOST = process.env.HOST || '::';
const AUTH_TOKEN = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'imessage.genericservice.app';
const SERVER_VERSION = '1.4.1';
const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;
const LEGACY_BEARER_TOKENS = new Set(
  (process.env.LEGACY_BEARER_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
);

/**
 * 2026-07-28 Model Context Protocol Specification Version
 */
export const SPEC_VERSION = '2026-07-28';

/**
 * Supported Model Context Protocol specification versions (Dual-era modern and legacy support).
 */
export const SUPPORTED_SPEC_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07'
];

/**
 * Decodes RFC 9110 / MCP 2026-07-28 sentinel encoded header values (=?base64?...?=).
 */
export function decodeHeaderValue(val: string): string {
  if (val.startsWith('=?base64?') && val.endsWith('?=')) {
    const base64Str = val.slice(9, -2);
    try {
      return Buffer.from(base64Str, 'base64').toString('utf8');
    } catch {
      return val;
    }
  }
  return val;
}

const SERVER_INSTRUCTIONS = `
iMessage MCP Server Instructions:
1. Discovery: Call 'imessage_list_chats' to discover available conversation IDs, display names, and handles.
2. Search: Call 'imessage_search_messages' to search past message history by keyword or voice note speech-to-text transcriptions, or 'imessage_search_contacts' to find contacts.
3. Reading: Call 'imessage_read_messages' or 'imessage_get_recent_messages' with chat or its alias chat_id. The value is the numeric chat ROWID from imessage_list_chats (rowid / chat_id), or a display name, phone number, or email. Pass since_msg_id to poll only messages with a greater id, and with_meta true to read next_since_msg_id (advance the cursor with that, not the last visible msg_id). Messages include ISO timestamps, delivery status (is_delivered, delivered_at, delivered_at_iso), read status (is_read, read_at, read_at_iso; note that read_at on outgoing messages requires the recipient to have read receipts enabled), link previews, structured reactions, voice note transcriptions, and edit history. Tapbacks are structured reaction objects.
4. Edit History: Call 'imessage_get_edit_history' with a numeric message ROWID to inspect all revisions and rewrites of an edited message.
5. Editing: Call 'imessage_edit_message' with message_id and new_text. When SIP is enabled on the host Mac, it returns bridge_available: false with suggested_text and fallback advice.
6. Multimodal Attachments: Call 'imessage_get_attachment_payload' to get base64 data for image/file attachments (converts HEIC photos to JPEG and CAF voice notes to playable/transcribable M4A audio with on-device speech-to-text transcripts).
7. Sending: Call 'imessage_send_message' to send messages. Confirm recipient details and message text before sending on behalf of the user.
8. Call History: Call 'imessage_get_call_history' to inspect phone and FaceTime call history, or pass 'include_calls: true' on reading tools to merge call records into conversation timelines.
9. Documentation: Call 'imessage_get_readme' or read resource 'resource://readme' to inspect server configuration and usage.
`.trim();

function publicBaseUrl(): string {
  return `https://${PUBLIC_DOMAIN}`;
}

function resourceMetadataUrl(): string {
  return `${publicBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

function setWwwAuthenticate(res: Response, errorCode: string, description: string): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer error="${errorCode}", error_description="${description}", resource_metadata="${resourceMetadataUrl()}"`
  );
}

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/**
 * Argument readers. Schema aliases and these keys stay in lockstep.
 */
export function readArg(args: Record<string, unknown> | undefined, keys: readonly string[]): unknown {
  if (!args) return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

export function readStringArg(args: Record<string, unknown> | undefined, keys: readonly string[]): string {
  const value = readArg(args, keys);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
}

export function readIntArg(args: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  const value = readArg(args, keys);
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  throw new Error(`Invalid integer for parameter "${keys[0]}"`);
}

export function readBoolArg(args: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  const value = readArg(args, keys);
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

export const CHAT_ARG_KEYS = ['chat', 'chat_id', 'chatId', 'thread_id', 'threadId', 'conversation_id', 'conversationId'] as const;

export function readChatArg(args: Record<string, unknown> | undefined): string {
  return readStringArg(args, CHAT_ARG_KEYS);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function appendPresentationArgs(cli: string[], args: Record<string, unknown> | undefined): void {
  const since = readIntArg(args, [
    'since_msg_id',
    'since_message_id',
    'sinceMsgId',
    'sinceMessageId',
    'after_msg_id',
    'after_id',
    'afterMsgId',
    'afterId',
    'since_id',
    'since'
  ]);
  if (since !== undefined) {
    if (since < 0) {
      throw new Error('Invalid parameter "since_msg_id" (non-negative integer message ROWID expected)');
    }
    cli.push('--since-msg-id', String(since));
  }
  const reactions = readStringArg(args, ['reactions', 'reaction_mode', 'reactions_mode', 'reactionsMode']);
  if (reactions) {
    if (reactions !== 'attach' && reactions !== 'separate') {
      throw new Error('Invalid parameter "reactions" (expected "attach" or "separate")');
    }
    cli.push('--reactions', reactions);
  }
  if (readBoolArg(args, ['include_filtered', 'includeFiltered'])) {
    cli.push('--include-filtered');
  }
  if (readBoolArg(args, ['include_calls', 'includeCalls'])) {
    cli.push('--include-calls');
  }
  if (readBoolArg(args, ['with_meta', 'withMeta', 'summary'])) {
    cli.push('--with-meta');
  }
}

const MISSING_CHAT =
  'Missing required parameter "chat" (also accepted as chat_id, chatId, thread_id, or conversation_id). Use the numeric ROWID from imessage_list_chats.';

const CHAT_VALUE_HELP =
  'Numeric chat ROWID from imessage_list_chats (field `rowid`, also returned as `chat_id`), for example "46". A display name, phone number, or email also matches. Call imessage_list_chats to discover the ROWID.';

const chatArgProperties = {
  chat: {
    type: 'string',
    description: `Conversation to read. ${CHAT_VALUE_HELP}`
  },
  chat_id: {
    type: 'string',
    description: `Alias of chat. ${CHAT_VALUE_HELP}`
  },
  chatId: {
    type: 'string',
    description: 'Alias of chat / chat_id. Same accepted values.'
  },
  thread_id: {
    type: 'string',
    description: 'Alias of chat. Same accepted values.'
  },
  conversation_id: {
    type: 'string',
    description: 'Alias of chat. Same accepted values.'
  }
};

const chatAnyOf = [
  { required: ['chat'] },
  { required: ['chat_id'] },
  { required: ['chatId'] },
  { required: ['thread_id'] },
  { required: ['conversation_id'] }
];

const readWindowProperties = {
  since_msg_id: {
    type: 'number',
    description:
      'Polling cursor. When set, return only rows in this chat whose message ROWID is strictly greater than this id (a single indexed range read). Pair with with_meta and advance the cursor using next_since_msg_id, which includes filtered tapback ids. Aliases: since_message_id, sinceMsgId, sinceMessageId, after_msg_id, after_id, afterMsgId, afterId, since_id, since.'
  },
  since_message_id: { type: 'number', description: 'Alias of since_msg_id.' },
  sinceMsgId: { type: 'number', description: 'Alias of since_msg_id.' },
  sinceMessageId: { type: 'number', description: 'Alias of since_msg_id.' },
  after_msg_id: { type: 'number', description: 'Alias of since_msg_id.' },
  after_id: { type: 'number', description: 'Alias of since_msg_id.' },
  afterMsgId: { type: 'number', description: 'Alias of since_msg_id.' },
  afterId: { type: 'number', description: 'Alias of since_msg_id.' },
  since_id: { type: 'number', description: 'Alias of since_msg_id.' },
  since: {
    type: 'number',
    description: 'Alias of since_msg_id when the value is a message ROWID, not a calendar timestamp.'
  },
  reactions: {
    type: 'string',
    enum: ['attach', 'separate'],
    description:
      'How to return tapbacks. "attach" (default) nests them on the target message. "separate" lists each tapback as a structured record (kind "reaction") in id order. Tapbacks are never repeated as Loved/Liked text. Alias: reactions_mode.'
  },
  reactions_mode: {
    type: 'string',
    enum: ['attach', 'separate'],
    description: 'Alias of reactions.'
  },
  include_filtered: {
    type: 'boolean',
    description:
      'When true, filtered rows such as tapbacks are included inline as structured records so their ids are visible. Alias: includeFiltered.'
  },
  includeFiltered: { type: 'boolean', description: 'Alias of include_filtered.' },
  include_calls: {
    type: 'boolean',
    description:
      'When true, merge phone and FaceTime calls with that chat\'s participants into the timeline in chronological order (kind: "call", text: null). Calls do not affect since_msg_id cursor pagination. Alias: includeCalls.'
  },
  includeCalls: { type: 'boolean', description: 'Alias of include_calls.' },
  with_meta: {
    type: 'boolean',
    description:
      'When true, wrap JSON as {messages, filtered, next_since_msg_id, has_more}. filtered counts omitted rows by kind (reaction). Advance a poll with next_since_msg_id. Aliases: withMeta, summary.'
  },
  withMeta: { type: 'boolean', description: 'Alias of with_meta.' },
  summary: { type: 'boolean', description: 'Alias of with_meta.' }
};

/**
 * Detailed MCP tool definitions for iMessage integration.
 */
export const TOOLS: Tool[] = [
  {
    name: 'imessage_list_chats',
    description:
      'List active iMessage chats and conversations. Returns chat ROWIDs (`rowid` and `chat_id`), display names, contact identifiers (phone numbers or emails), and recent activity order. Pass that ROWID as `chat` or `chat_id` to read or poll a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of recent chats to return (default: 30, max: 100). Aliases: count, max.'
        },
        count: { type: 'number', description: 'Alias of limit.' },
        max: { type: 'number', description: 'Alias of limit.' }
      }
    }
  },
  {
    name: 'imessage_read_messages',
    description:
      'Read recent message history from a specific iMessage chat. `chat` (alias `chat_id`) is the numeric chat ROWID from imessage_list_chats, or a display name, phone number, or email. Messages include ISO-8601 timestamps, delivery status (is_delivered, delivered_at, delivered_at_iso), read status (is_read, read_at, read_at_iso), link previews (url, title, subtitle, artist, site_name), structured tapbacks, voice note transcriptions, and edit history. Outgoing rows use sender "Me" with an empty handle; the other party is `participant`. Read receipts on outgoing messages only appear when the recipient has enabled read receipts.',
    inputSchema: {
      type: 'object',
      properties: {
        ...chatArgProperties,
        days: {
          type: 'number',
          description: 'Number of past days of message history to retrieve (default: 14). Alias: lookback_days.'
        },
        lookback_days: {
          type: 'number',
          description: 'Alias of days.'
        },
        ...readWindowProperties
      },
      anyOf: chatAnyOf
    }
  },
  {
    name: 'imessage_search_messages',
    description:
      'Full-text search across all historical iMessage conversations, including message text and voice note audio speech-to-text transcriptions. Returns matching messages, dates, chat IDs, senders, edit state (is_edited, edit_count), and revision history.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or phrase to search for across message history. Aliases: q, search.'
        },
        q: {
          type: 'string',
          description: 'Alias of query.'
        },
        search: {
          type: 'string',
          description: 'Alias of query.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching search results to return (default: 30). Aliases: count, max.'
        },
        count: {
          type: 'number',
          description: 'Alias of limit.'
        },
        max: {
          type: 'number',
          description: 'Alias of limit.'
        },
        ...readWindowProperties
      },
      anyOf: [
        { required: ['query'] },
        { required: ['q'] },
        { required: ['search'] }
      ]
    }
  },
  {
    name: 'imessage_search_contacts',
    description:
      'Search macOS AddressBook contacts by name, phone number, or email address.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Contact name, phone number, or email address search string (optional, leave empty to list recent contacts).'
        }
      }
    }
  },
  {
    name: 'imessage_get_chat_members',
    description:
      'Get members and participants of a specific iMessage chat (useful for group chats). `chat` (alias `chat_id`) is the numeric chat ROWID from imessage_list_chats, or a display name, phone number, or email.',
    inputSchema: {
      type: 'object',
      properties: {
        ...chatArgProperties
      },
      anyOf: chatAnyOf
    }
  },
  {
    name: 'imessage_get_attachment_payload',
    description:
      'Fetch metadata and base64 payload for an attachment file (converts HEIC photos to JPEG and CAF audio voice notes to M4A for multimodal LLMs, returning duration and on-device speech-to-text transcriptions).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'POSIX path to attachment file (e.g. "/Users/matthias/Library/Messages/Attachments/.../IMG_4031.png"). Aliases: file, file_path, filepath.'
        },
        file: { type: 'string', description: 'Alias of path.' },
        file_path: { type: 'string', description: 'Alias of path.' },
        filepath: { type: 'string', description: 'Alias of path.' }
      },
      required: ['path']
    }
  },
  {
    name: 'imessage_send_message',
    description:
      'Send an outbound iMessage to a recipient or existing group chat thread using AppleScript on macOS. Supports text message body and/or file attachments (images, PDFs, documents, audio/video). Supports dry_run safety previews with confirmation tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: "Target recipient phone number, email address, group chat display name, or numeric chat ROWID (e.g. '+15550199480', 'user@example.com', '46', or 'chat123456789012345678'). Alias: to."
        },
        to: {
          type: 'string',
          description: 'Alias of recipient.'
        },
        message: {
          type: 'string',
          description: 'Optional text content of the iMessage to send.'
        },
        attachment: {
          type: 'string',
          description: 'Optional local POSIX file path of an attachment to send (e.g. "/Users/shared/Pictures/sandworm.jpg").'
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, returns a structured safety preview object and confirmation token without sending (default: false).'
        },
        confirm_token: {
          type: 'string',
          description: 'Confirmation token returned by a previous dry_run preview call to authorize dispatch.'
        }
      },
      required: ['recipient']
    }
  },
  {
    name: 'imessage_get_recent_messages',
    description:
      'Preview the last N messages in a chat, or poll for rows newer than since_msg_id. `chat` (alias `chat_id`) is the numeric chat ROWID from imessage_list_chats (`rowid` / `chat_id`), or a display name, phone number, or email. Results include ISO timestamps, delivery status (is_delivered, delivered_at, delivered_at_iso), read status (is_read, read_at, read_at_iso), link previews, and structured tapbacks (not as Loved/Liked text). Outgoing rows use sender "Me" with an empty handle and a separate `participant`. Pass with_meta to get filtered counts and next_since_msg_id. Read receipts on outgoing messages only appear when the recipient has enabled read receipts.',
    inputSchema: {
      type: 'object',
      properties: {
        ...chatArgProperties,
        limit: {
          type: 'number',
          description: 'Number of recent messages to preview (default: 5, max: 50). With since_msg_id, the limit applies to raw rows so the cursor can page. Aliases: count, max.'
        },
        count: { type: 'number', description: 'Alias of limit.' },
        max: { type: 'number', description: 'Alias of limit.' },
        ...readWindowProperties
      },
      anyOf: chatAnyOf
    }
  },
  {
    name: 'imessage_search_group_chats',
    description:
      'Search for multi-party group chats matching an exact set of participant names or phone numbers (e.g. ["Chani", "Paul Atreides"]). Returns only threads where all requested participants exist.',
    inputSchema: {
      type: 'object',
      properties: {
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of participant names or phone numbers to match (e.g. ["Chani", "Paul Atreides"]). Alias: participant (a single string or the same array).'
        },
        participant: {
          type: 'string',
          description: 'Alias of participants when matching a single name or handle.'
        }
      },
      anyOf: [
        { required: ['participants'] },
        { required: ['participant'] }
      ]
    }
  },
  {
    name: 'imessage_get_edit_history',
    description:
      'Retrieve the full rewrite/edit history for a specific iMessage by its numeric message ROWID. Returns original draft, chronological revisions, edit timestamps, and final edited text.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'number',
          description: 'Numeric message ROWID (e.g. 198097) to inspect rewrite and edit history for. Aliases: msg_id, messageId.'
        },
        msg_id: { type: 'number', description: 'Alias of message_id.' },
        messageId: { type: 'number', description: 'Alias of message_id.' }
      },
      anyOf: [
        { required: ['message_id'] },
        { required: ['msg_id'] },
        { required: ['messageId'] }
      ]
    }
  },
  {
    name: 'imessage_edit_message',
    description:
      'Attempt to edit a previously sent outgoing iMessage by its numeric message ROWID (15-minute Apple protocol window, max 5 edits). Note: In-place editing requires the imsg IMCore bridge with SIP disabled. When SIP is enabled on the host Mac, this tool returns bridge_available: false along with the suggested_text and fallback recommendations so the assistant can guide the user or send a follow-up correction.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'number',
          description: 'Numeric message ROWID of the outgoing message to edit. Aliases: msg_id, messageId.'
        },
        msg_id: { type: 'number', description: 'Alias of message_id.' },
        messageId: { type: 'number', description: 'Alias of message_id.' },
        new_text: {
          type: 'string',
          description: 'New revised text content for the message. Aliases: newText, text.'
        },
        newText: { type: 'string', description: 'Alias of new_text.' },
        text: { type: 'string', description: 'Alias of new_text.' }
      },
      anyOf: [
        { required: ['message_id', 'new_text'] },
        { required: ['message_id', 'newText'] },
        { required: ['message_id', 'text'] },
        { required: ['msg_id', 'new_text'] },
        { required: ['msg_id', 'newText'] },
        { required: ['msg_id', 'text'] },
        { required: ['messageId', 'new_text'] },
        { required: ['messageId', 'newText'] },
        { required: ['messageId', 'text'] }
      ]
    }
  },
  {
    name: 'imessage_get_call_history',
    description:
      'Retrieve call and FaceTime history from macOS CallHistoryDB. Filter by contact handle or name, chat ROWID (resolves chat participants to handles), time window (since/until), or call_type. Each record returns id, handle, contact name, direction (incoming/outgoing), answered, missed, duration_seconds, call_type, timestamp, and timestamp_iso.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description:
            'Filter by phone number, email address, or contact name (e.g. "+15550199480", "user@example.com", or "Chani"). Aliases: contact, recipient, phone, email.'
        },
        contact: { type: 'string', description: 'Alias of handle.' },
        recipient: { type: 'string', description: 'Alias of handle.' },
        phone: { type: 'string', description: 'Alias of handle.' },
        email: { type: 'string', description: 'Alias of handle.' },
        chat: {
          type: 'string',
          description:
            'Filter calls with participants of a specific chat. Accepts numeric chat ROWID or chat identifier. Aliases: chat_id, chatId, thread_id, conversation_id.'
        },
        chat_id: { type: 'string', description: 'Alias of chat.' },
        chatId: { type: 'string', description: 'Alias of chat.' },
        thread_id: { type: 'string', description: 'Alias of chat.' },
        conversation_id: { type: 'string', description: 'Alias of chat.' },
        since: {
          type: 'string',
          description:
            'Filter calls after this timestamp (ISO 8601 string, Unix epoch seconds, or Apple epoch seconds).'
        },
        until: {
          type: 'string',
          description:
            'Filter calls before this timestamp (ISO 8601 string, Unix epoch seconds, or Apple epoch seconds).'
        },
        call_type: {
          type: 'string',
          enum: ['phone', 'facetime_video', 'facetime_audio', 'unknown'],
          description:
            'Filter by call type: "phone", "facetime_video", "facetime_audio", or "unknown". Alias: callType.'
        },
        callType: {
          type: 'string',
          enum: ['phone', 'facetime_video', 'facetime_audio', 'unknown'],
          description: 'Alias of call_type.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of calls to return (default: 30, max: 100). Aliases: count, max.'
        },
        count: { type: 'number', description: 'Alias of limit.' },
        max: { type: 'number', description: 'Alias of limit.' }
      }
    }
  },
  {
    name: 'imessage_get_readme',
    description:
      'Retrieve the full iMessage MCP Server README documentation (markdown), setup guides, client configurations, and API signatures.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

interface PendingSend {
  recipient: string;
  message: string;
  attachment: string;
  createdAt: number;
}
const pendingConfirmTokens = new Map<string, PendingSend>();

function pruneExpiredConfirmTokens(now = Date.now()): void {
  for (const [token, pending] of pendingConfirmTokens.entries()) {
    if (now - pending.createdAt > CONFIRM_TOKEN_TTL_MS) {
      pendingConfirmTokens.delete(token);
    }
  }
}

export const activeMcpServers = new Set<Server>();

export const globalResourceNotifier = {
  async sendResourceUpdated(params: { uri: string }): Promise<void> {
    for (const s of activeMcpServers) {
      try {
        await s.sendResourceUpdated(params);
      } catch {
        // Ignored if not supported or not subscribed
      }
    }
  }
};

/**
 * Creates and configures an instance of the MCP Server.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'imessage-mcp-server',
      version: SERVER_VERSION
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        },
        resources: {
          subscribe: true,
          listChanged: false
        }
      },
      instructions: SERVER_INSTRUCTIONS,
      supportedProtocolVersions: SUPPORTED_SPEC_VERSIONS
    }
  );

  activeMcpServers.add(server);

  server.setRequestHandler('server/discover', async () => {
    return {
      resultType: 'complete',
      supportedVersions: SUPPORTED_SPEC_VERSIONS,
      capabilities: {
        tools: {
          listChanged: true,
          ttlMs: 300000,
          cacheScope: 'client'
        },
        resources: {
          subscribe: true,
          listChanged: false
        }
      },
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'imessage-mcp-server',
          version: SERVER_VERSION
        }
      },
      instructions: SERVER_INSTRUCTIONS,
      ttlMs: 300000,
      cacheScope: 'client'
    } as any;
  });

  server.setRequestHandler('tools/list', async () => {
    return {
      tools: TOOLS,
      ttlMs: 300000,
      cacheScope: 'client'
    } as any;
  });

  server.setRequestHandler('resources/list', async () => {
    return {
      resources: [
        {
          uri: 'resource://readme',
          name: 'README.md',
          description: 'Full iMessage MCP Server Documentation & Usage Guide',
          mimeType: 'text/markdown'
        },
        {
          uri: 'resource://messages/recent',
          name: 'Recent Messages Notification',
          description: 'Resource tracking new messages in iMessage chat.db for real-time notifications',
          mimeType: 'application/json'
        }
      ]
    };
  });

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    if (uri === 'resource://readme' || uri === 'file:///README.md') {
      const readmePath = path.resolve(__dir, '../README.md');
      const content = await fs.promises.readFile(readmePath, 'utf8');
      return {
        contents: [
          {
            uri: 'resource://readme',
            mimeType: 'text/markdown',
            text: content
          }
        ]
      };
    }
    if (uri === 'resource://messages/recent') {
      return {
        contents: [
          {
            uri: 'resource://messages/recent',
            mimeType: 'application/json',
            text: JSON.stringify({
              status: 'active',
              timestamp_iso: new Date().toISOString()
            })
          }
        ]
      };
    }
    throw new Error(`Resource not found: ${uri}`);
  });

  server.setRequestHandler('resources/subscribe', async () => {
    return {};
  });

  server.setRequestHandler('resources/unsubscribe', async () => {
    return {};
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();
    let targetParam: string | undefined = undefined;
    let dryRunParam: boolean | undefined = undefined;

    const toolArgs = args as Record<string, unknown> | undefined;
    if (name === 'imessage_send_message') {
      targetParam = readStringArg(toolArgs, ['recipient', 'to', 'confirm_token']);
      dryRunParam = Boolean(args?.dry_run);
    } else if (name === 'imessage_read_messages' || name === 'imessage_get_recent_messages' || name === 'imessage_get_chat_members') {
      targetParam = readChatArg(toolArgs);
    } else if (name === 'imessage_search_messages' || name === 'imessage_search_contacts') {
      targetParam = readStringArg(toolArgs, ['query', 'q', 'search']);
    } else if (name === 'imessage_get_attachment_payload') {
      targetParam = readStringArg(toolArgs, ['path', 'file', 'file_path', 'filePath', 'filepath']);
    } else if (name === 'imessage_get_edit_history' || name === 'imessage_edit_message') {
      targetParam = readStringArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
    } else if (name === 'imessage_get_call_history') {
      targetParam = readStringArg(toolArgs, ['handle', 'contact', 'recipient', 'phone', 'email', 'chat', 'chat_id']);
    }

    try {
      let result: { content: { type: 'text'; text: string }[]; isError?: boolean };
      if (name === 'imessage_get_readme') {
        const readmePath = path.resolve(__dir, '../README.md');
        const content = await fs.promises.readFile(readmePath, 'utf8');
        result = {
          content: [{ type: 'text', text: content }]
        };
      } else if (name === 'imessage_list_chats') {
        const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 30, 1, 100);
        const stdout = await runImessageCli(['list', '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_read_messages') {
        const chat = readChatArg(toolArgs);
        const days = clampInt(readIntArg(toolArgs, ['days', 'lookback_days', 'lookbackDays']), 14, 1, 365);
        if (!chat) {
          throw new Error(MISSING_CHAT);
        }
        const cliArgs = ['read', chat, '--days', String(days), '--json'];
        appendPresentationArgs(cliArgs, toolArgs);
        const stdout = await runImessageCli(cliArgs);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_messages') {
        const query = readStringArg(toolArgs, ['query', 'q', 'search']);
        const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 30, 1, 100);
        if (!query) {
          throw new Error('Missing required parameter "query"');
        }
        const cliArgs = ['search', query, '--limit', String(limit), '--json'];
        appendPresentationArgs(cliArgs, toolArgs);
        const stdout = await runImessageCli(cliArgs);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_contacts') {
        const query = readStringArg(toolArgs, ['query', 'q', 'search']);
        const stdout = await runImessageCli(['contacts', query, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_recent_messages') {
        const chat = readChatArg(toolArgs);
        const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 5, 1, 50);
        if (!chat) {
          throw new Error(MISSING_CHAT);
        }
        const cliArgs = ['recent', chat, '--limit', String(limit), '--json'];
        appendPresentationArgs(cliArgs, toolArgs);
        const stdout = await runImessageCli(cliArgs);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_group_chats') {
        const raw = readArg(toolArgs, ['participants', 'participant']);
        const participants: string[] = Array.isArray(raw)
          ? raw.map(p => String(p).trim()).filter(Boolean)
          : typeof raw === 'string' && raw.trim()
            ? [raw.trim()]
            : [];
        if (participants.length === 0) {
          throw new Error('Missing required parameter "participants" (non-empty array)');
        }
        const stdout = await runImessageCli(['search-group', ...participants, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_chat_members') {
        const chat = readChatArg(toolArgs);
        if (!chat) {
          throw new Error(MISSING_CHAT);
        }
        const stdout = await runImessageCli(['members', chat, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_attachment_payload') {
        const filePath = readStringArg(toolArgs, ['path', 'file', 'file_path', 'filePath', 'filepath']);
        if (!filePath) {
          throw new Error('Missing required parameter "path"');
        }
        const stdout = await runImessageCli(['attachment', filePath, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_edit_history') {
        const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
        if (messageId === undefined || messageId <= 0) {
          throw new Error('Missing or invalid required parameter "message_id" (positive integer ROWID expected)');
        }
        const stdout = await runImessageCli(['edits', String(messageId), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_edit_message') {
        const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
        const newText = readStringArg(toolArgs, ['new_text', 'newText', 'text']);
        if (messageId === undefined || messageId <= 0) {
          throw new Error('Missing or invalid required parameter "message_id" (positive integer ROWID expected)');
        }
        if (!newText) {
          throw new Error('Missing or empty required parameter "new_text"');
        }
        const stdout = await runImessageCli(['edit', String(messageId), '--text', newText, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_call_history') {
        const handle = readStringArg(toolArgs, ['handle', 'contact', 'recipient', 'phone', 'email']);
        const chat = readChatArg(toolArgs);
        const since = readStringArg(toolArgs, ['since']);
        const until = readStringArg(toolArgs, ['until']);
        const callType = readStringArg(toolArgs, ['call_type', 'callType', 'type']);
        const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 30, 1, 100);

        const cliArgs = ['calls', '--limit', String(limit), '--json'];
        if (handle) {
          cliArgs.push('--handle', handle);
        }
        if (chat) {
          cliArgs.push('--chat', chat);
        }
        if (since) {
          cliArgs.push('--since', since);
        }
        if (until) {
          cliArgs.push('--until', until);
        }
        if (callType) {
          cliArgs.push('--call-type', callType);
        }
        const stdout = await runImessageCli(cliArgs);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_send_message') {
        const dryRun = Boolean(args?.dry_run);
        const confirmToken = String(args?.confirm_token || '').trim();

        let recipient = readStringArg(toolArgs, ['recipient', 'to']);
        let message = String(args?.message || '').trim();
        let attachment = String(args?.attachment || '').trim();

        if (confirmToken) {
          pruneExpiredConfirmTokens();
          const pending = pendingConfirmTokens.get(confirmToken);
          if (!pending) {
            throw new Error(`Invalid or expired confirm_token: "${confirmToken}". Please run a new dry_run preview or send directly.`);
          }
          pendingConfirmTokens.delete(confirmToken);
          recipient = pending.recipient;
          message = pending.message;
          attachment = pending.attachment;
        }

        if (dryRun && !confirmToken) {
          if (!recipient) throw new Error('Missing required parameter "recipient"');
          pruneExpiredConfirmTokens();
          const token = `cf_${crypto.randomBytes(8).toString('hex')}`;
          pendingConfirmTokens.set(token, { recipient, message, attachment, createdAt: Date.now() });

          let membersOutput = [];
          try {
            const stdout = await runImessageCli(['members', recipient, '--json']);
            membersOutput = JSON.parse(stdout);
          } catch {}

          const previewObj = {
            status: "preview",
            dry_run: true,
            target_recipient: recipient,
            message_text: message || null,
            attachment: attachment || null,
            participants: membersOutput,
            confirm_token: token,
            instructions: `To dispatch this message, re-call imessage_send_message with confirm_token: "${token}" or dry_run: false.`
          };

          result = {
            content: [{ type: 'text', text: JSON.stringify(previewObj, null, 2) }]
          };
        } else {
          if (!recipient) {
            throw new Error('Missing required parameter "recipient"');
          }

          const cliArgs = ['send', recipient];
          if (message) cliArgs.push('-m', message);
          if (attachment) cliArgs.push('-a', attachment);

          const stdout = await runImessageCli(cliArgs);
          result = {
            content: [{ type: 'text', text: stdout }]
          };
        }
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      logAuditEvent({
        timestamp: new Date().toISOString(),
        client_id: (ctx as any)?.user?.sub || 'master-token',
        tool: name,
        target: targetParam,
        dry_run: dryRunParam,
        status: 'success',
        duration_ms: Date.now() - startTime
      });
      return result;
    } catch (error: any) {
      logAuditEvent({
        timestamp: new Date().toISOString(),
        client_id: (ctx as any)?.user?.sub || 'master-token',
        tool: name,
        target: targetParam,
        dry_run: dryRunParam,
        status: 'error',
        duration_ms: Date.now() - startTime,
        error_message: error.message || String(error)
      });
      console.error(`[MCP Tool Error] ${name}:`, error);
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${error.message || String(error)}` }],
        isError: true
      };
    }
  });

  return server;
}

const app = express();
app.use(cors({
  origin: '*',
  exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'Mcp-Session-Id',
    'MCP-Protocol-Version',
    'Mcp-Protocol-Version'
  ]
}));

/** Parse JSON for /mcp POSTs (ping/initialize) without buffering SSE streams. */
async function parseMcpRequestBody(req: Request): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return req.body;
  }
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return undefined;

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 4 * 1024 * 1024;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Skip express.json for /mcp endpoints so @hono/node-server in MCP SDK can stream raw req
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/mcp')) {
    return next();
  }
  express.json()(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ extended: true })(req, res, next);
  });
});

/**
 * Network Connection Audit Middleware & 2026-07-28 Header Compliance
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  // Normalize Accept header for /mcp endpoints so all Streamable HTTP clients work seamlessly
  if (req.path.startsWith('/mcp')) {
    req.headers['accept'] = 'application/json, text/event-stream';
    if (Array.isArray(req.rawHeaders)) {
      let foundAccept = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i] && req.rawHeaders[i].toLowerCase() === 'accept') {
          req.rawHeaders[i + 1] = 'application/json, text/event-stream';
          foundAccept = true;
        }
      }
      if (!foundAccept) {
        req.rawHeaders.push('Accept', 'application/json, text/event-stream');
      }
    }
  }
  const startTime = Date.now();
  const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const clientIp = rawIp.replace(/^::ffff:/, '');
  const userAgent = req.headers['user-agent'] || 'unknown';

  // 2026-07-28 Header-based routing compliance
  res.setHeader('MCP-Protocol-Version', SPEC_VERSION);
  const mcpMethod = req.headers['mcp-method'] || req.headers['x-mcp-method'];
  const mcpName = req.headers['mcp-name'] || req.headers['x-mcp-name'];
  if (mcpMethod && typeof mcpMethod === 'string') {
    res.setHeader('Mcp-Method', mcpMethod);
  }
  if (mcpName && typeof mcpName === 'string') {
    res.setHeader('Mcp-Name', mcpName);
  }

  res.on('finish', () => {
    if (req.path.startsWith('/mcp') || req.path.startsWith('/sse') || req.path.startsWith('/oauth') || req.path === '/health' || req.path === '/discover') {
      logAuditEvent({
        timestamp: new Date().toISOString(),
        type: 'http_connection',
        client_id: (req as any).user?.sub || (req.headers.authorization ? 'master-token' : 'anonymous'),
        client_ip: clientIp,
        user_agent: userAgent,
        method: (mcpMethod as string) || req.method,
        path: req.path,
        status_code: res.statusCode,
        status: res.statusCode < 400 ? 'success' : 'error',
        duration_ms: Date.now() - startTime
      });
    }
  });
  next();
});

/**
 * OAuth 2.0 Authorization Server Endpoints
 * Serve RFC 8414 / RFC 9728 metadata at every path Grok/Cursor probe.
 */
function sendOAuthMetadata(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getOAuthMetadata(publicBaseUrl()));
}

function sendProtectedResourceMetadata(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getProtectedResourceMetadata(publicBaseUrl(), '/mcp'));
}

app.get('/.well-known/oauth-authorization-server', sendOAuthMetadata);
app.get('/.well-known/oauth-authorization-server/mcp', sendOAuthMetadata);
app.get('/mcp/.well-known/oauth-authorization-server', sendOAuthMetadata);

app.get('/.well-known/oauth-protected-resource', sendProtectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', sendProtectedResourceMetadata);
app.get('/mcp/.well-known/oauth-protected-resource', sendProtectedResourceMetadata);

app.get('/oauth/authorize', handleAuthorizeGet);
app.post('/oauth/authorize', handleAuthorizePost);
app.get('/oauth/logout', handleLogoutGet);
app.post('/oauth/token', handleTokenPost);
app.post('/oauth/register', handleRegisterPost);

const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
const httpSessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; server: Server; lastAccess: number }>();

// Session cleanup interval for Streamable HTTP transport
setInterval(() => {
  const now = Date.now();
  pruneExpiredConfirmTokens(now);
  for (const [sessionId, session] of httpSessions.entries()) {
    if (now - session.lastAccess > 300000) { // 5 minutes inactivity
      console.log(`[MCP] Cleaning up inactive Streamable HTTP session: ${sessionId}`);
      session.transport.close().catch(() => {});
      session.server.close().catch(() => {});
      httpSessions.delete(sessionId);
    }
  }
}, 60000);

/**
 * Enhanced Middleware for Bearer Token & OAuth JWT Authentication
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    return next();
  }
  if (
    ['/', '/health', '/discover'].includes(req.path)
    || req.path.startsWith('/.well-known/')
    || req.path.includes('/.well-known/')
    || req.path.startsWith('/oauth/')
  ) {
    return next();
  }

  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    recordAuthFailure(req);
    if (isRateLimited(req)) {
      res.status(429).json({ error: 'Too Many Requests: too many failed authentication attempts, retry later' });
      return;
    }
    setWwwAuthenticate(res, 'invalid_token', 'Missing Authorization header or ?token parameter');
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header or ?token parameter' });
    return;
  }

  // 1. Static Master Bearer token check (backward compatibility)
  if (secretsEqual(token, AUTH_TOKEN)) {
    (req as any).user = { sub: 'master-token', scope: 'imessage:all' };
    return next();
  }

  // 2. Client Registry secret token check (e.g. ubuntu-remote)
  const registry = getClientRegistry();
  for (const [clientId, clientSecret] of registry.entries()) {
    if (secretsEqual(token, clientSecret)) {
      (req as any).user = { sub: clientId, scope: 'imessage:all' };
      return next();
    }
  }

  // Legacy transition tokens (env-configurable; avoids hardcoded secrets in source)
  for (const legacyToken of LEGACY_BEARER_TOKENS) {
    if (secretsEqual(token, legacyToken)) {
      (req as any).user = { sub: 'legacy-client', scope: 'imessage:all' };
      return next();
    }
  }

  // 3. OAuth 2.0 JWT verification
  const jwtPayload = verifyJwt(token);
  if (jwtPayload) {
    (req as any).user = jwtPayload;
    return next();
  }

  recordAuthFailure(req);
  if (isRateLimited(req)) {
    res.status(429).json({ error: 'Too Many Requests: too many failed authentication attempts, retry later' });
    return;
  }
  setWwwAuthenticate(res, 'invalid_token', 'Invalid bearer token or expired OAuth JWT');
  res.status(403).json({ error: 'Forbidden: Invalid bearer token or expired OAuth JWT' });
}

/**
 * Root discovery HTML / documentation page.
 */
app.get('/', (_req, res) => {
  const publicBase = publicBaseUrl();
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>iMessage MCP Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #f5f0eb; padding: 2rem; max-width: 900px; margin: 0 auto; line-height: 1.6; }
    h1 { color: #d4a843; border-bottom: 1px solid #333; padding-bottom: 0.5rem; }
    h2 { color: #d4a843; margin-top: 1.5rem; }
    code, pre { background: #1a1a1a; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: "SF Mono", Monaco, Consolas, monospace; }
    pre { padding: 1rem; overflow-x: auto; border: 1px solid #2a2a2a; }
    .endpoint { background: #141414; border-left: 4px solid #d4a843; padding: 0.75rem 1rem; margin: 0.5rem 0; }
    .badge { display: inline-block; background: #d4a843; color: #0a0a0a; font-weight: bold; font-size: 0.75rem; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>iMessage MCP Server</h1>
  <p>Model Context Protocol (MCP) Server for macOS iMessage integration over HTTP and SSE.</p>
  
  <h2>Available Transports & Endpoints</h2>
  <div class="endpoint">
    <strong>Streamable HTTP Endpoint:</strong> <code>${publicBase}/mcp</code> <span class="badge">POST / GET</span><br>
    <em>Modern HTTP Streamable MCP transport (stateless & stateful modes).</em>
  </div>
  <div class="endpoint">
    <strong>SSE Endpoint:</strong> <code>${publicBase}/sse</code> <span class="badge">GET</span><br>
    <em>Standard Server-Sent Events transport for mcp-remote and legacy clients.</em>
  </div>
  <div class="endpoint">
    <strong>Health Endpoint:</strong> <code>${publicBase}/health</code> <span class="badge">GET</span><br>
    <em>Public server health check and session counts.</em>
  </div>
  <div class="endpoint">
    <strong>Discovery JSON:</strong> <code>${publicBase}/discover</code> <span class="badge">GET</span><br>
    <em>Structured API discovery metadata and tool schemas.</em>
  </div>

  <h2>Available Tools</h2>
  <ul>
    <li><code>imessage_list_chats</code>: List recent conversations, display names, and handles.</li>
    <li><code>imessage_read_messages</code>: Read message history from a chat.</li>
    <li><code>imessage_search_messages</code>: Full-text search across historical iMessage text.</li>
    <li><code>imessage_search_contacts</code>: Search macOS contacts by name, phone, or email.</li>
    <li><code>imessage_get_chat_members</code>: Get members of a group chat.</li>
    <li><code>imessage_get_attachment_payload</code>: Fetch attachment metadata and base64 payload.</li>
    <li><code>imessage_send_message</code>: Send an iMessage with text and/or attachments.</li>
    <li><code>imessage_get_recent_messages</code>: Preview last N messages, or poll with since_msg_id. chat and chat_id both accept the list ROWID.</li>
    <li><code>imessage_search_group_chats</code>: Find group chats by participant set.</li>
    <li><code>imessage_get_edit_history</code>: Inspect rewrite and edit history of a message by ROWID.</li>
    <li><code>imessage_edit_message</code>: Edit a sent outgoing iMessage within Apple's 15-minute window.</li>
    <li><code>imessage_get_call_history</code>: Retrieve phone and FaceTime call history.</li>
    <li><code>imessage_get_readme</code>: Full server README and setup guide.</li>
  </ul>
</body>
</html>
  `);
});

/**
 * Health check endpoint.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'imessage-mcp-server',
    version: SERVER_VERSION,
    mcpProtocolVersion: SPEC_VERSION,
    publicDomain: PUBLIC_DOMAIN,
    activeSseSessions: sseSessions.size,
    activeHttpSessions: httpSessions.size,
    imessageSshFda: IMESSAGE_SSH_FDA,
    transports: ['sse', 'streamable-http']
  });
});

/**
 * Structured discovery JSON endpoint (2026-07-28 Spec Compliant).
 */
app.get('/discover', (_req, res) => {
  const publicBase = publicBaseUrl();
  res.json({
    name: 'imessage-mcp-server',
    version: SERVER_VERSION,
    mcpProtocolVersion: SPEC_VERSION,
    description: 'iMessage MCP Server over HTTP/HTTPS and SSE for macOS (Stateless & MRTR Enabled)',
    publicDomain: PUBLIC_DOMAIN,
    capabilities: {
      tools: {
        listChanged: true,
        ttlMs: 300000,
        cacheScope: 'client'
      },
      resources: {
        subscribe: false,
        listChanged: false
      },
      prompts: {
        listChanged: false
      }
    },
    endpoints: {
      streamableHttp: `${publicBase}/mcp`,
      sse: `${publicBase}/sse`,
      health: `${publicBase}/health`,
      discover: `${publicBase}/discover`,
      oauthMetadata: `${publicBase}/.well-known/oauth-authorization-server`,
      protectedResourceMetadata: `${publicBase}/.well-known/oauth-protected-resource/mcp`
    },
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer <TOKEN>',
      grantTypesSupported: ['client_credentials', 'authorization_code']
    },
    tools: TOOLS
  });
});

/**
 * Streamable HTTP Transport endpoint (GET & POST) for /mcp and /mcp/*
 */
app.all(['/mcp', '/mcp/*'], authMiddleware, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  let parsedBody: unknown;
  try {
    parsedBody = await parseMcpRequestBody(req);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(400).json({ error: 'Bad Request', message: err.message || String(err) });
    }
    return;
  }

  // Handle standalone GET health probe requests (e.g. grok mcp doctor probes)
  if (req.method === 'GET' && !req.headers['mcp-session-id'] && !req.headers['Mcp-Session-Id']) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
      status: 'ok',
      server: 'imessage-mcp-server',
      version: SERVER_VERSION,
      mcpProtocolVersion: SPEC_VERSION,
      publicDomain: PUBLIC_DOMAIN,
      transports: ['streamable-http', 'sse']
    }));
    return;
  }

  // Handle ping & notification probes for grok/mcp doctor checks without requiring an active session
  if (parsedBody && typeof parsedBody === 'object') {
    const body = parsedBody as Record<string, unknown>;

    // 1. Protocol Version Validation (-32022)
    const headerProto = (req.headers['mcp-protocol-version'] || req.headers['Mcp-Protocol-Version']) as string | undefined;
    const metaProto = (body.params as any)?._meta?.['io.modelcontextprotocol/protocolVersion']
      || ((body.params as any)?.protocolVersion as string | undefined);
    const requestedVersion = headerProto || metaProto;

    if (requestedVersion && !SUPPORTED_SPEC_VERSIONS.includes(requestedVersion)) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32022,
          message: `Unsupported protocol version: ${requestedVersion}`,
          data: {
            supported: SUPPORTED_SPEC_VERSIONS,
            requested: requestedVersion
          }
        }
      });
      return;
    }

    // 2. Header Validation (-32020 HeaderMismatch)
    if (headerProto && metaProto && headerProto !== metaProto) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32020,
          message: `Header mismatch: MCP-Protocol-Version '${headerProto}' does not match body protocolVersion '${metaProto}'`
        }
      });
      return;
    }

    const mcpMethodHeader = (req.headers['mcp-method'] || req.headers['Mcp-Method']) as string | undefined;
    if (mcpMethodHeader && body.method && typeof body.method === 'string') {
      if (mcpMethodHeader !== body.method) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32020,
            message: `Header mismatch: Mcp-Method header '${mcpMethodHeader}' does not match body method '${body.method}'`
          }
        });
        return;
      }
    }

    const mcpNameHeader = (req.headers['mcp-name'] || req.headers['Mcp-Name']) as string | undefined;
    if (mcpNameHeader && body.params && typeof body.params === 'object') {
      const bodyName = (body.params as any).name || (body.params as any).uri;
      if (bodyName && typeof bodyName === 'string') {
        const decodedName = decodeHeaderValue(mcpNameHeader);
        if (decodedName !== bodyName) {
          res.status(400).json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: {
              code: -32020,
              message: `Header mismatch: Mcp-Name header '${decodedName}' does not match body '${bodyName}'`
            }
          });
          return;
        }
      }
    }

    if (body.method === 'ping') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({
        jsonrpc: '2.0',
        result: {},
        id: body.id ?? 1
      }));
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({
        jsonrpc: '2.0',
        result: {},
        id: body.id ?? null
      }));
      return;
    }

    if (body.method === 'server/discover') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        result: {
          resultType: 'complete',
          supportedVersions: SUPPORTED_SPEC_VERSIONS,
          capabilities: {
            tools: {
              listChanged: true,
              ttlMs: 300000,
              cacheScope: 'client'
            },
            resources: {
              subscribe: false,
              listChanged: false
            }
          },
          _meta: {
            'io.modelcontextprotocol/serverInfo': {
              name: 'imessage-mcp-server',
              version: SERVER_VERSION
            }
          },
          instructions: SERVER_INSTRUCTIONS,
          ttlMs: 300000,
          cacheScope: 'client'
        }
      }));
      return;
    }
  }

  const _setHeader = res.setHeader.bind(res);
  const _writeHead = res.writeHead.bind(res);

  res.setHeader = function (name: string, value: any) {
    if (String(name).toLowerCase() === 'content-length') {
      const ct = String(res.getHeader('content-type') || '');
      if (ct.includes('text/event-stream')) {
        return res;
      }
    }
    return _setHeader(name, value);
  };

  res.writeHead = function (statusCode: number, ...args: any[]) {
    const ct = String(res.getHeader('content-type') || '');
    if (ct.includes('text/event-stream')) {
      res.removeHeader('content-length');
      res.removeHeader('Content-Length');
    }
    return _writeHead(statusCode, ...args);
  };

  const reqSessionId = (req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id']) as string | undefined;

  if (reqSessionId && httpSessions.has(reqSessionId)) {
    const session = httpSessions.get(reqSessionId)!;
    session.lastAccess = Date.now();
    session.transport.setSupportedProtocolVersions(SUPPORTED_SPEC_VERSIONS);
    try {
      await session.transport.handleRequest(req, res, parsedBody);
    } catch (err: any) {
      console.error(`[MCP Session Error] ${reqSessionId}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', message: err.message });
      }
    }
    return;
  }

  const isLegacyInitialize = parsedBody && typeof parsedBody === 'object' && (parsedBody as any).method === 'initialize';

  try {
    if (isLegacyInitialize) {
      let generatedSessionId: string | undefined;
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => {
          generatedSessionId = crypto.randomUUID();
          return generatedSessionId;
        }
      });
      transport.setSupportedProtocolVersions(SUPPORTED_SPEC_VERSIONS);
      const server = createMcpServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, parsedBody);

      if (generatedSessionId) {
        httpSessions.set(generatedSessionId, { transport, server, lastAccess: Date.now() });
        console.log(`[MCP] Registered Streamable HTTP session: ${generatedSessionId}`);
      }
    } else {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      transport.setSupportedProtocolVersions(SUPPORTED_SPEC_VERSIONS);
      const server = createMcpServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, parsedBody);
    }
  } catch (err: any) {
    console.error('[MCP Transport Error]:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  }
});

/**
 * SSE Transport endpoint
 */
app.get('/sse', authMiddleware, async (req, res) => {
  console.log('[MCP] Client connecting to SSE transport...');
  const server = createMcpServer();
  const transport = new SSEServerTransport('/messages', res);

  await server.connect(transport);
  sseSessions.set(transport.sessionId, { transport, server });
  console.log(`[MCP] SSE session established: ${transport.sessionId}`);

  req.on('close', async () => {
    console.log(`[MCP] SSE client disconnected: ${transport.sessionId}`);
    sseSessions.delete(transport.sessionId);
    try {
      await transport.close();
      await server.close();
    } catch (e) {}
  });
});

app.post('/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).send('Missing sessionId query parameter');
    return;
  }
  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(400).send(`No active SSE session for sessionId: ${sessionId}`);
    return;
  }
  await session.transport.handlePostMessage(req, res);
});

if (process.env.NODE_ENV !== 'test') {
  initGlobalWatcher(globalResourceNotifier);

  if (USE_HTTPS) {
    const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
    const certPath = path.join(certDir, 'server.crt');
    const keyPath = path.join(certDir, 'server.key');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`HTTPS enabled but certificate files not found at ${certPath} and ${keyPath}.`);
      process.exit(1);
    }

    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    https.createServer(options, app).listen(PORT, HOST, () => {
      console.log(`=======================================================`);
      console.log(`iMessage MCP Server running over HTTPS:`);
      console.log(`  Discovery Page:      https://[${HOST}]:${PORT}/`);
      console.log(`  Streamable HTTP:     https://[${HOST}]:${PORT}/mcp`);
      console.log(`  SSE Transport:        https://[${HOST}]:${PORT}/sse`);
      console.log(`  Bearer Token:        ${maskToken(AUTH_TOKEN)} (see .env)`);
      console.log(`=======================================================`);
    });
  } else {
    http.createServer(app).listen(PORT, HOST, () => {
      console.log(`=======================================================`);
      console.log(`iMessage MCP Server running over HTTP:`);
      console.log(`  Discovery Page:      http://[${HOST}]:${PORT}/`);
      console.log(`  Streamable HTTP:     http://[${HOST}]:${PORT}/mcp`);
      console.log(`  SSE Transport:        http://[${HOST}]:${PORT}/sse`);
      console.log(`  Bearer Token:        ${maskToken(AUTH_TOKEN)} (see .env)`);
      console.log(`=======================================================`);
    });
  }
}

export {
  app,
  initGlobalWatcher,
  stopGlobalWatcher,
  WatcherService,
  deliverWebhook,
  parseWatcherConfig,
  createMcpServer,
};
