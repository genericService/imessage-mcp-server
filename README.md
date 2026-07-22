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

To connect an AI client (Antigravity, Claude Desktop, Cursor, etc.) to the server over Cloudflare Tunnel or local network:

### Streamable HTTP Transport (Recommended)

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

### Local Network / SSE Transport

```json
{
  "mcpServers": {
    "imessage": {
      "command": "pnpm",
      "args": [
        "dlx",
        "mcp-remote",
        "http://localhost:8765/sse",
        "--transport",
        "sse-only",
        "--header",
        "Authorization: Bearer YOUR_AUTH_TOKEN"
      ],
      "trust": true
    }
  }
}
```

---

## Available MCP Tools

| Tool Name | Description | Key Parameters |
| :--- | :--- | :--- |
| `imessage_list_chats` | List recent conversations, display names, and handles | `limit` (number, default: 30) |
| `imessage_read_messages` | Read message history with inline attachment details | `chat` (string, required), `days` (number, default: 14) |
| `imessage_search_messages` | Full-text search across all historical iMessages | `query` (string, required), `limit` (number, default: 30) |
| `imessage_search_contacts` | Search macOS Address Book by name, phone, or email | `query` (string, optional) |
| `imessage_get_chat_members` | List members and handles in group chats | `chat` (string, required) |
| `imessage_get_attachment_payload` | Fetch attachment metadata and base64 payload (HEIC to JPEG) | `path` (string, required) |
| `imessage_send_message` | Send iMessage (supports text & single-bubble attachments) | `recipient` (string, required), `message`, `attachment` |

---

## Known Limitations & Considerations

1. **Host Mac Requirement:** Must run on a physical Mac or macOS VM signed into an active Apple ID.
2. **AppleScript Attachment Sandboxing:** Native AppleScript `send alias` in macOS Sonoma/Sequoia marks attachments as "Not Delivered". This server bypasses that bug using a Swift NSPasteboard paste workflow; therefore, the host Mac must be in an active Aqua GUI session.
3. **Read-Only SQLite Access:** Database reads use `URI mode=ro` (`sqlite3.connect('file:chat.db?mode=ro', uri=True)`) to ensure `chat.db` is never locked or corrupted by server reads.
4. **SMS vs iMessage:** Text-only messages fallback gracefully to SMS if the recipient handle is a mobile phone number registered on your iPhone's Text Message Forwarding network.

---

## License

This project is licensed under the [MIT License](LICENSE).
