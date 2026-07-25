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
import { execFile } from 'child_process';
import { promisify } from 'util';
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
import { logAuditEvent } from './audit.js';
import {
  getOAuthMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleTokenPost,
  verifyJwt
} from './oauth.js';

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = path.resolve(__dir, '../bin/imessage');

const PORT = parseInt(process.env.PORT || '8765', 10);
const AUTH_TOKEN = process.env.BEARER_TOKEN || '51efa996c0dd01bd562e90e1bdcec0064aece4b854ff15909b370057202c3a17';
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'imessage.genericservice.app';

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
const pendingConfirmTokens = new Map<string, PendingSend>();

/**
 * Creates and configures an instance of the MCP Server.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'imessage-mcp-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        resources: {}
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
    return { tools: TOOLS };
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
        const readmePath = path.resolve(__dir, '../README.md');
        const content = await fs.promises.readFile(readmePath, 'utf8');
        result = {
          content: [{ type: 'text', text: content }]
        };
      } else if (name === 'imessage_list_chats') {
        const limit = typeof args?.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 100)) : 30;
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'list', '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_read_messages') {
        const chat = String(args?.chat || '').trim();
        const days = typeof args?.days === 'number' ? Math.max(1, Math.min(Math.floor(args.days), 365)) : 14;
        if (!chat) {
          throw new Error('Missing required parameter "chat"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'read', chat, '--days', String(days), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_messages') {
        const query = String(args?.query || '').trim();
        const limit = typeof args?.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 100)) : 30;
        if (!query) {
          throw new Error('Missing required parameter "query"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'search', query, '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_contacts') {
        const query = String(args?.query || '').trim();
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'contacts', query, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_recent_messages') {
        const chat = String(args?.chat || '').trim();
        const limit = typeof args?.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 50)) : 5;
        if (!chat) {
          throw new Error('Missing required parameter "chat"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'recent', chat, '--limit', String(limit), '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_search_group_chats') {
        const raw = args?.participants;
        const participants: string[] = Array.isArray(raw) ? raw.map(p => String(p).trim()).filter(Boolean) : [];
        if (participants.length === 0) {
          throw new Error('Missing required parameter "participants" (non-empty array)');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'search-group', ...participants, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_chat_members') {
        const chat = String(args?.chat || '').trim();
        if (!chat) {
          throw new Error('Missing required parameter "chat"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'members', chat, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_get_attachment_payload') {
        const filePath = String(args?.path || '').trim();
        if (!filePath) {
          throw new Error('Missing required parameter "path"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'attachment', filePath, '--json']);
        result = {
          content: [{ type: 'text', text: stdout }]
        };
      } else if (name === 'imessage_send_message') {
        const dryRun = Boolean(args?.dry_run);
        const confirmToken = String(args?.confirm_token || '').trim();

        let recipient = String(args?.recipient || '').trim();
        let message = String(args?.message || '').trim();
        let attachment = String(args?.attachment || '').trim();

        if (confirmToken) {
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
          const token = `cf_${crypto.randomBytes(8).toString('hex')}`;
          pendingConfirmTokens.set(token, { recipient, message, attachment, createdAt: Date.now() });

          let membersOutput = [];
          try {
            const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'members', recipient, '--json']);
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

          const cliArgs = [CLI_PATH, 'send', recipient];
          if (message) cliArgs.push('-m', message);
          if (attachment) cliArgs.push('-a', attachment);

          const { stdout } = await execFileAsync(PYTHON_BIN, cliArgs);
          result = {
            content: [{ type: 'text', text: stdout }]
          };
        }
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      logAuditEvent({
        timestamp: new Date().toISOString(),
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
const httpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; lastAccess: number }>();

// Session cleanup interval for Streamable HTTP transport
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of httpSessions.entries()) {
    if (now - session.lastAccess > 300000) { // 5 minutes inactivity
      console.log(`[MCP] Cleaning up inactive Streamable HTTP session: ${sessionId}`);
      session.server.close().catch(() => {});
      httpSessions.delete(sessionId);
    }
  }
}, 60000);

/**
 * Enhanced Middleware for Bearer Token & OAuth JWT Authentication
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (['/', '/health', '/discover', '/.well-known/oauth-authorization-server'].includes(req.path) || req.path.startsWith('/oauth/')) {
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
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header or ?token parameter' });
    return;
  }

  // 1. Static Bearer token check (backward compatibility)
  if (token === AUTH_TOKEN) {
    return next();
  }

  // 2. OAuth 2.0 JWT verification
  const jwtPayload = verifyJwt(token);
  if (jwtPayload) {
    (req as any).user = jwtPayload;
    return next();
  }

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
  res.json({
    status: 'ok',
    server: 'imessage-mcp-server',
    version: '1.1.0',
    publicDomain: PUBLIC_DOMAIN,
    activeSseSessions: sseSessions.size,
    activeHttpSessions: httpSessions.size,
    transports: ['sse', 'streamable-http']
  });
});

/**
 * Structured discovery JSON endpoint.
 */
app.get('/discover', (_req, res) => {
  const publicBase = `https://${PUBLIC_DOMAIN}`;
  res.json({
    name: 'imessage-mcp-server',
    version: '1.1.0',
    description: 'iMessage MCP Server over HTTP/HTTPS and SSE for macOS',
    publicDomain: PUBLIC_DOMAIN,
    endpoints: {
      streamableHttp: `${publicBase}/mcp`,
      sse: `${publicBase}/sse`,
      health: `${publicBase}/health`,
      discover: `${publicBase}/discover`
    },
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer <TOKEN>'
    },
    tools: TOOLS
  });
});

/**
 * Streamable HTTP Transport endpoint (GET & POST) for /mcp and /mcp/*
 */
app.all(['/mcp', '/mcp/*'], authMiddleware, async (req: Request, res: Response) => {
  if (!req.headers.accept || req.headers['accept'] === '*/*' || !req.headers.accept.includes('text/event-stream')) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }

  const reqSessionId = (req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id']) as string | undefined;

  if (reqSessionId && httpSessions.has(reqSessionId)) {
    const session = httpSessions.get(reqSessionId)!;
    session.lastAccess = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  let generatedSessionId: string | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      generatedSessionId = crypto.randomUUID();
      return generatedSessionId;
    }
  });
  const server = createMcpServer();
  await server.connect(transport);

  await transport.handleRequest(req, res, req.body);

  if (generatedSessionId) {
    httpSessions.set(generatedSessionId, { transport, server, lastAccess: Date.now() });
    console.log(`[MCP] Registered Streamable HTTP session: ${generatedSessionId}`);
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

  https.createServer(options, app).listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`iMessage MCP Server running over HTTPS:`);
    console.log(`  Discovery Page:      https://0.0.0.0:${PORT}/`);
    console.log(`  Streamable HTTP:     https://0.0.0.0:${PORT}/mcp`);
    console.log(`  SSE Transport:        https://0.0.0.0:${PORT}/sse`);
    console.log(`  Bearer Token:        ${AUTH_TOKEN}`);
    console.log(`=======================================================`);
  });
} else {
  http.createServer(app).listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`iMessage MCP Server running over HTTP:`);
    console.log(`  Discovery Page:      http://0.0.0.0:${PORT}/`);
    console.log(`  Streamable HTTP:     http://0.0.0.0:${PORT}/mcp`);
    console.log(`  SSE Transport:        http://0.0.0.0:${PORT}/sse`);
    console.log(`  Bearer Token:        ${AUTH_TOKEN}`);
    console.log(`=======================================================`);
  });
}
