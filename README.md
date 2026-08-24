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
- **Reliable Attachment Sending:** Sends route through the [imsg](https://github.com/openclaw/imsg) CLI when installed, with a native AppleScript fallback that stages files inside Messages' own attachments directory to avoid "Not Delivered" sandboxing failures. No Accessibility/GUI scripting required.
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
           │ ~/Library/Messages/chat.db│                  │ AddressBook-v22.abcddb   │                 │ imsg CLI + AppleScript   │
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

#### B. Automation (Required for sending)
1. Open **System Settings → Privacy & Security → Automation** and ensure **Terminal** / **sshd** has permission to control **Messages**.
2. (Recommended) Install the [imsg](https://github.com/openclaw/imsg) CLI for the primary send path: `brew install steipete/tap/imsg`. Without it, sends fall back to native AppleScript with sandbox-safe attachment staging.

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

## Known Limitations & Considerations

1. **Host Mac Requirement:** Must run on a physical Mac or macOS VM signed into an active Apple ID.
2. **AppleScript Attachment Sandboxing:** Messages' sandbox blocks reading attachments from arbitrary paths (`/tmp`, `~/Desktop`, ...), which historically surfaced as "Not Delivered". This server avoids it by sending through the imsg CLI (which stages files itself), or in the AppleScript fallback by staging files under `~/Library/Messages/Attachments/imessage-mcp/` first (this folder is not pruned automatically). A logged-in user session is still required for Messages automation.
3. **Read-Only SQLite Access:** Database reads use `URI mode=ro` (`sqlite3.connect('file:chat.db?mode=ro', uri=True)`) to ensure `chat.db` is never locked or corrupted by server reads.
4. **SMS vs iMessage:** Text-only messages fallback gracefully to SMS if the recipient handle is a mobile phone number registered on your iPhone's Text Message Forwarding network.

---

## License

This project is licensed under the [MIT License](LICENSE).
