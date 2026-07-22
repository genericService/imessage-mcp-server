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
  Tool
} from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);
const PYTHON_BIN = '/usr/bin/python3';
const CLI_PATH = '/Users/matthias/bin/imessage';

const PORT = parseInt(process.env.PORT || '8765', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(16).toString('hex');
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const PUBLIC_DOMAIN = 'imessage.genericservice.app';

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
    name: 'imessage_send_message',
    description:
      'Send an outbound iMessage to a recipient using AppleScript on macOS. Supports text message body and/or file attachments (images, PDFs, documents, audio/video).',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: "Recipient's phone number or email address (e.g., '+14802998607' or 'user@example.com')."
        },
        message: {
          type: 'string',
          description: 'Optional text content of the iMessage to send.'
        },
        attachment: {
          type: 'string',
          description: 'Optional local POSIX file path of an attachment to send (e.g. "/Users/matthias/Pictures/photo.jpg").'
        }
      },
      required: ['recipient']
    }
  }
];

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
        tools: {}
      },
      instructions: `
iMessage MCP Server Instructions:
1. Discovery: Call 'imessage_list_chats' to discover available conversation IDs, display names, and handles.
2. Reading: Call 'imessage_read_messages' using a chat ID or contact identifier to review past messages.
3. Sending: Call 'imessage_send_message' to send messages. Confirm recipient details and message text before sending on behalf of the user.
`.trim()
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'imessage_list_chats') {
        const limit = typeof args?.limit === 'number' ? Math.min(args.limit, 100) : 30;
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'list', '--limit', String(limit)]);
        return {
          content: [{ type: 'text', text: stdout }]
        };
      }

      if (name === 'imessage_read_messages') {
        const chat = String(args?.chat || '').trim();
        const days = typeof args?.days === 'number' ? args.days : 14;
        if (!chat) {
          throw new Error('Missing required parameter "chat"');
        }
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, 'read', chat, '--days', String(days)]);
        return {
          content: [{ type: 'text', text: stdout }]
        };
      }

      if (name === 'imessage_send_message') {
        const recipient = String(args?.recipient || '').trim();
        const message = String(args?.message || '').trim();
        const attachment = String(args?.attachment || '').trim();
        if (!recipient) {
          throw new Error('Missing required parameter "recipient"');
        }
        if (!message && !attachment) {
          throw new Error('Must provide either "message" or "attachment"');
        }
        const cliArgs = ['send', recipient];
        if (message) cliArgs.push('--message', message);
        if (attachment) cliArgs.push('--attachment', attachment);
        const { stdout } = await execFileAsync(PYTHON_BIN, [CLI_PATH, ...cliArgs]);
        return {
          content: [{ type: 'text', text: stdout }]
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `ERROR: ${error.stderr || error.message}` }],
        isError: true
      };
    }
  });

  return server;
}

const app = express();

// Request logger for diagnostic tracing
app.use((req, _res, next) => {
  req.headers['accept'] = 'application/json, text/event-stream';
  console.log(`[HTTP] ${req.method} ${req.url} | Auth: ${req.headers.authorization ? 'Present' : 'Missing'}`);
  next();
});

// CORS configuration for web and desktop clients
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-session-id', 'Mcp-Session-Id', 'mcp-protocol-version', 'Mcp-Protocol-Version'],
  exposedHeaders: ['mcp-session-id', 'Mcp-Session-Id', 'Authorization']
}));
app.use(express.json());

// Bearer Token authentication middleware
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing Bearer token header.',
      example: 'Authorization: Bearer <YOUR_AUTH_TOKEN>'
    });
    return;
  }
  next();
};

interface HttpSessionRecord {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastAccess: number;
}

const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
const httpSessions = new Map<string, HttpSessionRecord>();

// Periodically clean up inactive HTTP transport sessions (>30 mins inactive)
setInterval(async () => {
  const now = Date.now();
  const TTL = 30 * 60 * 1000;
  for (const [sessionId, session] of httpSessions.entries()) {
    if (now - session.lastAccess > TTL) {
      console.log(`[MCP Eviction] Cleaning up expired HTTP session: ${sessionId}`);
      httpSessions.delete(sessionId);
      try {
        await session.server.close();
      } catch (e) {}
    }
  }
}, 5 * 60 * 1000);

/**
 * Root discovery HTML page.
 */
app.get('/', (_req, res) => {
  const publicBase = `https://${PUBLIC_DOMAIN}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
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

  <h2>Client Configuration Snippets</h2>
  <h3>1. Streamable HTTP (mcp-remote / Antigravity / Cursor)</h3>
  <pre><code>{
  "mcpServers": {
    "imessage": {
      "command": "pnpm",
      "args": [
        "dlx",
        "mcp-remote",
        "${publicBase}/mcp",
        "--header",
        "Authorization: Bearer &lt;YOUR_AUTH_TOKEN&gt;"
      ],
      "trust": true
    }
  }
}</code></pre>

  <h3>2. SSE Transport (mcp-remote sse-only)</h3>
  <pre><code>{
  "mcpServers": {
    "imessage": {
      "command": "pnpm",
      "args": [
        "dlx",
        "mcp-remote",
        "${publicBase}/sse",
        "--transport",
        "sse-only",
        "--header",
        "Authorization: Bearer &lt;YOUR_AUTH_TOKEN&gt;"
      ],
      "trust": true
    }
  }
}</code></pre>

  <h2>Available Tools</h2>
  <ul>
    <li><code>imessage_list_chats</code>: List recent conversations, display names, and handles.</li>
    <li><code>imessage_read_messages</code>: Read message history from a chat.</li>
    <li><code>imessage_send_message</code>: Send an iMessage to a recipient.</li>
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
    version: '1.0.0',
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
    version: '1.0.0',
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
  // Normalize Accept header for clients that don't send text/event-stream explicitly
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

  // New session or initialization request
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

const host = '0.0.0.0';

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
