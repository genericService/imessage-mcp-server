import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dir, '../.env') });
import cors from 'cors';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
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
import { identityGraph } from './identity_graph.js';
import {
  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
  normalizeEffect,
  parseScheduleTime,
  EFFECT_MAP,
  initScheduler,
  clearAllScheduledTimers,
  ScheduledMessage
} from './scheduler.js';

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

export const cliRunner = {
  run: (args: string[]) => runImessageCli(args)
};

initScheduler(async (item: ScheduledMessage) => {
  const cliArgs = ['send', item.recipient];
  if (item.message) cliArgs.push('-m', item.message);
  if (item.attachment) cliArgs.push('-a', item.attachment);
  if (item.effect) cliArgs.push('--effect', item.effect);
  return await cliRunner.run(cliArgs);
});


const PORT = parseInt(process.env.PORT || '8765', 10);
// Dual-stack: '::' accepts IPv6 + IPv4-mapped (Node default ipv6Only=false).
// Override with HOST=0.0.0.0 for IPv4-only.
const HOST = process.env.HOST || '::';
const AUTH_TOKEN = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'imessage.genericservice.app';
const SERVER_VERSION = '1.12.0';
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
3. Reading: Call 'imessage_read_messages' or 'imessage_get_recent_messages' with chat or its alias chat_id. The value is the numeric chat ROWID from imessage_list_chats (rowid / chat_id), or a display name, phone number, or email. Pass since_msg_id to poll only messages with a greater id, and with_meta true to read next_since_msg_id (advance the cursor with that, not the last visible msg_id). Messages include ISO timestamps, reply context (reply_to with parent msg_id, guid, sender, and text), delivery status (is_delivered, delivered_at, delivered_at_iso), quiet/focus delivery status (delivered_quietly, was_delivered_quietly, notifications_silenced, did_notify_recipient), read status (is_read, read_at, read_at_iso; note that read_at on outgoing messages requires the recipient to have read receipts enabled), link previews, structured reactions, voice note transcriptions, and edit history. Tapbacks are structured reaction objects.
4. Edit History: Call 'imessage_get_edit_history' with a numeric message ROWID to inspect all revisions and rewrites of an edited message.
5. Editing: Call 'imessage_edit_message' with message_id and new_text. When SIP is enabled on the host Mac, it returns bridge_available: false with suggested_text and fallback advice.
6. Multimodal Attachments & Images: Call 'imessage_download_image' to download image attachments by message_id or path, converting HEIC photos to JPEG and saving to output_path. Call 'imessage_get_attachment_payload' to get base64 data for any attachment (converts HEIC photos to JPEG and CAF voice notes to playable/transcribable M4A audio with on-device speech-to-text transcripts).
7. Sending: Call 'imessage_send_message' to send messages. Confirm recipient details and message text before sending on behalf of the user. Attachments support local Mac POSIX file paths, remote HTTPS URLs, and base64 data strings (with dry_run safety preview verification).
8. Call History: Call 'imessage_get_call_history' to inspect phone and FaceTime call history, or pass 'include_calls: true' on reading tools to merge call records into conversation timelines.
9. Index Status: Call 'imessage_index_status' to inspect local search index statistics, sync freshness, and lag.
10. Documentation: Call 'imessage_get_readme' or read resource 'resource://readme' to inspect server configuration and usage.
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
      'Read recent message history from a specific iMessage chat. `chat` (alias `chat_id`) is the numeric chat ROWID from imessage_list_chats, or a display name, phone number, or email. Messages include ISO-8601 timestamps, reply context (reply_to with parent msg_id, guid, sender, text), delivery status (is_delivered, delivered_at, delivered_at_iso), quiet/focus delivery status (delivered_quietly, was_delivered_quietly, notifications_silenced, did_notify_recipient), read status (is_read, read_at, read_at_iso), link previews (url, title, subtitle, artist, site_name), structured tapbacks, voice note transcriptions, and edit history. Outgoing rows use sender "Me" with an empty handle; the other party is `participant`. Read receipts on outgoing messages only appear when the recipient has enabled read receipts.',
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
      'Full-text search across all historical iMessage conversations, including message text, reply context (reply_to), and voice note audio speech-to-text transcriptions. Returns matching messages, dates, chat IDs, senders, edit state (is_edited, edit_count), and revision history.',
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
        order: {
          type: 'string',
          enum: ['recent', 'relevance'],
          description:
            'Sort order for search results: "recent" (default) sorts by timestamp descending; "relevance" sorts by BM25 match score when the local search index is enabled and caught up.'
        },
        ...chatArgProperties,
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
      'Fetch metadata and base64 payload for an attachment file (converts HEIC photos to JPEG and CAF audio voice notes to M4A for multimodal LLMs, delivering visual image blocks to agents, duration, and on-device speech-to-text transcriptions). Accepts either path or message_id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'POSIX path to attachment file (e.g. "/Users/matthias/Library/Messages/Attachments/.../IMG_4031.png"). Aliases: file, file_path, filepath.'
        },
        file: { type: 'string', description: 'Alias of path.' },
        file_path: { type: 'string', description: 'Alias of path.' },
        filepath: { type: 'string', description: 'Alias of path.' },
        message_id: {
          type: 'integer',
          description: 'Optional numeric message ROWID to look up attachment from chat.db. Aliases: messageId, msg_id, msgId.'
        },
        messageId: { type: 'integer', description: 'Alias of message_id.' },
        msg_id: { type: 'integer', description: 'Alias of message_id.' },
        msgId: { type: 'integer', description: 'Alias of message_id.' },
        deliver_image: {
          type: 'boolean',
          description: 'If the attachment is an image, whether to deliver the visual image block directly to the agent (default true).'
        }
      },
      anyOf: [
        { required: ['path'] },
        { required: ['file'] },
        { required: ['file_path'] },
        { required: ['filepath'] },
        { required: ['message_id'] },
        { required: ['messageId'] },
        { required: ['msg_id'] },
        { required: ['msgId'] }
      ]
    }
  },
  {
    name: 'imessage_download_image',
    description:
      'Download and extract an image attachment from an iMessage by message ID or file path, delivering the visual image block directly to multimodal agents. Converts HEIC photos to JPEG for multimodal LLMs and optionally copies the image to a custom destination output_path.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'integer',
          description: 'The numeric message ROWID containing the image attachment. Aliases: messageId, msg_id, msgId.'
        },
        messageId: { type: 'integer', description: 'Alias of message_id.' },
        msg_id: { type: 'integer', description: 'Alias of message_id.' },
        msgId: { type: 'integer', description: 'Alias of message_id.' },
        path: {
          type: 'string',
          description: 'POSIX path to the image attachment file. Aliases: file, file_path, filepath.'
        },
        file: { type: 'string', description: 'Alias of path.' },
        file_path: { type: 'string', description: 'Alias of path.' },
        filepath: { type: 'string', description: 'Alias of path.' },
        output_path: {
          type: 'string',
          description: 'Optional destination file path where the extracted/converted image should be saved.'
        },
        include_base64: {
          type: 'boolean',
          description: 'Whether to include base64-encoded image data in the response (default true).'
        },
        deliver_image: {
          type: 'boolean',
          description: 'Whether to deliver the visual image block directly to the agent (default true).'
        }
      },
      anyOf: [
        { required: ['message_id'] },
        { required: ['messageId'] },
        { required: ['msg_id'] },
        { required: ['msgId'] },
        { required: ['path'] },
        { required: ['file'] },
        { required: ['file_path'] },
        { required: ['filepath'] }
      ]
    }
  },
  {
    name: 'download_image',
    description:
      'Standard alias for imessage_download_image. Download and extract an image attachment from an iMessage by message ID or file path, delivering the visual image block directly to multimodal agents.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'integer',
          description: 'The numeric message ROWID containing the image attachment. Aliases: messageId, msg_id, msgId.'
        },
        messageId: { type: 'integer', description: 'Alias of message_id.' },
        msg_id: { type: 'integer', description: 'Alias of message_id.' },
        msgId: { type: 'integer', description: 'Alias of message_id.' },
        path: {
          type: 'string',
          description: 'POSIX path to the image attachment file. Aliases: file, file_path, filepath.'
        },
        file: { type: 'string', description: 'Alias of path.' },
        file_path: { type: 'string', description: 'Alias of path.' },
        filepath: { type: 'string', description: 'Alias of path.' },
        output_path: {
          type: 'string',
          description: 'Optional destination file path where the extracted/converted image should be saved.'
        },
        include_base64: {
          type: 'boolean',
          description: 'Whether to include base64-encoded image data in the response (default true).'
        },
        deliver_image: {
          type: 'boolean',
          description: 'Whether to deliver the visual image block directly to the agent (default true).'
        }
      },
      anyOf: [
        { required: ['message_id'] },
        { required: ['messageId'] },
        { required: ['msg_id'] },
        { required: ['msgId'] },
        { required: ['path'] },
        { required: ['file'] },
        { required: ['file_path'] },
        { required: ['filepath'] }
      ]
    }
  },
  {
    name: 'imessage_send_message',
    description:
      'Send an outbound iMessage to a recipient or existing group chat thread using AppleScript or imsg on macOS. Supports text message body and attachments (local Mac POSIX file paths, remote HTTPS URLs, or base64 data). Supports dry_run safety previews with attachment existence, size, and MIME type verification.',
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
          description:
            'Optional file attachment to send. Accepts: (1) Local POSIX file path on the Mac (e.g. "/Users/shared/Pictures/sandworm.jpg" or "~/Downloads/flower.jpg"), (2) Remote HTTPS/HTTP URL (e.g. "https://example.com/flower.jpg") which the server automatically fetches to a temporary file, or (3) Base64 encoded file data (Data URI "data:image/jpeg;base64,..." or raw base64 string). In dry_run preview, confirms file existence, size, and MIME type.'
        },
        dry_run: {
          type: 'boolean',
          description:
            'If true, returns a structured safety preview object and confirmation token without sending (default: false). Verifies that attachments exist and are reachable, and returns attachment size and MIME type.'
        },
        confirm_token: {
          type: 'string',
          description: 'Confirmation token returned by a previous dry_run preview call to authorize dispatch.'
        },
        effect: {
          type: 'string',
          description:
            'Optional Apple expressive send effect style. Bubble effects: "slam", "loud", "gentle", "invisible_ink". Screen effects: "echo", "spotlight", "balloons", "confetti", "love", "lasers", "fireworks", "shooting_star", "celebration".',
          enum: [
            'slam',
            'loud',
            'gentle',
            'invisible_ink',
            'echo',
            'spotlight',
            'balloons',
            'confetti',
            'love',
            'lasers',
            'fireworks',
            'shooting_star',
            'celebration'
          ]
        },
        schedule_at: {
          type: 'string',
          description:
            'Optional future ISO timestamp or relative offset (e.g. "2026-10-07T12:00:00Z", "+15m", "+2h", "+1d") to schedule message delivery for later. Aliases: scheduled_at, send_at, delay.'
        },
        scheduled_at: { type: 'string', description: 'Alias of schedule_at.' },
        send_at: { type: 'string', description: 'Alias of schedule_at.' },
        delay: { type: 'string', description: 'Alias of schedule_at.' }
      },
      required: ['recipient']
    }
  },
  {
    name: 'imessage_list_scheduled_messages',
    description:
      'List all currently pending and recent scheduled iMessages queued for future delivery. Returns scheduled ID, target recipient, scheduled delivery timestamp, effect, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'sent', 'canceled', 'all'],
          description: 'Filter scheduled messages by status (default: all).'
        }
      }
    }
  },
  {
    name: 'imessage_cancel_scheduled_message',
    description:
      'Cancel a scheduled iMessage before it is sent using its scheduled_message_id.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: {
          type: 'string',
          description: 'The unique scheduled message identifier to cancel (e.g. sched_...). Aliases: id, scheduled_message_id.'
        },
        id: { type: 'string', description: 'Alias of schedule_id.' },
        scheduled_message_id: { type: 'string', description: 'Alias of schedule_id.' }
      },
      anyOf: [
        { required: ['schedule_id'] },
        { required: ['id'] },
        { required: ['scheduled_message_id'] }
      ]
    }
  },
  {
    name: 'imessage_get_recent_messages',
    description:
      'Preview the last N messages in a chat, or poll for rows newer than since_msg_id. `chat` (alias `chat_id`) is the numeric chat ROWID from imessage_list_chats (`rowid` / `chat_id`), or a display name, phone number, or email. Results include ISO timestamps, reply context (reply_to with parent msg_id, guid, sender, text), delivery status (is_delivered, delivered_at, delivered_at_iso), quiet/focus delivery status (delivered_quietly, was_delivered_quietly, notifications_silenced, did_notify_recipient), read status (is_read, read_at, read_at_iso), link previews, and structured tapbacks (not as Loved/Liked text). Outgoing rows use sender "Me" with an empty handle and a separate `participant`. Pass with_meta to get filtered counts and next_since_msg_id. Read receipts on outgoing messages only appear when the recipient has enabled read receipts.',
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
    name: 'imessage_index_status',
    description:
      'Inspect the status of the local search index, including total indexed messages, indexed attachments, indexed contacts, database file size, last indexed message ID, and sync lag behind chat.db.',
    inputSchema: {
      type: 'object',
      properties: {}
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
  },
  {
    name: 'list_chats',
    description:
      'List active iMessage chats and conversations (universal alias for imessage_list_chats). Returns chat ROWIDs (`rowid` and `chat_id`), display names, contact identifiers, and recent activity order.',
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
    name: 'list_messages',
    description:
      'Read recent message history from a specific iMessage chat (universal alias for imessage_read_messages). Returns messages in strict chronological order.',
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
    name: 'send_message',
    description:
      'Send an outbound iMessage to a recipient or existing chat thread (universal alias for imessage_send_message). Supports text and attachments (local POSIX file paths, remote HTTPS URLs, or base64 data).',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: "Target recipient phone number, email address, group chat display name, or numeric chat ROWID. Alias: to."
        },
        to: { type: 'string', description: 'Alias of recipient.' },
        message: { type: 'string', description: 'Optional text content of the iMessage to send.' },
        attachment: {
          type: 'string',
          description:
            'Optional file attachment to send. Accepts: (1) Local POSIX file path on the Mac (e.g. "/Users/shared/Pictures/sandworm.jpg" or "~/Downloads/flower.jpg"), (2) Remote HTTPS/HTTP URL (e.g. "https://example.com/flower.jpg") which the server automatically fetches to a temporary file, or (3) Base64 encoded file data (Data URI "data:image/jpeg;base64,..." or raw base64 string). In dry_run preview, confirms file existence, size, and MIME type.'
        },
        dry_run: {
          type: 'boolean',
          description:
            'If true, returns a structured safety preview object and confirmation token without sending. Verifies that attachments exist and are reachable, and returns attachment size and MIME type.'
        },
        confirm_token: { type: 'string', description: 'Confirmation token returned by dry_run.' },
        effect: {
          type: 'string',
          description:
            'Optional Apple expressive send effect style. Bubble effects: "slam", "loud", "gentle", "invisible_ink". Screen effects: "echo", "spotlight", "balloons", "confetti", "love", "lasers", "fireworks", "shooting_star", "celebration".',
          enum: [
            'slam',
            'loud',
            'gentle',
            'invisible_ink',
            'echo',
            'spotlight',
            'balloons',
            'confetti',
            'love',
            'lasers',
            'fireworks',
            'shooting_star',
            'celebration'
          ]
        },
        schedule_at: {
          type: 'string',
          description:
            'Optional future ISO timestamp or relative offset (e.g. "2026-10-07T12:00:00Z", "+15m", "+2h", "+1d") to schedule message delivery for later. Aliases: scheduled_at, send_at, delay.'
        },
        scheduled_at: { type: 'string', description: 'Alias of schedule_at.' },
        send_at: { type: 'string', description: 'Alias of schedule_at.' },
        delay: { type: 'string', description: 'Alias of schedule_at.' }
      },
      required: ['recipient']
    }
  },
  {
    name: 'list_scheduled_messages',
    description:
      'Universal alias for imessage_list_scheduled_messages. List all currently pending and recent scheduled iMessages queued for future delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'sent', 'canceled', 'all'],
          description: 'Filter scheduled messages by status (default: all).'
        }
      }
    }
  },
  {
    name: 'cancel_scheduled_message',
    description:
      'Universal alias for imessage_cancel_scheduled_message. Cancel a scheduled iMessage before it is sent using its scheduled_message_id.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: {
          type: 'string',
          description: 'The unique scheduled message identifier to cancel (e.g. sched_...). Aliases: id, scheduled_message_id.'
        },
        id: { type: 'string', description: 'Alias of schedule_id.' },
        scheduled_message_id: { type: 'string', description: 'Alias of schedule_id.' }
      },
      anyOf: [
        { required: ['schedule_id'] },
        { required: ['id'] },
        { required: ['scheduled_message_id'] }
      ]
    }
  },
  {
    name: 'get_recent_messages',
    description:
      'Get the most recent messages across conversations or from a specific chat (universal alias for imessage_get_recent_messages). Returns messages in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        ...chatArgProperties,
        limit: {
          type: 'number',
          description: 'Number of recent messages to preview (default: 20, max: 50).'
        },
        count: { type: 'number', description: 'Alias of limit.' },
        max: { type: 'number', description: 'Alias of limit.' },
        ...readWindowProperties
      }
    }
  },
  {
    name: 'search_messages',
    description:
      'Full-text search across all historical iMessage conversations (universal alias for imessage_search_messages), including message text, reply context, and voice note transcriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword or phrase. Aliases: q, search.' },
        q: { type: 'string', description: 'Alias of query.' },
        search: { type: 'string', description: 'Alias of query.' },
        limit: { type: 'number', description: 'Maximum number of matching results (default: 30).' },
        count: { type: 'number', description: 'Alias of limit.' },
        max: { type: 'number', description: 'Alias of limit.' },
        order: { type: 'string', enum: ['recent', 'relevance'], description: 'Sort order.' },
        ...chatArgProperties,
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
    name: 'search_contacts',
    description:
      'Search macOS AddressBook contacts by name, phone number, or email address (universal alias for imessage_search_contacts).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Contact search term.' }
      }
    }
  },
  {
    name: 'resolve_contact',
    description:
      'Resolve a contact across platforms (iMessage, WhatsApp, Instagram) using the Unified Contact Identity Graph. Returns canonical display name and all known platform identities (phone numbers, handles, emails).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Contact name, phone number, email address, or username to search.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'link_contact_identity',
    description:
      'Link a platform identity (phone, email, Instagram username, WhatsApp JID) to a contact in the Unified Identity Graph.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact display name.' },
        platform: { type: 'string', description: 'Platform name (imessage, whatsapp, instagram, etc.).' },
        identifier: { type: 'string', description: 'Identifier value (phone number, username, email, JID).' },
        identifier_type: { type: 'string', description: 'Optional identifier type (phone, email, username, jid, lid).' }
      },
      required: ['name', 'platform', 'identifier']
    }
  },
  {
    name: 'get_last_interaction',
    description:
      'Get the most recent direct message interaction with a specific contact or chat. Answers: "When did I last speak with user X and what was said?"',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Contact display name, phone number, or email.' },
        ...chatArgProperties
      }
    }
  },
  {
    name: 'get_message_context',
    description:
      'Get surrounding context (messages before and after) around a specific message ROWID in a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Target message ROWID.' },
        before: { type: 'number', description: 'Number of preceding messages (default 5).' },
        after: { type: 'number', description: 'Number of following messages (default 5).' },
        ...chatArgProperties
      },
      required: ['message_id']
    }
  }
];

export interface ResolvedAttachment {
  path: string;
  size: number;
  mimeType: string;
  source: 'local' | 'url' | 'base64';
}

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.caf': 'audio/x-caf'
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/x-caf': '.caf'
};

export function detectMimeFromBuffer(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === 'GIF8') {
    return { mime: 'image/gif', ext: '.gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF') {
    return { mime: 'application/pdf', ext: '.pdf' };
  }
  if (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) {
      return { mime: 'image/heic', ext: '.heic' };
    }
    return { mime: 'audio/mp4', ext: '.m4a' };
  }
  if (buffer.length >= 3 && buffer.slice(0, 3).toString('ascii') === 'ID3') {
    return { mime: 'audio/mpeg', ext: '.mp3' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { mime: 'audio/mpeg', ext: '.mp3' };
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { mime: 'audio/wav', ext: '.wav' };
  }
  return null;
}

function getAttachmentTempDir(): string {
  const dir = path.join(os.tmpdir(), 'imessage-attachments');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function resolveLocalPath(inputPath: string): ResolvedAttachment {
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const resolved = path.resolve(expanded);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Attachment file not found at "${inputPath}"`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Attachment path "${inputPath}" is not a regular file`);
  }

  const ext = path.extname(resolved).toLowerCase();
  let mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    try {
      const headerBuf = Buffer.alloc(32);
      const fd = fs.openSync(resolved, 'r');
      const bytesRead = fs.readSync(fd, headerBuf, 0, 32, 0);
      fs.closeSync(fd);
      const detected = detectMimeFromBuffer(headerBuf.slice(0, bytesRead));
      mimeType = detected?.mime || 'application/octet-stream';
    } catch {
      mimeType = 'application/octet-stream';
    }
  }

  return {
    path: resolved,
    size: stat.size,
    mimeType,
    source: 'local'
  };
}

function resolveBase64Attachment(base64Str: string, explicitMime?: string): ResolvedAttachment {
  const cleaned = base64Str.replace(/\s+/g, '');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) {
    throw new Error('Invalid or empty base64 attachment data');
  }

  const detected = detectMimeFromBuffer(buffer);
  const mimeType = explicitMime || detected?.mime || 'application/octet-stream';
  const ext = detected?.ext || MIME_TO_EXT[mimeType] || '.bin';

  const tempDir = getAttachmentTempDir();
  const filename = `b64_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const tempPath = path.join(tempDir, filename);
  fs.writeFileSync(tempPath, buffer, { mode: 0o600 });

  return {
    path: tempPath,
    size: buffer.length,
    mimeType,
    source: 'base64'
  };
}

export async function resolveAttachment(attachmentInput: unknown): Promise<ResolvedAttachment> {
  if (!attachmentInput) {
    throw new Error('No attachment specified');
  }

  if (typeof attachmentInput === 'object' && attachmentInput !== null) {
    const obj = attachmentInput as Record<string, unknown>;
    if (typeof obj.url === 'string') {
      return await resolveAttachment(obj.url);
    }
    if (typeof obj.data === 'string' || typeof obj.base64 === 'string') {
      const b64 = (obj.data || obj.base64) as string;
      const mime =
        typeof obj.mime_type === 'string'
          ? obj.mime_type
          : typeof obj.type === 'string'
            ? obj.type
            : undefined;
      return resolveBase64Attachment(b64, mime);
    }
    if (typeof obj.path === 'string' || typeof obj.file === 'string') {
      return await resolveAttachment((obj.path || obj.file) as string);
    }
  }

  if (typeof attachmentInput !== 'string') {
    throw new Error(`Unsupported attachment input type: ${typeof attachmentInput}`);
  }

  const raw = attachmentInput.trim();
  if (!raw) {
    throw new Error('Attachment path or data is empty');
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Invalid attachment URL: "${raw}"`);
    }

    try {
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        throw new Error(`Failed to download attachment from URL "${raw}": HTTP ${res.status} ${res.statusText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        throw new Error(`Downloaded attachment from URL "${raw}" is empty (0 bytes)`);
      }

      const contentTypeHeader = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const detected = detectMimeFromBuffer(buffer);
      const mimeType =
        contentTypeHeader && contentTypeHeader !== 'application/octet-stream'
          ? contentTypeHeader
          : detected?.mime || 'application/octet-stream';

      const urlPathExt = path.extname(url.pathname).toLowerCase();
      const ext = urlPathExt || detected?.ext || MIME_TO_EXT[mimeType] || '.bin';

      const tempDir = getAttachmentTempDir();
      const filename = `url_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const tempPath = path.join(tempDir, filename);
      fs.writeFileSync(tempPath, buffer, { mode: 0o600 });

      return {
        path: tempPath,
        size: buffer.length,
        mimeType,
        source: 'url'
      };
    } catch (err: any) {
      if (err.message && err.message.startsWith('Failed to download attachment')) {
        throw err;
      }
      throw new Error(`Failed to download attachment from URL "${raw}": ${err.message || String(err)}`);
    }
  }

  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,(.*)$/is);
    if (!match) {
      throw new Error('Malformed data URI for attachment');
    }
    const explicitMime = match[1] ? match[1].toLowerCase().trim() : undefined;
    const base64Data = match[2];
    return resolveBase64Attachment(base64Data, explicitMime);
  }

  const isExplicitPath = raw.startsWith('~') || raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../');
  if (!isExplicitPath) {
    const localRel = path.resolve(raw);
    if (fs.existsSync(localRel)) {
      return resolveLocalPath(localRel);
    }

    const cleaned = raw.replace(/\s+/g, '');
    const isBase64Charset = /^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length >= 8 && cleaned.length % 4 === 0;
    if (isBase64Charset) {
      try {
        const buffer = Buffer.from(cleaned, 'base64');
        const detected = detectMimeFromBuffer(buffer);
        if (detected || cleaned.length > 64) {
          return resolveBase64Attachment(cleaned, detected?.mime);
        }
      } catch {
        // Fall through to local path resolution
      }
    }
  }

  return resolveLocalPath(raw);
}

export interface PendingSend {
  recipient: string;
  message: string;
  attachment: string;
  attachmentInfo?: ResolvedAttachment;
  effect?: string;
  scheduleAt?: string;
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
    return await executeToolCall(request.params.name, request.params.arguments as any, ctx);
  });

  return server;
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx?: any
): Promise<{
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  )[];
  isError?: boolean;
}> {
  const startTime = Date.now();
  let targetParam: string | undefined = undefined;
  let dryRunParam: boolean | undefined = undefined;

  const toolArgs = args as Record<string, unknown> | undefined;

  const nameMap: Record<string, string> = {
    list_chats: 'imessage_list_chats',
    list_messages: 'imessage_read_messages',
    send_message: 'imessage_send_message',
    get_recent_messages: 'imessage_get_recent_messages',
    search_messages: 'imessage_search_messages',
    search_contacts: 'imessage_search_contacts',
    list_scheduled_messages: 'imessage_list_scheduled_messages',
    list_scheduled: 'imessage_list_scheduled_messages',
    cancel_scheduled_message: 'imessage_cancel_scheduled_message',
    cancel_scheduled: 'imessage_cancel_scheduled_message',
  };
  const effectiveName = nameMap[name] || name;

  if (effectiveName === 'imessage_send_message') {
    targetParam = readStringArg(toolArgs, ['recipient', 'to', 'confirm_token']);
    dryRunParam = Boolean(args?.dry_run);
  } else if (effectiveName === 'imessage_read_messages' || effectiveName === 'imessage_get_recent_messages' || effectiveName === 'imessage_get_chat_members') {
    targetParam = readChatArg(toolArgs);
  } else if (effectiveName === 'imessage_search_messages' || effectiveName === 'imessage_search_contacts' || effectiveName === 'resolve_contact') {
    targetParam = readStringArg(toolArgs, ['query', 'q', 'search', 'name']);
  } else if (effectiveName === 'imessage_get_attachment_payload' || effectiveName === 'imessage_download_image' || effectiveName === 'download_image') {
    targetParam = readStringArg(toolArgs, ['path', 'file', 'file_path', 'filePath', 'filepath']) ||
      readStringArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
  } else if (effectiveName === 'imessage_get_edit_history' || effectiveName === 'imessage_edit_message' || effectiveName === 'get_message_context') {
    targetParam = readStringArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
  } else if (effectiveName === 'imessage_get_call_history' || effectiveName === 'get_last_interaction') {
    targetParam = readStringArg(toolArgs, ['handle', 'contact', 'recipient', 'phone', 'email', 'chat', 'chat_id']);
  } else if (effectiveName === 'imessage_cancel_scheduled_message') {
    targetParam = readStringArg(toolArgs, ['schedule_id', 'id', 'scheduled_message_id']);
  }

  try {
    let result: {
      content: (
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      )[];
      isError?: boolean;
    };
    if (effectiveName === 'imessage_get_readme') {
      const readmePath = path.resolve(__dir, '../README.md');
      const content = await fs.promises.readFile(readmePath, 'utf8');
      result = {
        content: [{ type: 'text', text: content }]
      };
    } else if (effectiveName === 'imessage_index_status') {
      const stdout = await runImessageCli(['index', 'status', '--json']);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_list_chats') {
      const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 30, 1, 100);
      const stdout = await runImessageCli(['list', '--limit', String(limit), '--json']);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_read_messages') {
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
    } else if (effectiveName === 'imessage_search_messages') {
      const query = readStringArg(toolArgs, ['query', 'q', 'search']);
      const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 30, 1, 100);
      if (!query) {
        throw new Error('Missing required parameter "query"');
      }
      const order = readStringArg(toolArgs, ['order']);
      const chat = readChatArg(toolArgs);
      const cliArgs = ['search', query, '--limit', String(limit), '--json'];
      if (order) {
        if (order !== 'recent' && order !== 'relevance') {
          throw new Error('Invalid parameter "order" (expected "recent" or "relevance")');
        }
        cliArgs.push('--order', order);
      }
      if (chat) {
        cliArgs.push('--chat', chat);
      }
      appendPresentationArgs(cliArgs, toolArgs);
      const stdout = await runImessageCli(cliArgs);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_search_contacts') {
      const query = readStringArg(toolArgs, ['query', 'q', 'search']);
      const stdout = await runImessageCli(['contacts', query, '--json']);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'resolve_contact') {
      const query = readStringArg(toolArgs, ['query', 'name', 'q', 'contact']);
      if (!query) {
        throw new Error('Missing required parameter "query"');
      }
      const record = identityGraph.resolveContact(query);
      result = {
        content: [{ type: 'text', text: JSON.stringify(record, null, 2) }]
      };
    } else if (effectiveName === 'link_contact_identity') {
      const contactName = readStringArg(toolArgs, ['name', 'display_name', 'contact']);
      const platform = readStringArg(toolArgs, ['platform']);
      const identifier = readStringArg(toolArgs, ['identifier', 'value', 'phone', 'email', 'username', 'jid']);
      const identifierType = readStringArg(toolArgs, ['identifier_type', 'type']);
      if (!contactName || !platform || !identifier) {
        throw new Error('Missing required parameters: "name", "platform", and "identifier" must be provided');
      }
      const record = identityGraph.linkContactIdentity(contactName, platform, identifier, identifierType || undefined);
      result = {
        content: [{ type: 'text', text: JSON.stringify(record, null, 2) }]
      };
    } else if (effectiveName === 'get_last_interaction') {
      let chat = readChatArg(toolArgs);
      const contact = readStringArg(toolArgs, ['contact', 'name', 'recipient', 'handle', 'phone', 'email']);
      if (!chat && contact) {
        const idRecord = identityGraph.resolveContact(contact);
        if (idRecord) {
          const phoneIdent = idRecord.identities.find(i => i.platform === 'imessage' || i.identifierType === 'phone');
          if (phoneIdent) {
            chat = phoneIdent.identifierValue;
          }
        }
        if (!chat) {
          chat = contact;
        }
      }
      if (!chat) {
        throw new Error('Either chat (chat_id) or contact must be provided');
      }

      const cliArgs = ['recent', chat, '--limit', '5', '--json'];
      appendPresentationArgs(cliArgs, toolArgs);
      const stdout = await runImessageCli(cliArgs);
      let msgs: any[] = [];
      try {
        const parsed = JSON.parse(stdout);
        msgs = Array.isArray(parsed) ? parsed : (parsed.messages || []);
      } catch (e) {}

      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const responseData = {
        success: true,
        chat_id: chat,
        contact: contact || null,
        last_interaction_timestamp: lastMsg?.date || lastMsg?.timestamp || null,
        last_message: lastMsg,
        recent_context: msgs
      };
      result = {
        content: [{ type: 'text', text: JSON.stringify(responseData, null, 2) }]
      };
    } else if (effectiveName === 'get_message_context') {
      const chat = readChatArg(toolArgs);
      const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId', 'id']);
      const before = clampInt(readIntArg(toolArgs, ['before']), 5, 0, 50);
      const after = clampInt(readIntArg(toolArgs, ['after']), 5, 0, 50);

      if (messageId === undefined) {
        throw new Error('Missing required parameter "message_id"');
      }

      const cliArgs = ['read', chat || '1', '--days', '365', '--json'];
      appendPresentationArgs(cliArgs, toolArgs);
      const stdout = await runImessageCli(cliArgs);
      let msgs: any[] = [];
      try {
        const parsed = JSON.parse(stdout);
        msgs = Array.isArray(parsed) ? parsed : (parsed.messages || []);
      } catch (e) {}

      let targetIdx = -1;
      for (let i = 0; i < msgs.length; i++) {
        if (Number(msgs[i].id) === messageId || Number(msgs[i].rowid) === messageId) {
          targetIdx = i;
          break;
        }
      }

      if (targetIdx === -1) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  message: `Message '${messageId}' not found in the fetched thread window.`
                },
                null,
                2
              )
            }
          ]
        };
      } else {
        const startIdx = Math.max(0, targetIdx - before);
        const endIdx = Math.min(msgs.length, targetIdx + after + 1);
        const contextMsgs = msgs.slice(startIdx, endIdx);

        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  chat_id: chat,
                  target_message_id: messageId,
                  target_index: targetIdx - startIdx,
                  messages: contextMsgs
                },
                null,
                2
              )
            }
          ]
        };
      }
    } else if (effectiveName === 'imessage_get_recent_messages') {
      let chat = readChatArg(toolArgs);
      const limit = clampInt(readIntArg(toolArgs, ['limit', 'count', 'max']), 5, 1, 50);
      if (!chat) {
        try {
          const listStdout = await runImessageCli(['list', '--limit', '1', '--json']);
          const listParsed = JSON.parse(listStdout);
          const chats = Array.isArray(listParsed) ? listParsed : (listParsed.chats || []);
          if (chats.length > 0) {
            chat = String(chats[0].rowid || chats[0].chat_id || chats[0].id || '');
          }
        } catch (e) {}
      }
      if (!chat) {
        throw new Error(MISSING_CHAT);
      }
      const cliArgs = ['recent', chat, '--limit', String(limit), '--json'];
      appendPresentationArgs(cliArgs, toolArgs);
      const stdout = await runImessageCli(cliArgs);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_search_group_chats') {
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
    } else if (effectiveName === 'imessage_get_chat_members') {
      const chat = readChatArg(toolArgs);
      if (!chat) {
        throw new Error(MISSING_CHAT);
      }
      const stdout = await runImessageCli(['members', chat, '--json']);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_get_attachment_payload') {
      const filePath = readStringArg(toolArgs, ['path', 'file', 'file_path', 'filePath', 'filepath']);
      const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
      const deliverImage = toolArgs?.deliver_image !== false && toolArgs?.deliverImage !== false;
      if (!filePath && messageId === undefined) {
        throw new Error('Missing required parameter: either "path" or "message_id" must be provided');
      }
      const cliArgs = ['attachment', '--json'];
      if (filePath) {
        cliArgs.push('--path', filePath);
      }
      if (messageId !== undefined) {
        cliArgs.push('--message-id', String(messageId));
      }
      const stdout = await runImessageCli(cliArgs);
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }

      const content: (
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      )[] = [{ type: 'text', text: stdout }];

      if (deliverImage && parsed && typeof parsed.base64 === 'string') {
        const mimeType = String(parsed.mime_type || parsed.mimeType || '');
        if (mimeType.startsWith('image/')) {
          content.push({
            type: 'image',
            data: parsed.base64,
            mimeType
          });
        }
      }

      result = { content };
    } else if (effectiveName === 'imessage_download_image' || effectiveName === 'download_image') {
      const filePath = readStringArg(toolArgs, ['path', 'file', 'file_path', 'filePath', 'filepath']);
      const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
      const outputPath = readStringArg(toolArgs, ['output_path', 'outputPath', 'destination']);
      const includeBase64 = toolArgs?.include_base64 !== false && toolArgs?.includeBase64 !== false;
      const deliverImage = toolArgs?.deliver_image !== false && toolArgs?.deliverImage !== false;

      if (!filePath && messageId === undefined) {
        throw new Error('Missing required parameter: either "message_id" or "path" must be provided');
      }
      const cliArgs = ['download-image', '--json'];
      if (filePath) {
        cliArgs.push('--path', filePath);
      }
      if (messageId !== undefined) {
        cliArgs.push('--message-id', String(messageId));
      }
      if (outputPath) {
        cliArgs.push('--output-path', outputPath);
      }
      if (!includeBase64 && !deliverImage) {
        cliArgs.push('--no-base64');
      }
      const stdout = await runImessageCli(cliArgs);
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }

      let textOutput = stdout;
      if (!includeBase64 && parsed && parsed.base64) {
        const stripped = { ...parsed };
        delete stripped.base64;
        textOutput = JSON.stringify(stripped, null, 2);
      }

      const content: (
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      )[] = [{ type: 'text', text: textOutput }];

      if (deliverImage && parsed && typeof parsed.base64 === 'string') {
        const mimeType = String(parsed.mime_type || parsed.mimeType || 'image/jpeg');
        content.push({
          type: 'image',
          data: parsed.base64,
          mimeType
        });
      }

      result = { content };
    } else if (effectiveName === 'imessage_get_edit_history') {
      const messageId = readIntArg(toolArgs, ['message_id', 'messageId', 'msg_id', 'msgId']);
      if (messageId === undefined || messageId <= 0) {
        throw new Error('Missing or invalid required parameter "message_id" (positive integer ROWID expected)');
      }
      const stdout = await runImessageCli(['edits', String(messageId), '--json']);
      result = {
        content: [{ type: 'text', text: stdout }]
      };
    } else if (effectiveName === 'imessage_edit_message') {
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
    } else if (effectiveName === 'imessage_get_call_history') {
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
    } else if (effectiveName === 'imessage_send_message') {
      const dryRun = Boolean(args?.dry_run);
      const confirmToken = String(args?.confirm_token || '').trim();

      let recipient = readStringArg(toolArgs, ['recipient', 'to']);
      let message = String(args?.message || '').trim();
      const rawAttachment =
        toolArgs?.attachment ??
        toolArgs?.attachment_url ??
        toolArgs?.image_url ??
        toolArgs?.attachment_data ??
        toolArgs?.file ??
        toolArgs?.file_path;

      const rawEffect = readStringArg(toolArgs, ['effect']);
      let normalizedEffect = rawEffect ? normalizeEffect(rawEffect) : null;
      let effect = normalizedEffect ? normalizedEffect.name : undefined;

      const rawScheduleAt = readStringArg(toolArgs, ['schedule_at', 'scheduled_at', 'send_at', 'delay']);
      let targetScheduleDate: Date | null = null;
      if (rawScheduleAt) {
        targetScheduleDate = parseScheduleTime(rawScheduleAt);
      }
      let scheduleAt = targetScheduleDate ? targetScheduleDate.toISOString() : undefined;

      let attachment = '';
      let resolvedAttachment: ResolvedAttachment | null = null;

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
        if (pending.attachmentInfo) {
          resolvedAttachment = pending.attachmentInfo;
        }
        if (pending.effect) {
          effect = pending.effect;
          normalizedEffect = normalizeEffect(effect);
        }
        if (pending.scheduleAt) {
          scheduleAt = pending.scheduleAt;
          targetScheduleDate = new Date(scheduleAt);
        }
      } else if (rawAttachment) {
        resolvedAttachment = await resolveAttachment(rawAttachment);
        attachment = resolvedAttachment.path;
      }

      if (dryRun && !confirmToken) {
        if (!recipient) throw new Error('Missing required parameter "recipient"');
        if (!message && !attachment) {
          throw new Error('Missing content to send: provide "message" and/or "attachment"');
        }
        pruneExpiredConfirmTokens();
        const token = `cf_${crypto.randomBytes(8).toString('hex')}`;
        pendingConfirmTokens.set(token, {
          recipient,
          message,
          attachment,
          attachmentInfo: resolvedAttachment || undefined,
          effect,
          scheduleAt,
          createdAt: Date.now()
        });

        let membersOutput = [];
        try {
          const stdout = await cliRunner.run(['members', recipient, '--json']);
          membersOutput = JSON.parse(stdout);
        } catch {}

        const previewObj = {
          status: "preview",
          dry_run: true,
          target_recipient: recipient,
          message_text: message || null,
          attachment: resolvedAttachment ? resolvedAttachment.path : null,
          attachment_size: resolvedAttachment ? resolvedAttachment.size : null,
          attachment_type: resolvedAttachment ? resolvedAttachment.mimeType : null,
          attachment_info: resolvedAttachment
            ? {
                path: resolvedAttachment.path,
                size: resolvedAttachment.size,
                type: resolvedAttachment.mimeType,
                mime_type: resolvedAttachment.mimeType,
                source: resolvedAttachment.source
              }
            : null,
          participants: membersOutput,
          confirm_token: token,
          instructions: `To dispatch this message, re-call ${name} with confirm_token: "${token}" or dry_run: false.`,
          ...(effect ? { effect, effect_type: normalizedEffect?.type || 'unknown' } : {}),
          ...(scheduleAt ? { scheduled: true, scheduled_for: scheduleAt } : {})
        };

        result = {
          content: [{ type: 'text', text: JSON.stringify(previewObj, null, 2) }]
        };
      } else {
        if (!recipient) {
          throw new Error('Missing required parameter "recipient"');
        }
        if (!message && !attachment) {
          throw new Error('Missing content to send: provide "message" and/or "attachment"');
        }

        if (scheduleAt) {
          const schedRes = await scheduleMessage({
            recipient,
            message: message || undefined,
            attachment: attachment || undefined,
            effect,
            schedule_at: scheduleAt
          });
          result = {
            content: [{ type: 'text', text: JSON.stringify(schedRes, null, 2) }]
          };
        } else {
          const cliArgs = ['send', recipient];
          if (message) cliArgs.push('-m', message);
          if (attachment) cliArgs.push('-a', attachment);
          if (effect) cliArgs.push('--effect', effect);

          const stdout = await cliRunner.run(cliArgs);
          result = {
            content: [{ type: 'text', text: stdout }]
          };
        }
      }
    } else if (effectiveName === 'imessage_list_scheduled_messages') {
      const status = readStringArg(toolArgs, ['status']);
      const list = await listScheduledMessages(status);
      result = {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
      };
    } else if (effectiveName === 'imessage_cancel_scheduled_message') {
      const scheduleId = readStringArg(toolArgs, ['schedule_id', 'id', 'scheduled_message_id']);
      if (!scheduleId) {
        throw new Error('Missing required parameter "schedule_id"');
      }
      const cancelRes = await cancelScheduledMessage(scheduleId);
      result = {
        content: [{ type: 'text', text: JSON.stringify(cancelRes, null, 2) }]
      };
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
    <li><code>imessage_download_image</code>: Download and extract image attachment (converts HEIC to JPEG).</li>
    <li><code>imessage_send_message</code>: Send an iMessage with text and attachments (local Mac POSIX file paths, remote HTTPS URLs, or base64 data, with dry_run safety preview verification).</li>
    <li><code>imessage_get_recent_messages</code>: Preview last N messages, or poll with since_msg_id. chat and chat_id both accept the list ROWID.</li>
    <li><code>imessage_search_group_chats</code>: Find group chats by participant set.</li>
    <li><code>imessage_get_edit_history</code>: Inspect rewrite and edit history of a message by ROWID.</li>
    <li><code>imessage_edit_message</code>: Edit a sent outgoing iMessage within Apple's 15-minute window.</li>
    <li><code>imessage_get_call_history</code>: Retrieve phone and FaceTime call history.</li>
    <li><code>imessage_index_status</code>: Inspect local search index statistics, sync freshness, and lag.</li>
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
    const metaProto = (body.params as any)?._meta?.['io.modelcontextprotocol/protocolVersion'] as string | undefined;
    const clientProto = (body.params as any)?.protocolVersion as string | undefined;
    const requestedVersion = headerProto || metaProto || clientProto;

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
      if (req.headers['mcp-protocol-version'] === '2026-07-28' && !(parsedBody as any)?.params?._meta) {
        delete req.headers['mcp-protocol-version'];
        delete req.headers['Mcp-Protocol-Version'];
      }
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
  // Seed contacts into Unified Contact Identity Graph in background
  runImessageCli(['contacts', '', '--json'])
    .then(stdout => {
      try {
        const contacts = JSON.parse(stdout);
        if (Array.isArray(contacts)) {
          identityGraph.seedContacts(contacts);
          console.log(`[IdentityGraph] Seeded ${contacts.length} contacts from iMessage`);
        }
      } catch (e) {}
    })
    .catch(() => {});
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
