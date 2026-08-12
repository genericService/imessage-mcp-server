// `config.js` must be imported first: it owns dotenv loading, and in ESM an
// imported module body runs before the importer's. Every other module reads
// configuration from it rather than from `process.env` directly.
import { config, getConfigWarnings, PACKAGE_ROOT } from './config.js';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { logAuditEvent, closeAuditLog, getAuditStatus } from './audit.js';
import { runCli, CliError, getRunnerStats } from './runner.js';
import { requireString, optionalString, clampNumber, requireStringArray, coerceBoolean, ValidationError } from './validation.js';
import {
  getOAuthMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleTokenPost,
  verifyJwt,
  getClientRegistry,
  safeEqual,
  startOAuthSweeper,
  stopOAuthSweeper,
  getOAuthStoreStats
} from './oauth.js';

const __dir = PACKAGE_ROOT;
const PORT = config.port;
const AUTH_TOKEN = config.authToken;
const USE_HTTPS = config.useHttps;
const PUBLIC_DOMAIN = config.publicDomain;
const SERVER_VERSION = '1.1.0';
const README_PATH = path.join(PACKAGE_ROOT, 'README.md');

/** Process start time, used for the uptime field on /health. */
const STARTED_AT = Date.now();

/**
 * README is read on nearly every agent session. Cache it in memory with an
 * mtime check so a hot tool call never hits the disk, and so a transient read
 * failure cannot fail the request.
 */
let readmeCache: { content: string; mtimeMs: number } | null = null;

async function loadReadme(): Promise<string> {
  try {
    const stat = await fs.promises.stat(README_PATH);
    if (readmeCache && readmeCache.mtimeMs === stat.mtimeMs) {
      return readmeCache.content;
    }
    const content = await fs.promises.readFile(README_PATH, 'utf8');
    readmeCache = { content, mtimeMs: stat.mtimeMs };
    return content;
  } catch (err: any) {
    if (readmeCache) return readmeCache.content;
    throw new Error(`README.md is unavailable at ${README_PATH}: ${err?.message || err}`);
  }
}

/**
 * 2026-07-28 Model Context Protocol Specification Version
 */
export const SPEC_VERSION = '2026-07-28';

/**
 * Detailed MCP tool definitions for iMessage integration.
 */
const TOOLS: Tool[] = [
  {
    name: 'imessage_list_chats',
    description:
      'List active iMessage chats and conversations. Returns chat ROWIDs, display names, contact identifiers (phone numbers or emails), and recent activity order. Use this tool first to discover chat identifiers before reading or sending messages.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of recent chats to return (default: 30, max: 100).'
        }
      }
    }
  },
  {
    name: 'imessage_read_messages',
    description:
      'Read recent message history from a specific iMessage chat. Accepts a numeric chat ROWID, contact display name, or phone number/email address.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Target chat identifier. Can be a numeric chat ROWID (e.g. "46"), a contact name, or phone number (e.g. "+14802998607").'
        },
        days: {
          type: 'number',
          description: 'Number of past days of message history to retrieve (default: 14).'
        }
      },
      required: ['chat']
    }
  },
  {
    name: 'imessage_search_messages',
    description:
      'Full-text search across all historical iMessage conversations. Returns matching messages, dates, chat IDs, and senders.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or phrase to search for across message history.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching search results to return (default: 30).'
        }
      },
      required: ['query']
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
      'Get members and participants of a specific iMessage chat (useful for group chats).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Chat ROWID or display name to inspect group chat members for.'
        }
      },
      required: ['chat']
    }
  },
  {
    name: 'imessage_get_attachment_payload',
    description:
      'Fetch metadata and base64 payload for an attachment file (converts HEIC photos to JPEG automatically for vision LLM analysis).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'POSIX path to attachment file (e.g. "/Users/matthias/Library/Messages/Attachments/.../IMG_4031.png").'
        }
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
          description: "Target recipient phone number, email address, group chat display name, or numeric chat ROWID (e.g. '+14802998607', 'user@example.com', '46', or 'chat619850043729068762')."
        },
        message: {
          type: 'string',
          description: 'Optional text content of the iMessage to send.'
        },
        attachment: {
          type: 'string',
          description: 'Optional local POSIX file path of an attachment to send (e.g. "/Users/matthias/Pictures/photo.jpg").'
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
      'Preview the last N recent messages from a chat to quickly verify thread context, participants, and conversation topic before sending a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Target chat ROWID, display name, or handle (e.g. "46" or "Sarah").'
        },
        limit: {
          type: 'number',
          description: 'Number of recent messages to preview (default: 5, max: 50).'
        }
      },
      required: ['chat']
    }
  },
  {
    name: 'imessage_search_group_chats',
    description:
      'Search for multi-party group chats matching an exact set of participant names or phone numbers (e.g. ["Sarah", "Susie"]). Returns only threads where all requested participants exist.',
    inputSchema: {
      type: 'object',
      properties: {
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of participant names or phone numbers to match (e.g. ["Sarah", "Susie"]).'
        }
      },
      required: ['participants']
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

/**
 * Pending dry-run confirmations.
 *
 * Previously this Map only ever had entries removed on redemption, so every
 * dry_run that an agent chose not to confirm leaked its recipient and full
 * message text in memory for the life of the process. Entries now expire and
 * the store is capped.
 */
const pendingConfirmTokens = new Map<string, PendingSend>();

function prunePendingConfirmTokens(): void {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmTokens) {
    if (now - pending.createdAt > config.confirmTokenTtlMs) {
      pendingConfirmTokens.delete(token);
    }
  }
  while (pendingConfirmTokens.size > config.maxPendingConfirmTokens) {
    const oldest = pendingConfirmTokens.keys().next();
    if (oldest.done) break;
    pendingConfirmTokens.delete(oldest.value);
  }
}

function issueConfirmToken(pending: PendingSend): string {
  prunePendingConfirmTokens();
  const token = `cf_${crypto.randomBytes(16).toString('hex')}`;
  pendingConfirmTokens.set(token, pending);
  return token;
}

/** Single-use redemption; returns null when unknown or expired. */
function consumeConfirmToken(token: string): PendingSend | null {
  const pending = pendingConfirmTokens.get(token);
  if (!pending) return null;
  pendingConfirmTokens.delete(token);
  if (Date.now() - pending.createdAt > config.confirmTokenTtlMs) {
    return null;
  }
  return pending;
}

/**
 * Creates and configures an instance of the MCP Server.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'imessage-mcp-server',
      version: '1.1.0'
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        },
        resources: {
          subscribe: false,
          listChanged: false
        }
      },
      instructions: `
iMessage MCP Server Instructions:
1. Discovery: Call 'imessage_list_chats' to discover available conversation IDs, display names, and handles.
2. Search: Call 'imessage_search_messages' to search past message history by keyword, or 'imessage_search_contacts' to find contacts.
3. Reading: Call 'imessage_read_messages' using a chat ID or contact identifier to review past messages.
4. Multimodal Attachments: Call 'imessage_get_attachment_payload' to get base64 data for image/file attachments.
5. Sending: Call 'imessage_send_message' to send messages. Confirm recipient details and message text before sending on behalf of the user.
6. Documentation: Call 'imessage_get_readme' or read resource 'resource://readme' to inspect server configuration and usage.
`.trim()
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
      ttlMs: 300000,
      cacheScope: 'client'
    } as any;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'resource://readme',
          name: 'README.md',
          description: 'Full iMessage MCP Server Documentation & Usage Guide',
          mimeType: 'text/markdown'
        }
      ]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
    throw new Error(`Resource not found: ${uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();
    let targetParam: string | undefined = undefined;
    let dryRunParam: boolean | undefined = undefined;

    if (name === 'imessage_send_message') {
      targetParam = String(args?.recipient || args?.confirm_token || '');
      dryRunParam = Boolean(args?.dry_run);
    } else if (name === 'imessage_read_messages' || name === 'imessage_get_recent_messages' || name === 'imessage_get_chat_members') {
      targetParam = String(args?.chat || '');
    } else if (name === 'imessage_search_messages' || name === 'imessage_search_contacts') {
      targetParam = String(args?.query || '');
    } else if (name === 'imessage_get_attachment_payload') {
      targetParam = String(args?.path || '');
    }

    try {
      let result: { content: { type: string; text: string }[]; isError?: boolean };
      if (name === 'imessage_get_readme') {
        const content = await loadReadme();
        result = {
          content: [{ type: 'text', text: content }]
        };
      } else if (name === 'imessage_list_chats') {
        const limit = clampNumber(args?.limit, 'limit', 30, 1, 100);
        const stdout = await runCli(['list', '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_read_messages') {
        const chat = requireString(args?.chat, { field: 'chat', maxLength: 512 });
        const days = clampNumber(args?.days, 'days', 14, 1, 365);
        const stdout = await runCli(['read', chat, '--days', String(days), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_messages') {
        const query = requireString(args?.query, { field: 'query', maxLength: 1024 });
        const limit = clampNumber(args?.limit, 'limit', 30, 1, 100);
        const stdout = await runCli(['search', query, '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_contacts') {
        const query = optionalString(args?.query, 'query', 512);
        const stdout = await runCli(['contacts', query, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_recent_messages') {
        const chat = requireString(args?.chat, { field: 'chat', maxLength: 512 });
        const limit = clampNumber(args?.limit, 'limit', 5, 1, 50);
        const stdout = await runCli(['recent', chat, '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_group_chats') {
        const participants = requireStringArray(args?.participants, 'participants', 25);
        const stdout = await runCli(['search-group', ...participants, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_chat_members') {
        const chat = requireString(args?.chat, { field: 'chat', maxLength: 512 });
        const stdout = await runCli(['members', chat, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_attachment_payload') {
        const filePath = requireString(args?.path, { field: 'path', maxLength: 4096 });
        // Attachments are base64-encoded, so they need the large output cap
        // and a longer timeout (HEIC->JPEG conversion shells out to `sips`).
        const stdout = await runCli(['attachment', filePath, '--json'], {
          timeoutMs: config.attachmentTimeoutMs,
          maxBufferBytes: config.cliMaxBufferBytes
        });
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_send_message') {
        const dryRun = coerceBoolean(args?.dry_run);
        const confirmToken = optionalString(args?.confirm_token, 'confirm_token', 128);

        let recipient = optionalString(args?.recipient, 'recipient', 512);
        let message = optionalString(args?.message, 'message', 20000);
        let attachment = optionalString(args?.attachment, 'attachment', 4096);

        if (confirmToken) {
          const pending = consumeConfirmToken(confirmToken);
          if (!pending) {
            throw new Error(
              `Invalid or expired confirm_token: "${confirmToken}". Confirmation tokens are single-use and expire after ` +
                `${Math.round(config.confirmTokenTtlMs / 60000)} minutes. Run a new dry_run preview or send directly.`
            );
          }
          recipient = pending.recipient;
          message = pending.message;
          attachment = pending.attachment;
        }

        if (dryRun && !confirmToken) {
          if (!recipient) throw new ValidationError('Missing required parameter "recipient".');
          if (!message && !attachment) {
            throw new ValidationError('Provide at least one of "message" or "attachment".');
          }

          const token = issueConfirmToken({ recipient, message, attachment, createdAt: Date.now() });

          // Participant lookup is best-effort context for the preview; a
          // failure here must not fail the whole dry run.
          let membersOutput: unknown = [];
          let participantsError: string | undefined;
          try {
            const stdout = await runCli(['members', recipient, '--json']);
            membersOutput = JSON.parse(stdout);
          } catch (err: any) {
            participantsError = err?.message || String(err);
          }

          const previewObj = {
            status: 'preview',
            dry_run: true,
            target_recipient: recipient,
            message_text: message || null,
            attachment: attachment || null,
            participants: membersOutput,
            participants_error: participantsError,
            confirm_token: token,
            expires_in_seconds: Math.round(config.confirmTokenTtlMs / 1000),
            instructions: `To dispatch this message, re-call imessage_send_message with confirm_token: "${token}" or dry_run: false.`
          };

          result = {
            content: [{ type: 'text', text: JSON.stringify(previewObj, null, 2) }]
          };
        } else {
          if (!recipient) {
            throw new ValidationError('Missing required parameter "recipient".');
          }
          if (!message && !attachment) {
            throw new ValidationError('Provide at least one of "message" or "attachment".');
          }

          const cliArgs = ['send', recipient];
          if (message) cliArgs.push('-m', message);
          if (attachment) cliArgs.push('-a', attachment);

          // Sending drives Messages.app through the GUI, so it gets the
          // longest timeout -- but it still must have one, or a TCC prompt
          // wedges the request (and its MCP session) permanently.
          const stdout = await runCli(cliArgs, { timeoutMs: config.sendTimeoutMs });
          result = {
            content: [{ type: 'text', text: stdout }]
          };
        }
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      logAuditEvent({
        timestamp: new Date().toISOString(),
        client_id: (extra as any)?.user?.sub || 'master-token',
        tool: name,
        target: targetParam,
        dry_run: dryRunParam,
        status: 'success',
        duration_ms: Date.now() - startTime
      });
      return result;
    } catch (error: any) {
      const isValidation = error instanceof ValidationError;
      const isCliFailure = error instanceof CliError;
      const errorCode = isValidation ? 'EVALIDATION' : isCliFailure ? (error as CliError).code : 'EUNKNOWN';
      const message = error?.message || String(error);

      logAuditEvent({
        timestamp: new Date().toISOString(),
        client_id: (extra as any)?.user?.sub || 'master-token',
        tool: name,
        target: targetParam,
        dry_run: dryRunParam,
        status: 'error',
        duration_ms: Date.now() - startTime,
        error_message: message,
        error_code: errorCode
      });

      // Bad model input is expected traffic, not a server fault: log it at a
      // lower level so real incidents stay visible in the logs.
      if (isValidation) {
        console.warn(`[MCP Tool Invalid Input] ${name}: ${message}`);
      } else {
        console.error(`[MCP Tool Error] ${name} (${errorCode}):`, message);
      }

      // Return the failure as tool content rather than throwing. Throwing here
      // surfaces as a transport-level JSON-RPC error, which several clients
      // treat as a fatal session error and disconnect over.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'error',
                tool: name,
                error_code: errorCode,
                message,
                retryable: errorCode === 'ETIMEDOUT' || errorCode === 'EEXIT'
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

const app = express();

/** Set during graceful shutdown; drains traffic instead of dropping it. */
let shuttingDown = false;

// Required for correct client IPs (rate limiting, audit) behind Cloudflare
// Tunnel / Tailscale / any reverse proxy.
if (config.trustProxy) {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');

app.use(cors({
  origin: true,
  credentials: false,
  // Without exposing these, browser-based MCP clients cannot read the session
  // id and silently open a brand new session on every single request.
  exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID', 'Accept'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
}));

// Reject new work while draining so in-flight requests can finish cleanly.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (shuttingDown && req.path !== '/health' && req.path !== '/ready') {
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: 'Server is shutting down', retry_after_seconds: 5 });
    return;
  }
  next();
});

/**
 * Coarse per-IP rate limit. Protects the Python/sqlite subprocess pool from a
 * runaway agent loop and the auth endpoints from credential stuffing.
 */
const globalLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Health/readiness probes run on a tight interval; never throttle them.
  skip: (req) => req.path === '/health' || req.path === '/ready',
  message: { error: 'Too Many Requests' }
});
app.use(globalLimiter);

// Skip express.json for /mcp endpoints so the MCP SDK can stream the raw req.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/mcp')) {
    return next();
  }
  express.json({ limit: config.bodyLimit })(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ extended: true, limit: config.bodyLimit })(req, res, next);
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
 */
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const publicBase = `https://${PUBLIC_DOMAIN}`;
  res.json(getOAuthMetadata(publicBase));
});

app.get('/oauth/authorize', handleAuthorizeGet);
app.post('/oauth/authorize', handleAuthorizePost);
app.post('/oauth/token', handleTokenPost);

const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server; lastAccess: number }>();
const httpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; lastAccess: number }>();

/** Close a session's server/transport without ever throwing. */
async function destroyHttpSession(sessionId: string): Promise<void> {
  const session = httpSessions.get(sessionId);
  if (!session) return;
  httpSessions.delete(sessionId);
  try {
    await session.server.close();
  } catch (err: any) {
    console.error(`[MCP] Error closing HTTP session ${sessionId}:`, err?.message || err);
  }
  try {
    await session.transport.close();
  } catch {
    /* transport may already be closed */
  }
}

async function destroySseSession(sessionId: string): Promise<void> {
  const session = sseSessions.get(sessionId);
  if (!session) return;
  sseSessions.delete(sessionId);
  try {
    await session.server.close();
  } catch (err: any) {
    console.error(`[MCP] Error closing SSE session ${sessionId}:`, err?.message || err);
  }
}

/**
 * Evict the least-recently-used session once a transport hits its cap.
 * Without a ceiling, a client that reconnects on every request (or a scanner)
 * creates unbounded sessions, each holding an MCP Server instance, until the
 * process exhausts memory.
 */
async function evictOldestIfFull(): Promise<void> {
  if (httpSessions.size < config.maxHttpSessions) return;
  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [id, session] of httpSessions) {
    if (session.lastAccess < oldestAt) {
      oldestAt = session.lastAccess;
      oldestId = id;
    }
  }
  if (oldestId) {
    console.warn(`[MCP] Session limit (${config.maxHttpSessions}) reached; evicting LRU session ${oldestId}`);
    await destroyHttpSession(oldestId);
  }
}

// Idle-session sweeper for both transports.
const sessionSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of httpSessions.entries()) {
    if (now - session.lastAccess > config.sessionIdleMs) {
      console.log(`[MCP] Cleaning up inactive Streamable HTTP session: ${sessionId}`);
      void destroyHttpSession(sessionId);
    }
  }
  for (const [sessionId, session] of sseSessions.entries()) {
    if (now - session.lastAccess > config.sessionIdleMs) {
      console.log(`[MCP] Cleaning up inactive SSE session: ${sessionId}`);
      void destroySseSession(sessionId);
    }
  }
}, config.sessionSweepMs);
// Do not keep the event loop alive purely for the sweeper.
sessionSweeper.unref();

startOAuthSweeper();

/**
 * Enhanced Middleware for Bearer Token & OAuth JWT Authentication
 */
/**
 * Tracks repeated auth failures per client IP so a leaked endpoint cannot be
 * brute-forced for the bearer token.
 */
const authFailures = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();

function clientIpOf(req: Request): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  const raw = (config.trustProxy && forwarded) || req.socket.remoteAddress || 'unknown';
  return raw.replace(/^::ffff:/, '');
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstAt > config.authFailLimitWindowMs) {
    authFailures.set(ip, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  entry.count++;
  if (entry.count >= config.authFailLimitMax) {
    entry.blockedUntil = now + config.authFailLimitWindowMs;
    console.warn(`[Auth] Blocking ${ip} after ${entry.count} failed attempts.`);
  }
}

function isAuthBlocked(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) authFailures.delete(ip);
  return false;
}

function clearAuthFailures(ip: string): void {
  authFailures.delete(ip);
}

// Bound the failure map so it cannot grow with spoofed X-Forwarded-For values.
const authFailureSweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (now - entry.firstAt > config.authFailLimitWindowMs && now >= entry.blockedUntil) {
      authFailures.delete(ip);
    }
  }
  if (authFailures.size > 10_000) authFailures.clear();
}, 60_000);
authFailureSweeper.unref();

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (['/', '/health', '/ready', '/discover', '/.well-known/oauth-authorization-server'].includes(req.path) || req.path.startsWith('/oauth/')) {
    return next();
  }

  const ip = clientIpOf(req);
  if (isAuthBlocked(ip)) {
    res.status(429).json({ error: 'Too Many Requests: temporarily blocked after repeated authentication failures' });
    return;
  }

  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    // A missing header is a misconfigured client, not an attack; it should
    // not count toward the brute-force budget.
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header or ?token parameter' });
    return;
  }

  // 1. Static master bearer token. Compared in constant time so response
  //    latency cannot be used to recover the secret byte by byte.
  if (safeEqual(token, AUTH_TOKEN)) {
    (req as any).user = { sub: 'master-token', scope: 'imessage:all' };
    clearAuthFailures(ip);
    return next();
  }

  // 2. Client registry secret token check (e.g. ubuntu-remote).
  const registry = getClientRegistry();
  for (const [clientId, clientSecret] of registry.entries()) {
    if (clientSecret && safeEqual(token, clientSecret)) {
      (req as any).user = { sub: clientId, scope: 'imessage:all' };
      clearAuthFailures(ip);
      return next();
    }
  }

  // 3. Legacy transition token. This value used to be hardcoded in source --
  //    a full-access credential committed to git. It is now supplied via the
  //    LEGACY_TOKEN env var so existing clients keep working while the secret
  //    lives outside the repository. Remove it once clients are migrated.
  if (config.legacyToken && safeEqual(token, config.legacyToken)) {
    (req as any).user = { sub: 'legacy-token', scope: 'imessage:all' };
    clearAuthFailures(ip);
    return next();
  }

  // 4. OAuth 2.0 JWT verification.
  const jwtPayload = verifyJwt(token);
  if (jwtPayload) {
    (req as any).user = jwtPayload;
    clearAuthFailures(ip);
    return next();
  }

  recordAuthFailure(ip);
  res.status(403).json({ error: 'Forbidden: Invalid bearer token or expired OAuth JWT' });
}

/**
 * Root discovery HTML / documentation page.
 */
app.get('/', (_req, res) => {
  const publicBase = `https://${PUBLIC_DOMAIN}`;
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
  </ul>
</body>
</html>
  `);
});

/**
 * Health check endpoint.
 */
app.get('/health', (_req, res) => {
  const runner = getRunnerStats();
  res.json({
    status: 'ok',
    server: 'imessage-mcp-server',
    version: SERVER_VERSION,
    mcpProtocolVersion: SPEC_VERSION,
    publicDomain: PUBLIC_DOMAIN,
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    activeSseSessions: sseSessions.size,
    activeHttpSessions: httpSessions.size,
    pendingConfirmTokens: pendingConfirmTokens.size,
    cli: { inFlight: runner.inFlight, queued: runner.queued, maxConcurrent: config.maxConcurrentCli },
    oauth: getOAuthStoreStats(),
    audit: getAuditStatus(),
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    warnings: getConfigWarnings(),
    shuttingDown,
    transports: ['sse', 'streamable-http']
  });
});

/**
 * Readiness probe for process supervisors and tunnels. Reports "draining"
 * during graceful shutdown so a load balancer stops sending new traffic
 * before the listener actually closes.
 */
app.get('/ready', (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'draining' });
    return;
  }
  const cliPresent = fs.existsSync(config.cliPath);
  if (!cliPresent) {
    res.status(503).json({ status: 'unhealthy', reason: `iMessage CLI not found at ${config.cliPath}` });
    return;
  }
  res.json({ status: 'ready' });
});

/**
 * Structured discovery JSON endpoint (2026-07-28 Spec Compliant).
 */
app.get('/discover', (_req, res) => {
  const publicBase = `https://${PUBLIC_DOMAIN}`;
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
      oauthMetadata: `${publicBase}/.well-known/oauth-authorization-server`
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
  if (req.body && typeof req.body === 'object') {
    if (req.body.method === 'ping') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({
        jsonrpc: '2.0',
        result: {},
        id: req.body.id ?? 1
      }));
      return;
    }
    if (req.body.method === 'notifications/initialized') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({
        jsonrpc: '2.0',
        result: {},
        id: req.body.id ?? null
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
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error(`[MCP Session Error] ${reqSessionId}:`, err?.message || err);
      // A transport-level throw means this session is no longer trustworthy;
      // tear it down so the client re-initialises cleanly instead of pinning
      // a broken session until the idle sweep.
      void destroyHttpSession(reqSessionId);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', message: err?.message || String(err) });
      } else {
        res.end();
      }
    }
    return;
  }

  // A session id we do not recognise (server restarted, or the session was
  // swept) must be reported as 404 so the client knows to re-initialise,
  // rather than being silently handed a new unrelated session.
  if (reqSessionId) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found or expired. Re-initialize the MCP session.' },
      id: (req.body && (req.body as any).id) ?? null
    });
    return;
  }

  let server: Server | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    await evictOldestIfFull();

    let generatedSessionId: string | undefined;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        generatedSessionId = crypto.randomUUID();
        return generatedSessionId;
      }
    });
    server = createMcpServer();
    await server.connect(transport);

    // Register the session BEFORE handling the request. The transport emits
    // the session id to the client during handleRequest, so a fast client
    // could send its next request before registration completed and get a
    // spurious "session not found".
    let registeredId: string | undefined;
    const preRegister = () => {
      if (generatedSessionId && !registeredId) {
        registeredId = generatedSessionId;
        httpSessions.set(registeredId, { transport: transport!, server: server!, lastAccess: Date.now() });
      }
    };

    // Clean up if the peer closes the connection mid-stream.
    transport.onclose = () => {
      if (registeredId) void destroyHttpSession(registeredId);
    };
    transport.onerror = (err: Error) => {
      console.error('[MCP Transport] Stream error:', err?.message || err);
    };

    await transport.handleRequest(req, res, req.body);
    preRegister();

    if (registeredId) {
      console.log(`[MCP] Registered Streamable HTTP session: ${registeredId} (active: ${httpSessions.size})`);
    } else {
      // Stateless request (no session issued): release resources now so the
      // MCP Server instance is not orphaned for the process lifetime.
      await server.close().catch(() => {});
    }
  } catch (err: any) {
    console.error('[MCP Transport Error]:', err?.message || err);
    // Avoid leaking the server/transport pair when setup failed part-way.
    if (server) await server.close().catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: err?.message || String(err) });
    } else {
      res.end();
    }
  }
});

/**
 * SSE Transport endpoint
 */
app.get('/sse', authMiddleware, async (req, res) => {
  console.log('[MCP] Client connecting to SSE transport...');

  if (sseSessions.size >= config.maxSseSessions) {
    console.warn(`[MCP] Rejecting SSE connection: session limit ${config.maxSseSessions} reached.`);
    res.status(503).json({ error: 'Server busy: maximum SSE session count reached' });
    return;
  }

  // Long-lived stream: disable the socket inactivity timeout, otherwise Node
  // silently destroys an idle SSE connection mid-session.
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  let server: Server | undefined;
  try {
    server = createMcpServer();
    const transport = new SSEServerTransport('/messages', res);

    await server.connect(transport);
    sseSessions.set(transport.sessionId, { transport, server, lastAccess: Date.now() });
    console.log(`[MCP] SSE session established: ${transport.sessionId} (active: ${sseSessions.size})`);

    const cleanup = () => {
      if (!sseSessions.has(transport.sessionId)) return;
      console.log(`[MCP] SSE client disconnected: ${transport.sessionId}`);
      void destroySseSession(transport.sessionId);
    };

    // Cover every disconnect path. Listening only on 'close' missed aborted
    // and errored sockets, leaking the session and its MCP Server instance.
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', (err) => {
      console.error(`[MCP] SSE response error ${transport.sessionId}:`, err?.message || err);
      cleanup();
    });
  } catch (err: any) {
    console.error('[MCP] Failed to establish SSE session:', err?.message || err);
    if (server) await server.close().catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE session', message: err?.message || String(err) });
    } else {
      res.end();
    }
  }
});

app.post('/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query parameter' });
    return;
  }
  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: `No active SSE session for sessionId: ${sessionId}. Reconnect to /sse.` });
    return;
  }
  session.lastAccess = Date.now();
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (err: any) {
    // Previously unguarded: a throw here became an unhandled rejection.
    console.error(`[MCP] Error handling SSE message for ${sessionId}:`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: err?.message || String(err) });
    }
  }
});

/**
 * Express error handler. Must be registered last and take four arguments.
 * Without it, a thrown error inside a route (e.g. a malformed JSON body from
 * `express.json`) produced an unformatted HTML 500 and, in some paths, an
 * unhandled rejection that terminated the process.
 */
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status || err?.statusCode || 500;

  if (err?.type === 'entity.too.large') {
    console.warn(`[HTTP] Payload too large on ${req.method} ${req.path}`);
    if (!res.headersSent) res.status(413).json({ error: 'Payload Too Large', limit: config.bodyLimit });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    console.warn(`[HTTP] Malformed JSON body on ${req.method} ${req.path}`);
    if (!res.headersSent) res.status(400).json({ error: 'Bad Request', message: 'Malformed JSON body' });
    return;
  }

  console.error(`[HTTP Error] ${req.method} ${req.path}:`, err?.message || err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: 'Internal Server Error', message: err?.message || String(err) });
});

// 404 fallback so unknown paths return JSON rather than Express' HTML page.
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

/**
 * Coordinated graceful shutdown.
 *
 * Ordering matters: stop accepting new work, let in-flight requests drain,
 * close MCP sessions (which notifies connected clients), flush the audit log,
 * then exit. A hard timer guarantees the process exits even if a socket
 * refuses to close, so a supervisor restart is never blocked.
 */
export async function shutdown(signal: string, server?: http.Server | https.Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] Received ${signal}, draining connections...`);

  const forceExit = setTimeout(() => {
    console.error('[Shutdown] Grace period elapsed; forcing exit.');
    process.exit(1);
  }, config.shutdownGraceMs);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log('[Shutdown] HTTP listener closed.');
    }

    clearInterval(sessionSweeper);
    clearInterval(authFailureSweeper);
    stopOAuthSweeper();

    const closers = [
      ...Array.from(httpSessions.keys()).map((id) => destroyHttpSession(id)),
      ...Array.from(sseSessions.keys()).map((id) => destroySseSession(id))
    ];
    await Promise.allSettled(closers);
    console.log(`[Shutdown] Closed ${closers.length} MCP session(s).`);

    pendingConfirmTokens.clear();
    await closeAuditLog();
  } catch (err: any) {
    console.error('[Shutdown] Error while draining:', err?.message || err);
  } finally {
    clearTimeout(forceExit);
    console.log('[Shutdown] Complete.');
  }
}

function startServer(): http.Server | https.Server {
  let server: http.Server | https.Server;

  if (USE_HTTPS) {
    const certDir = path.join(PACKAGE_ROOT, 'certs');
    const certPath = process.env.TLS_CERT_PATH || path.join(certDir, 'server.crt');
    const keyPath = process.env.TLS_KEY_PATH || path.join(certDir, 'server.key');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`HTTPS enabled but certificate files not found at ${certPath} and ${keyPath}.`);
      console.error('Generate them with ./scripts/generate-certs.sh, or set USE_HTTPS=false.');
      process.exit(1);
    }

    let options: https.ServerOptions;
    try {
      options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (err: any) {
      console.error(`Failed to read TLS material: ${err?.message || err}`);
      process.exit(1);
    }
    server = https.createServer(options, app);
  } else {
    server = http.createServer(app);
  }

  // Keep-alive must exceed the proxy's idle timeout, and headers timeout must
  // exceed keep-alive, otherwise Node races the proxy and clients see
  // intermittent ECONNRESET / 502s through Cloudflare Tunnel.
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  // 0 disables the per-request timeout: SSE streams are intentionally long-lived.
  server.requestTimeout = 0;

  server.on('clientError', (err: NodeJS.ErrnoException, socket: any) => {
    // Malformed request lines would otherwise surface as noisy uncaught errors.
    if (err?.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
    } else if (err.code === 'EACCES') {
      console.error(`Insufficient privileges to bind port ${PORT}. Use a port above 1024.`);
    } else {
      console.error('[Server Error]', err);
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    const scheme = USE_HTTPS ? 'https' : 'http';
    console.log('=======================================================');
    console.log(`iMessage MCP Server running over ${scheme.toUpperCase()}:`);
    console.log(`  Discovery Page:      ${scheme}://0.0.0.0:${PORT}/`);
    console.log(`  Streamable HTTP:     ${scheme}://0.0.0.0:${PORT}/mcp`);
    console.log(`  SSE Transport:       ${scheme}://0.0.0.0:${PORT}/sse`);
    console.log(`  Health:              ${scheme}://0.0.0.0:${PORT}/health`);
    // Never print the full secret to logs, which are often shipped elsewhere.
    console.log(`  Bearer Token:        ${AUTH_TOKEN.slice(0, 6)}...${AUTH_TOKEN.slice(-4)} (${AUTH_TOKEN.length} chars)`);
    console.log('=======================================================');

    const warnings = getConfigWarnings();
    if (warnings.length) {
      console.warn('[Config] Warnings:');
      for (const warning of warnings) console.warn(`  - ${warning}`);
    }
    if (!fs.existsSync(config.cliPath)) {
      console.warn(`[Config] iMessage CLI not found at ${config.cliPath}; all tools will fail until this is fixed.`);
    }
  });

  return server;
}

if (!config.isTest) {
  const server = startServer();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal, server).then(() => process.exit(0));
    });
  }

  /**
   * Last-resort process guards.
   *
   * These are the difference between "one bad request killed the server" and
   * "one request failed". An unhandled rejection anywhere in the async
   * transport stack terminates a modern Node process by default; here we log
   * it and keep serving. `uncaughtException` is treated as unsafe-to-continue
   * and triggers a clean drain so a supervisor can restart from a known state.
   */
  process.on('unhandledRejection', (reason: any) => {
    console.error('[UnhandledRejection]', reason?.stack || reason);
    logAuditEvent({
      timestamp: new Date().toISOString(),
      status: 'error',
      duration_ms: 0,
      error_message: `unhandledRejection: ${reason?.message || String(reason)}`,
      error_code: 'EUNHANDLED_REJECTION'
    });
  });

  process.on('uncaughtException', (err: Error) => {
    console.error('[UncaughtException]', err?.stack || err);
    logAuditEvent({
      timestamp: new Date().toISOString(),
      status: 'error',
      duration_ms: 0,
      error_message: `uncaughtException: ${err?.message || String(err)}`,
      error_code: 'EUNCAUGHT_EXCEPTION'
    });
    void shutdown('uncaughtException', server).then(() => process.exit(1));
  });
}

export { app, createMcpServer };
