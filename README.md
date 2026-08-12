# iMessage MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](package.json)
[![MCP Protocol](https://img.shields.io/badge/MCP-1.29.0-blue.svg)](https://modelcontextprotocol.io)

An enterprise-grade Model Context Protocol (MCP) Server for macOS iMessage integration over Streamable HTTP and SSE transports.

It connects your local Mac's iMessage database (`~/Library/Messages/chat.db`), macOS Contacts (`AddressBook`), and Swift/AppleScript automation capabilities directly to AI assistants (Antigravity, Claude Desktop, Cursor, Gemini CLI, etc.) running locally or over secure tunnels (Cloudflare Tunnel, Tailscale).

---

## Features

- **Dual MCP Transports:** Supports modern Streamable HTTP (`/mcp`) and Server-Sent Events (`/sse`).
- **Full-Text Message Search:** Instant SQLite query across historical iMessage text and rich attributed bodies.
- **Contact Resolution:** Integrates with macOS Contacts database (`AddressBook-v22.abcddb`) to resolve names, phone numbers, and emails.
- **Multimodal Attachment Reading:** Exposes attachment metadata (MIME type, size, path) and automatically converts `.heic` photos to `.jpg` for vision-capable LLMs.
- **Single-Bubble Attachment Sending:** Swift NSPasteboard + System Events paste pipeline that combines text and file attachments into a single message bubble without triggering "Not Delivered" sandboxing failures.
- **Group Chat Rosters:** Inspects group conversation member lists and handles.
- **Bearer Token Auth:** Secures all MCP endpoints behind customizable Bearer token authentication.

---

## Architecture Overview

```
┌─────────────────────────┐          HTTP/SSE           ┌──────────────────────────────┐
│  AI Assistant / Client  │  ─────────────────────────> │   iMessage MCP Server        │
│  (Claude, Antigravity)  │  <Authorization: Bearer>   │   (Node.js / Express / TS)   │
└─────────────────────────┘                             └──────────────┬───────────────┘
                                                                       │
                                                                       ▼
                                                        ┌──────────────────────────────┐
                                                        │   macOS iMessage CLI         │
                                                        │   (bin/imessage python script)│
                                                        └──────────────┬───────────────┘
                                                                       │
                         ┌─────────────────────────────────────────────┼────────────────────────────────────────────┐
                         ▼                                             ▼                                            ▼
           ┌──────────────────────────┐                  ┌──────────────────────────┐                 ┌──────────────────────────┐
           │ Messages DB (Read-Only)  │                  │ Contacts DB (Read-Only)  │                 │ Messages.app Automation  │
           │ ~/Library/Messages/chat.db│                  │ AddressBook-v22.abcddb   │                 │ Swift NSPasteboard + GUI │
           └──────────────────────────┘                  └──────────────────────────┘                 └──────────────────────────┘
```

---

## Prerequisites

- **Host Machine:** macOS 12 (Monterey), 13 (Ventura), 14 (Sonoma), or 15 (Sequoia).
- **Node.js:** `>=24.0.0` (Active LTS).
- **Package Manager:** `pnpm` (`npm install -g pnpm`).
- **Python:** Python 3.9+ (built-in macOS python3 or Homebrew).
- **Messages App:** Signed into an active Apple ID / iMessage account.

---

## Installation & Setup Guide

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/genericService/imessage-mcp-server.git
cd imessage-mcp-server
pnpm install
```

### 2. Configure Environment & Bearer Token

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` to set your desired port and a strong random Bearer token:

```env
PORT=8765
AUTH_TOKEN=your-secure-random-bearer-token-here
USE_HTTPS=false
```

### 3. Grant macOS TCC & System Permissions

Due to macOS privacy safeguards (TCC), the process executing the server requires Full Disk Access and Accessibility permissions.

#### A. Full Disk Access (Required to read `chat.db`)
1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Enable the toggle for **Terminal** (or **sshd-daemon** if running remotely over SSH).

#### B. Accessibility & Automation (Required for sending attachments)
1. Open **System Settings → Privacy & Security → Accessibility**.
2. Click **`+`**, press `Cmd + Shift + G`, paste `/usr/libexec/sshd-keygen-wrapper` (or your Terminal app path), and click **Open**.
3. Ensure the toggle switch is turned **ON**.
4. Open **System Settings → Privacy & Security → Automation** and ensure **Terminal** / **sshd** has permission to control **System Events** and **Messages**.

### 4. Build & Start Server

```bash
# Build TypeScript
pnpm build

# Run in production mode
pnpm start
```

---

## Client Configuration (`mcp_config.json`)

To connect an AI client (Antigravity, Cursor, Claude Desktop, etc.) to the iMessage MCP server:

### 1. Native Direct HTTP Transport (Recommended)

Modern MCP clients support direct HTTP / SSE transport definitions with custom headers (Bearer token & Cloudflare Access tokens) without any external bridge process:

```json
{
  "mcpServers": {
    "imessage": {
      "url": "https://imessage.genericservice.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AUTH_TOKEN",
        "CF-Access-Client-Id": "YOUR_CLIENT_ID.access",
        "CF-Access-Client-Secret": "YOUR_CLIENT_SECRET"
      }
    }
  }
}
```

### 2. Local Network (Direct HTTP)

```json
{
  "mcpServers": {
    "imessage": {
      "url": "http://localhost:8765/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AUTH_TOKEN"
      }
    }
  }
}
```

### 3. Legacy `mcp-remote` Stdio Bridge (Optional)

If your client only supports `stdio` command execution:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "pnpm",
      "args": [
        "dlx",
        "mcp-remote",
        "https://imessage.genericservice.app/mcp",
        "--header",
        "Authorization: Bearer YOUR_AUTH_TOKEN"
      ],
      "trust": true
    }
  }
}
```

---

## OAuth 2.0 Auth Server (CLI & Online Agents)

The server embeds a native **OAuth 2.0 Authorization Server** supporting RFC 8414 metadata, Client Credentials grant, and Authorization Code grant with PKCE for CLI tools (Claude Code, Antigravity CLI, Codex) and online services (ChatGPT Actions, custom GPTs, web apps).

### 1. Server Metadata Endpoint
* **Discovery URL:** `https://imessage.genericservice.app/.well-known/oauth-authorization-server`
* **Authorization Endpoint:** `https://imessage.genericservice.app/oauth/authorize`
* **Token Endpoint:** `https://imessage.genericservice.app/oauth/token`

### 2. Client Credentials Token Exchange (CLI & Headless Agents)
Agents can exchange `client_id` and `client_secret` for a signed HS256 JWT access token:

```bash
curl -X POST https://imessage.genericservice.app/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "antigravity-cli",
    "client_secret": "YOUR_SERVICE_SECRET"
  }'
```

Returns:
```json
{
  "access_token": "eyJhbGciOiJIUzI1Ni...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "ref_5ae1f64eb91...",
  "scope": "imessage:all"
}
```

### 3. Interactive Web & Online Agents (ChatGPT / Web Apps)
1. Point your client to `https://imessage.genericservice.app/oauth/authorize`.
2. The user sees a branded authorization consent screen on the Mac host.
3. Upon approval, the server redirects with an authorization code exchanged at `/oauth/token`.

---

## Available MCP Tools

| Tool Name | Description | Key Parameters |
| :--- | :--- | :--- |
| `imessage_list_chats` | List recent conversations with AddressBook names and participant sets | `limit` (number, default: 30) |
| `imessage_read_messages` | Read message history with inline attachment details | `chat` (string, required), `days` (number, default: 14) |
| `imessage_get_recent_messages` | Preview last N messages to verify thread context before sending | `chat` (string, required), `limit` (number, default: 5) |
| `imessage_search_messages` | Full-text search across all historical iMessages | `query` (string, required), `limit` (number, default: 30) |
| `imessage_search_group_chats` | Exact participant set search across group chats | `participants` (array of strings, required) |
| `imessage_search_contacts` | Search macOS Address Book by name, phone, or email | `query` (string, optional) |
| `imessage_get_chat_members` | List members and resolved contact names in group chats | `chat` (string, required) |
| `imessage_get_attachment_payload` | Fetch attachment metadata and base64 payload (HEIC to JPEG) | `path` (string, required) |
| `imessage_send_message` | Send iMessage to contact, group chat thread, or chat ROWID (supports dry_run preview & confirm_token) | `recipient` (string, required), `message`, `attachment`, `dry_run`, `confirm_token` |
| `imessage_get_readme` | Retrieve full server README documentation & usage guide | *(none)* |

---

## Security & Local Action Audit Logging

To maintain absolute privacy and trauma-informed data autonomy, the server **never** stores or logs personal message text, passwords, or attachment bytes.

If you wish to log AI agent action executions for security auditing, set `ENABLE_AUDIT_LOG=true` in your `.env` file. This appends structured JSON audit lines to `logs/audit.log`:

```json
{
  "timestamp": "2026-07-25T00:46:45Z",
  "tool": "imessage_send_message",
  "target": "Sarah (+14802016076)",
  "dry_run": true,
  "status": "success",
  "duration_ms": 42
}
```

---

## Reliability & Operations

The server is built to survive unattended operation on a Mac that may sleep,
lose permissions, or run iCloud syncs mid-request.

### Failure isolation
- **Hard subprocess timeouts.** Every call into the Python CLI runs with a
  timeout (`CLI_READ_TIMEOUT_MS`, `CLI_SEND_TIMEOUT_MS`,
  `CLI_ATTACHMENT_TIMEOUT_MS`). A wedged AppleScript, a locked screen, or a
  macOS permission prompt can no longer hang a request forever or pin the MCP
  session behind it. Hung children are killed, not orphaned.
- **Large attachments.** Output buffers default to 128 MB, so base64 payloads
  no longer die with `ENOBUFS` against Node's 1 MB `execFile` default.
- **Bounded concurrency.** `MAX_CONCURRENT_CLI` (default 4) caps simultaneous
  `python3`/sqlite subprocesses so a runaway agent loop cannot starve the host.
- **Errors are returned, not thrown.** Tool failures come back as structured
  JSON (`error_code`, `retryable`) instead of transport-level errors that make
  clients drop the session. Invalid model input is rejected before it reaches
  a subprocess.
- **Process-level guards.** `unhandledRejection` is logged and survived;
  `uncaughtException` triggers a clean drain so a supervisor restarts from a
  known state.

### Resource lifecycle
- Idle Streamable HTTP **and** SSE sessions are swept (`SESSION_IDLE_MS`), with
  LRU eviction at `MAX_HTTP_SESSIONS`. SSE cleanup covers `close`, `aborted`
  and `error`, so dropped connections no longer leak MCP server instances.
- Unknown session IDs return `404` so clients re-initialise cleanly after a
  restart rather than silently attaching to a new session.
- Dry-run `confirm_token`s expire (`CONFIRM_TOKEN_TTL_MS`) and are single-use;
  unconfirmed previews no longer retain recipients and message text in memory.
- OAuth authorization codes and refresh tokens are pruned and capped; refresh
  tokens rotate on use.
- The audit log writes through a non-blocking stream with size-based rotation
  (`AUDIT_MAX_BYTES`, `AUDIT_MAX_FILES`) and can never crash the process.

### Graceful shutdown
`SIGTERM`/`SIGINT` stops new work, drains in-flight requests, closes MCP
sessions, flushes the audit log, then exits — with a hard `SHUTDOWN_GRACE_MS`
backstop so a restart is never blocked. `/ready` reports `draining` (503) so a
tunnel or load balancer stops routing before the listener closes.

### Monitoring
`GET /health` reports uptime, active sessions per transport, subprocess pool
depth, OAuth store sizes, memory, and any configuration warnings.
`GET /ready` is a supervisor-oriented readiness probe that fails when the CLI
is missing or the server is draining.

### Security hardening
- Bearer tokens and client secrets are compared in **constant time**.
- Repeated auth failures temporarily block an IP (`AUTH_FAIL_MAX`).
- JWT verification rejects `alg=none` confusion and no longer throws on a
  truncated signature.
- The OAuth consent screen escapes all untrusted input, and only `http(s)`
  redirect URIs are accepted.
- The bearer token is redacted in startup logs.
- The formerly hardcoded legacy token now comes from `LEGACY_TOKEN`; no
  credential is committed to the repository.

> **Behind a proxy:** keep `TRUST_PROXY=true` (default) so client IPs are
> accurate, and ensure `KEEP_ALIVE_TIMEOUT_MS` exceeds your proxy's idle
> timeout to avoid intermittent 502s through Cloudflare Tunnel.

---

## Known Limitations & Considerations

1. **Host Mac Requirement:** Must run on a physical Mac or macOS VM signed into an active Apple ID.
2. **AppleScript Attachment Sandboxing:** Native AppleScript `send alias` in macOS Sonoma/Sequoia marks attachments as "Not Delivered". This server bypasses that bug using a Swift NSPasteboard paste workflow; therefore, the host Mac must be in an active Aqua GUI session.
3. **Read-Only SQLite Access:** Database reads use `URI mode=ro` (`sqlite3.connect('file:chat.db?mode=ro', uri=True)`) to ensure `chat.db` is never locked or corrupted by server reads. A `busy_timeout` (`IMESSAGE_DB_TIMEOUT`, default 15s) lets reads wait out iCloud sync locks instead of failing instantly with "database is locked".
4. **SMS vs iMessage:** Text-only messages fallback gracefully to SMS if the recipient handle is a mobile phone number registered on your iPhone's Text Message Forwarding network.

---

## License

This project is licensed under the [MIT License](LICENSE).
