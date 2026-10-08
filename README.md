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
- **Message Rewrite & Edit History:** Surfaces edit status indicators (`is_edited`, `has_edits`, `edit_count`, `last_edited`) on pulled messages, decoding binary property lists (`message_summary_info`) in `chat.db` for full chronological revision histories.
- **Incremental reads:** `since_msg_id` returns only rows in that chat with a greater message ROWID, so a poller can advance with `next_since_msg_id` instead of re-reading an overlapping window.
- **Link previews:** Shared links (Spotify and other URL balloons) include `link_preview` with url, title, subtitle, artist, and site name. The raw `.pluginPayloadAttachment` stays on `attachments`.
- **Structured tapbacks:** Love, like, dislike, laugh, emphasize, question, and custom emoji reactions are nested on the target message (or listed separately). They are not returned as "Loved …" text.
- **Zoned timestamps:** Each message keeps its human `timestamp` and adds `timestamp_iso` in ISO 8601 with the server machine's local UTC offset.
- **Sender identity:** Outgoing rows use sender `Me` and an empty `handle`. The other party's handle is `participant`, because `chat.db` stores that handle on `is_from_me` rows.
- **Delivery, Quiet Delivery & Read Receipts:** Surfaces `is_delivered`, `delivered_at`, `delivered_at_iso`, `delivered_quietly`, `was_delivered_quietly`, `notifications_silenced`, `did_notify_recipient`, `is_read`, `read_at`, and `read_at_iso` on message records. `delivered_at` is always populated when `is_delivered` is true (falling back to message timestamp if SQLite omitted a separate delivery date). Quiet delivery indicators reflect recipient Focus or Do Not Disturb status.
- **Scheduled Messages & CLI Runner:** Schedule outgoing iMessages with exact future ISO timestamps and expressive effects via `imessage_send_message`. Inspect, cancel, and run due scheduled messages via the CLI runner (`bin/imessage schedule list`, `status`, `cancel`, `run-pending`) even if the background Node server is stopped.
- **Stickers & Media Payload Handling:** Surfaces rich sticker metadata (`is_sticker`, `sticker_pack`, `sticker_description`), synthesizes raw Unicode replacement characters `\ufffc` into human-readable `[sticker: "description"]` labels, and converts HEIC stickers to PNG by default during downloads to preserve alpha transparency.
- **Webhook Wakeups & Change Watcher:** Detects changes to `chat.db` and `chat.db-wal` using filesystem events and polling fallback, sending debounced webhook notifications to external bots. Payloads contain strictly event metadata with zero message text or contact names. Surfaces quiet delivery flags and expressive send styles. Includes HMAC-SHA256 signatures and restart state persistence.
- **MCP Resource Subscriptions:** Exposes `resource://messages/recent` with live updates over MCP for clients subscribed to server resources.
- **Message Editing:** Programmatically edit sent messages within Apple's 15-minute protocol window (up to 5 revisions) via `imessage_edit_message` and `imessage edit`, routing through the IMCore bridge.
- **Contact Resolution:** Integrates with macOS Contacts database (`AddressBook-v22.abcddb`) to resolve names, phone numbers, and emails.
- **Voice Note Transcriptions & Audio Processing:** Surfaces Apple on-device speech-to-text transcriptions, audio durations (e.g. `[voice note, 15s: "transcript"]`), and full-text search across voice memo transcripts. Automatically converts proprietary CoreAudio `.caf` files to universal `.m4a` (AAC) via macOS `afconvert` for speech and multimodal AI models.
- **Multimodal Attachment Reading:** Exposes attachment metadata (MIME type, size, path, duration) and automatically converts `.heic` photos to `.jpg`, `.heic` stickers to `.png`, and `.caf` voice memos to `.m4a`.
- **Reliable Attachment Sending:** Sends route through the [imsg](https://github.com/openclaw/imsg) CLI when installed, with a native AppleScript fallback that stages files inside Messages' own attachments directory to avoid "Not Delivered" sandboxing failures. No Accessibility/GUI scripting required.
- **Group Chat Rosters:** Inspects group conversation member lists and handles.
- **OAuth 2.0 Auth Server & Bearer Auth:** Embedded authorization server supporting RFC 8414 metadata, Authorization Code flow with PKCE, Client Credentials grant, and RFC 7591 dynamic client registration alongside customizable static Bearer tokens.

---

## Architecture Overview

```mermaid
flowchart TD
    Client["AI Assistant / Client (Claude Desktop, Antigravity, Cursor)"]

    subgraph Server["iMessage MCP Server (Node.js / Express / TypeScript)"]
        direction TB
        Endpoints["Transports: Streamable HTTP (/mcp) and SSE (/sse)"]
        Auth["Auth: Bearer Token and OAuth 2.0 PKCE (RFC 7591)"]
        Audit["Local Action Audit Logger (logs/audit.log)"]
    end

    CLI["macOS iMessage Engine (bin/imessage Python Script)"]

    subgraph Storage["macOS System and Data Integration"]
        direction TB
        ChatDB[("Messages Database: ~/Library/Messages/chat.db (Read-Only SQLite, Edit History bplist, Voice Transcripts)")]
        ContactsDB[("Contacts Database: AddressBook-v22.abcddb (Read-Only SQLite)")]
        Automation["Messages.app Automation: imsg CLI (Sending and IMCore Edits) + AppleScript Fallback"]
        Converters["macOS Media Converters: sips (HEIC to JPEG) + afconvert (CAF to M4A)"]
    end

    Client -->|"HTTP / SSE (Bearer or OAuth PKCE)"| Server
    Server -->|"Child Process JSON IPC"| CLI
    CLI -->|"Read-only SQLite query"| ChatDB
    CLI -->|"Read-only SQLite query"| ContactsDB
    CLI -->|"imsg / AppleScript execution"| Automation
    CLI -->|"Media conversions"| Converters
```

```
┌─────────────────────────┐          HTTP / SSE           ┌──────────────────────────────────┐
│  AI Assistant / Client  │  ───────────────────────────> │       iMessage MCP Server        │
│  (Claude, Antigravity)  │  <── Authorization: Bearer ── │     (Node.js / Express / TS)     │
└─────────────────────────┘                               └─────────────────┬────────────────┘
                                                                            │
                                                                            │ Child Process (JSON IPC)
                                                                            ▼
                                                          ┌──────────────────────────────────┐
                                                          │        macOS iMessage CLI        │
                                                          │   (bin/imessage Python Script)   │
                                                          └─────────────────┬────────────────┘
                                                                            │
                            ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
                            │                                               │                                               │
                            ▼                                               ▼                                               ▼
             ┌──────────────────────────────┐                ┌──────────────────────────────┐                ┌──────────────────────────────┐
             │   Messages DB (Read-Only)    │                │   Contacts DB (Read-Only)    │                │   Messages.app Automation    │
             │  ~/Library/Messages/chat.db  │                │    AddressBook-v22.abcddb    │                │    imsg CLI + AppleScript    │
             │ • History & Edit bplists     │                │ • Contact & Name Resolution  │                │ • Sending & IMCore Edits     │
             │ • Voice Memo Transcriptions  │                │                              │                │ • sips / afconvert tools     │
             └──────────────────────────────┘                └──────────────────────────────┘                └──────────────────────────────┘
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

#### B. Automation (Required for sending and editing)
1. Open **System Settings → Privacy & Security → Automation** and ensure **Terminal** / **sshd** has permission to control **Messages**.
2. (Recommended) Install the [imsg](https://github.com/openclaw/imsg) CLI for the primary send path: `brew install steipete/tap/imsg`. Without it, sends fall back to native AppleScript with sandbox-safe attachment staging. Note: `imsg` also powers the private IMCore bridge into Messages.app for editing sent messages.

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

Modern MCP clients support direct HTTP / SSE transport definitions with custom headers (Bearer token & modern protocol version) without any external bridge process:

```json
{
  "mcpServers": {
    "imessage": {
      "url": "https://imessage.genericservice.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AUTH_TOKEN",
        "MCP-Protocol-Version": "2026-07-28"
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
* **Registration Endpoint:** `https://imessage.genericservice.app/oauth/register`

### 2. Zero-Config Client Connection (RFC 7591 Dynamic Registration)
Clients supporting RFC 7591 (such as Gemini Desktop or Cursor) connect automatically without requiring manually provisioned client IDs or secrets:
1. Provide the MCP server URL (`https://imessage.genericservice.app/mcp`) in the client.
2. The client discovers `registration_endpoint` and automatically registers its own identity using PKCE (`token_endpoint_auth_method: none`).
3. The client opens your browser to `/oauth/authorize` for logon approval.

### 3. Browser Logon & Session Persistence
The authorization endpoint provides a browser logon screen:
* Log in with `AUTH_USERNAME` and `AUTH_PASSWORD` (or your master `BEARER_TOKEN`).
* Checking **"Remember this browser"** issues a signed, 30-day `HttpOnly` session cookie (`imessage_session`).
* Subsequent client connections from that browser only require a single **"Approve"** click without re-typing credentials.
* To clear sessions, navigate to `/oauth/logout`.

### 4. Client Credentials Token Exchange (CLI & Headless Agents)
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

---

## Available MCP Tools

| Tool Name | Description | Key Parameters |
| :--- | :--- | :--- |
| `imessage_list_chats` | List recent conversations with AddressBook names and participant sets | `limit` (number, default: 30) |
| `imessage_read_messages` | Read message history with attachments, link previews, tapbacks, voice notes, edit history, and ISO timestamps | `chat` or alias `chat_id` (numeric ROWID from `imessage_list_chats`, or a name/phone/email), `days` (default: 14), `since_msg_id`, `reactions`, `include_calls`, `with_meta` |
| `imessage_get_recent_messages` | Preview the last N messages, or poll rows newer than `since_msg_id` | `chat` or `chat_id`, `limit` (default: 5, max: 50), `since_msg_id`, `reactions` (`attach` or `separate`), `include_filtered`, `include_calls`, `with_meta` |
| `imessage_get_call_history` | Retrieve phone and FaceTime call history with direction, duration, and status | `handle` (or `contact`), `chat` (or `chat_id`), `since`, `until`, `call_type`, `limit` (default: 30) |
| `imessage_search_messages` | Full-text search across historical iMessages and voice note transcriptions, with optional BM25 relevance sorting | `query` (aliases `q`, `search`), `limit` (default: 30), `order` (`recent` or `relevance`), `chat`, `since_msg_id` |
| `imessage_get_edit_history` | Retrieve full rewrite and edit history with revision timestamps for an iMessage by ROWID | `message_id` (number, required) |
| `imessage_search_group_chats` | Exact participant set search across group chats | `participants` (array of strings, required) |
| `imessage_search_contacts` | Search macOS Address Book by name, phone, or email | `query` (string, optional) |
| `imessage_get_chat_members` | List members and resolved contact names in group chats | `chat` (string, required) |
| `imessage_get_attachment_payload` | Fetch attachment metadata and base64 payload (converts HEIC to JPEG and CAF voice notes to M4A with transcriptions) | `path` (or `message_id`) |
| `imessage_download_image` | Download and extract an image attachment (converts HEIC to JPEG, optional destination `output_path`) | `message_id` (or `path`), `output_path`, `include_base64` |
| `imessage_send_message` | Send iMessage to contact, group chat thread, or chat ROWID (supports local paths, HTTPS URLs, base64 attachments, expressive send effects, send scheduling, dry_run safety preview, and confirm_token) | `recipient` (or `to`, required), `message`, `attachment`, `effect`, `schedule_at`, `dry_run`, `confirm_token` |
| `imessage_list_scheduled_messages` | List pending and recent scheduled iMessages queued for future delivery | `status` (`pending`, `sent`, `canceled`, `all`) |
| `imessage_cancel_scheduled_message` | Cancel a scheduled message before dispatch | `schedule_id` (string, required) |
| `imessage_edit_message` | Edit a previously sent message by ROWID (subject to 15-minute Apple protocol window and 5-edit limit) | `message_id` (number, required), `text` (string, required) |
| `imessage_index_status` | Inspect status, row counts, database file size, and sync lag of the local search index | *(none)* |
| `imessage_get_readme` | Retrieve full server README documentation & usage guide | *(none)* |

---

## CLI Reference (`bin/imessage`)

The underlying Python engine can be executed directly as a standalone CLI for local administration, scripting, or automated pipelines. All commands support the `--json` flag for structured machine-readable output:

| Command | Description | Example |
| :--- | :--- | :--- |
| `list` | List recent conversations with participant handles | `bin/imessage list --limit 10 --json` |
| `read` | Read chat history for a contact or group chat | `bin/imessage read 46 --days 7 --since-msg-id 1200 --include-calls --json` |
| `recent` | Preview last N messages, or rows after a message id | `bin/imessage recent 46 --limit 5 --since-msg-id 1200 --include-calls --with-meta --json` |
| `calls` | Retrieve phone and FaceTime call history | `bin/imessage calls --limit 20 --json` |
| `search` | Search message history by keyword or phrase | `bin/imessage search "Arrakis" --limit 20 --order relevance --since-msg-id 1200` |
| `edits` | Inspect complete rewrite and revision history for a message | `bin/imessage edits 198097 --json` |
| `edit` | Edit a previously sent outgoing message | `bin/imessage edit 198097 --text "Paul Atreides revised" --json` |
| `send` | Send message, attachment, or expressive effect to contact or chat ID | `bin/imessage send "+15550199808" --message "Happy Birthday!" --effect balloons` |
| `contacts` | Search AddressBook contacts by name, email, or phone | `bin/imessage contacts "Paul Atreides" --json` |
| `members` | List members and handles in a group chat | `bin/imessage members 1767 --json` |
| `search-group` | Search group chats by exact participant set | `bin/imessage search-group "paul@caladan.org" "chani@sietch.net"` |
| `attachment` | Inspect attachment file metadata and base64 payload by path or message ID | `bin/imessage attachment --message-id 198097 --json` |
| `download-image` | Download/convert image attachment (HEIC to PNG for stickers, JPEG for photos), optionally saving to output path | `bin/imessage download-image --message-id 198097 --format auto --output-path ~/Downloads/photo.png --json` |
| `schedule list` | List pending, sent, or canceled scheduled messages | `bin/imessage schedule list --status pending --json` |
| `schedule status` | Summary stats of scheduled queue with next upcoming message | `bin/imessage schedule status --json` |
| `schedule cancel` | Cancel a pending scheduled message by ID | `bin/imessage schedule cancel sched_e33c4b78745e45d9 --json` |
| `schedule run-pending` | Process and send all due scheduled messages | `bin/imessage schedule run-pending --json` |
| `changes` | Query message ROWIDs and receipt transitions since cursor | `bin/imessage changes --since-id 1200 --json` |
| `index build` | Build local sidecar search index in batches | `bin/imessage index build --batch-size 5000` |
| `index status` | Show index row counts, lag, and file size | `bin/imessage index status --json` |
| `index sync` | Incrementally sync new rows and recheck recent edits | `bin/imessage index sync --recheck-days 14` |
| `index rebuild` | Delete and rebuild index database from scratch | `bin/imessage index rebuild` |

---

## Security & Local Action Audit Logging

To maintain absolute privacy and trauma-informed data autonomy, the server **never** stores or logs personal message text, passwords, or attachment bytes.

If you wish to log AI agent action executions for security auditing, set `ENABLE_AUDIT_LOG=true` in your `.env` file. This appends structured JSON audit lines to `logs/audit.log`:

```json
{
  "timestamp": "2026-07-25T00:46:45Z",
  "tool": "imessage_send_message",
  "target": "Chani (+15550199480)",
  "dry_run": true,
  "status": "success",
  "duration_ms": 42
}
```

---

## Sending messages and attachments

Call `imessage_send_message` (or universal alias `send_message`) with `recipient` (or alias `to`), optional `message`, and optional `attachment`.

### Supported attachment inputs

The server accepts three forms of attachment input:

1. **Local Mac POSIX file path:**
   Absolute or home-relative paths on the macOS host, such as `/Users/shared/Pictures/flower.jpg` or `~/Downloads/flower.jpg`.
2. **Remote HTTPS/HTTP URL:**
   Public or authenticated web URLs, such as `https://example.com/images/flower.jpg`. The server fetches the file directly, saves it to a secure staging directory, and passes the staged file to Messages.
3. **Base64 encoded data:**
   File payloads encoded as standard Data URIs (`data:image/jpeg;base64,/9j/4AAQ...`) or raw base64 strings. The server sniffs binary magic bytes to determine file type, writes the buffer to a temporary file, and attaches it.

### Safety preview and attachment validation (`dry_run: true`)

Before sending, clients can pass `dry_run: true` to generate a preview and verification receipt without sending:

- **Existence verification:** Validates that a local file path exists on disk, a remote URL returns HTTP 200, or a base64 string decodes into a valid binary buffer. Non-existent files or 404 URLs return clear errors immediately.
- **Metadata inspection:** Computes and returns the exact file size (`attachment_size` in bytes) and MIME type (`attachment_type`).
- **Confirmation token:** Generates a short-lived `confirm_token` (`cf_...`). Re-calling `imessage_send_message` with `confirm_token` authorizes dispatch using the already-verified, staged file without re-uploading or re-downloading.

Example preview response:

```json
{
  "status": "preview",
  "dry_run": true,
  "target_recipient": "+15550199808",
  "message_text": "Here is the flower",
  "attachment": "/var/folders/.../T/imessage-attachments/url_1790726927_a1b2c3d4.jpg",
  "attachment_size": 245120,
  "attachment_type": "image/jpeg",
  "attachment_info": {
    "path": "/var/folders/.../T/imessage-attachments/url_1790726927_a1b2c3d4.jpg",
    "size": 245120,
    "type": "image/jpeg",
    "mime_type": "image/jpeg",
    "source": "url"
  },
  "participants": [],
  "confirm_token": "cf_0123456789abcdef",
  "instructions": "To dispatch this message, re-call imessage_send_message with confirm_token: \"cf_0123456789abcdef\" or dry_run: false."
}
```

### Expressive send effects

Outbound messages can include native Apple message effects via the `effect` parameter:

- **Bubble effects:** `slam` (or `impact`), `loud`, `gentle`, `invisible_ink`
- **Screen effects:** `echo`, `spotlight`, `balloons` (or `birthday`), `confetti`, `love` (or `heart`), `lasers`, `fireworks`, `shooting_star`, `celebration` (or `sparkles`)

When sending with `dry_run: true`, the safety preview inspects and validates the effect, displaying both the canonical effect name and its classification (`bubble` or `screen`). When dispatching with SIP disabled and the `imsg launch` IMCore bridge active, effects are sent natively. If SIP is enabled on the host Mac, the server falls back to standard message delivery so the message is always delivered reliably.

### Message scheduling

Schedule outbound messages for future delivery using the `schedule_at` parameter (with aliases `scheduled_at`, `send_at`, or `delay`):

- **ISO 8601 timestamps:** e.g. `"2026-10-07T12:00:00Z"`
- **Relative offsets:** e.g. `"+15m"`, `"+1h"`, `"2 hours"`, `"+1d"`

Scheduled messages are durably stored in `~/.imessage-mcp/scheduled.json` (or custom path configured via `IMESSAGE_SCHEDULE_PATH`) and dispatched when their delivery timer expires.

- **List scheduled messages:** Call `imessage_list_scheduled_messages` (or `list_scheduled_messages`) to view pending, sent, or canceled messages.
- **Cancel a scheduled message:** Call `imessage_cancel_scheduled_message` (or `cancel_scheduled_message`) with `schedule_id` to disarm its timer and cancel delivery before send.

### Ambient context envelope

Object-returning endpoints (`dry_run` preview, scheduled dispatch confirmations, `imessage_cancel_scheduled_message`, and reads using `with_meta: true`) automatically include an `ambient` block. This informs callers of pending queued tasks without requiring extra tool calls:

```json
{
  "ambient": {
    "pending_scheduled_count": 1,
    "next_scheduled": {
      "id": "sched_1790726927_a1b2c3d4",
      "recipient": "+15550199808",
      "scheduled_for": "2026-10-07T12:00:00.000Z",
      "effect": "lasers"
    }
  }
}
```

Calls returning raw arrays (such as `imessage_list_chats` or plain `imessage_read_messages`) preserve their array structure for backward compatibility.

---

## Reading messages

`chat` and `chat_id` are the same parameter. Pass the numeric chat ROWID from `imessage_list_chats` (`rowid`, also copied to `chat_id`). A display name, phone number, or email still matches when you do not have the ROWID yet. `since_message_id` and `after_id` are accepted aliases for `since_msg_id`.

Polling a busy thread:

1. Call `imessage_get_recent_messages` with `with_meta: true`.
2. Store `next_since_msg_id` from the response (it is also on each message).
3. On the next poll, pass that value as `since_msg_id`. The read is `message.ROWID > cursor` inside that chat, not a rescan of the last N texts.
4. When `has_more` is true, call again immediately with the new cursor. With `since_msg_id` set, `limit` counts raw rows, including tapbacks, so a burst cannot hide later texts.

Default JSON stays an array of messages. `with_meta: true` wraps it:

```json
{
  "messages": [],
  "filtered": { "reaction": 2 },
  "next_since_msg_id": 1204,
  "has_more": false
}
```

`filtered.reaction` is how many tapback rows were omitted from `messages` because they were attached to a target. `skipped_before` on each message is the same count since the previous returned row. A missing ROWID that was never stored (a deleted row, for example) is not included in that count. `include_filtered: true` or `reactions: "separate"` puts those rows back in id order as `kind: "reaction"` records with `text: null`.

Outgoing messages (`is_from_me`) use `sender: "Me"` and `handle: ""`. `participant` is the other handle `chat.db` stored on that row. Incoming messages keep the sender handle in both `handle` and `participant`.

### Delivery, Quiet Delivery & Read Receipts

Every message record includes delivery, quiet delivery (Focus / Do Not Disturb), and read receipt indicators:
- `is_delivered` (boolean): `true` when the message has reached Apple delivery networks or the recipient device.
- `delivered_at` (string | null): Formatted local timestamp of delivery. Always populated when `is_delivered` is `true` (falling back to message timestamp if `chat.db` omitted an explicit delivery timestamp).
- `delivered_at_iso` (string | null): ISO-8601 delivery timestamp with local UTC offset.
- `delivered_quietly` (boolean): `true` when the message was delivered quietly because the recipient has notifications silenced or Focus / Do Not Disturb active.
- `was_delivered_quietly` (boolean): Direct alias matching the underlying Apple SQLite column.
- `notifications_silenced` (boolean): Semantic alias indicating the recipient had notifications silenced at delivery time.
- `silenced_notifications` (boolean): Direct alias of notifications_silenced.
- `has_notifications_silenced` (boolean): Direct alias of notifications_silenced.
- `did_notify_recipient` (boolean): `true` if the recipient was alerted anyway (e.g. via "Notify Anyway").
- `is_read` (boolean): `true` when the recipient has opened or read the message.
- `read_at` (string | null): Formatted local timestamp when read.
- `read_at_iso` (string | null): ISO-8601 read timestamp with local UTC offset.

On outgoing rows, `read_at` only exists when the recipient has read receipts enabled. Typing indicators are transient in memory and are not stored in SQLite `chat.db`.

`timestamp` is unchanged (`2026-09-25 09:25 PM`). `timestamp_iso` is ISO 8601 with the host's local offset (`2026-09-25T21:25:00-07:00`). Edit revisions include `timestamp_iso` as well.

`link_preview` is `null` unless the row has URL-balloon metadata. The plugin payload file remains an attachment.

Tapback `type` is `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`, or `emoji` (custom emoji in `emoji`). `action` is `added` or `removed`. Each reaction includes `target_msg_id` and `target_guid`. A reaction whose target is outside the current window is returned as its own structured record so a poll does not drop it.

## Call and FaceTime history

Call records are read from macOS Core Data SQLite storage at `~/Library/Application Support/CallHistoryDB/CallHistory.storedata` using read-only URIs (`mode=ro`).

- **Tool `imessage_get_call_history`:** Retrieves call records. Filter by `handle` (phone number, email, or contact name), `chat` (resolves chat participants to their handles), `since`/`until` (ISO 8601 strings, Unix timestamps, or Apple epoch seconds), `call_type` (`phone`, `facetime_video`, `facetime_audio`, or `unknown`), and `limit`.
- **Timeline merging via `include_calls`:** Setting `include_calls: true` on `imessage_read_messages` or `imessage_get_recent_messages` merges phone and FaceTime calls with that chat's participants into the message list in chronological order. Calls appear as entries with `kind: "call"`, `text: null`, and the call metadata.
- **Cursor safety:** Call entries do not have message ROWIDs and do not affect `next_since_msg_id` or `filtered.reaction` counts. Incremental polling via `since_msg_id` advances strictly on message rows.
- **Resilience:** If `CallHistory.storedata` is missing or unreadable due to missing Full Disk Access permissions, the tool returns a non-fatal status object explaining the issue rather than throwing an exception.

---

## Webhook Wakeups & Change Watcher

The server can monitor `chat.db` and `chat.db-wal` for incoming messages, reactions, and receipt transitions, and send debounced HTTP POST notifications to external webhook endpoints. This allows an external agent or bot to wake up on activity and fetch message details via `since_msg_id` without continuous polling.

### Privacy & Payload Design

Webhook payloads contain zero message content, sender names, or contact handles. They carry strictly event metadata and cursors:

```json
{
  "event": "message_in",
  "chat_id": 7,
  "newest_msg_id": 105,
  "count": 1,
  "since_msg_id_hint": 104,
  "occurred_at_iso": "2026-09-26T11:15:00-07:00"
}
```

Upon receiving a webhook, the client calls `imessage_get_recent_messages` using `since_msg_id_hint` to retrieve full content securely.

### Configuration

Enable the watcher by setting `WATCH_ENABLED=true` in `.env` or the environment.

Configure rules using either `WATCH_RULES` (inline JSON string) or `WATCH_CONFIG_FILE` (path to a JSON file, default `~/.imessage-mcp/watch-config.json`):

```json
[
  {
    "webhook_url": "https://bot.example.com/webhook",
    "chats": [7, "+15550199480"],
    "events": ["message_in", "reaction", "read_receipt", "delivered"],
    "debounce_ms": 3000,
    "secret": "your-shared-hmac-secret"
  }
]
```

### Rule Fields

- `webhook_url` (string, required): Endpoint URL to receive POST notifications.
- `chats` (array of numbers or strings, required): List of chat ROWIDs or participant handles to watch. Rules without chats are rejected to prevent broadcast leakage.
- `events` (array of strings, optional): Events to emit. Supported values: `message_in`, `message_out`, `reaction`, `read_receipt`, `delivered`. Defaults to `["message_in", "reaction"]`. Outgoing messages (`message_out`) only fire when explicitly included in `events`.
- `debounce_ms` (number, optional, default: 3000): Debounce window grouping rapid event bursts for a chat into a single aggregated notification with an updated `count` and `newest_msg_id`.
- `secret` (string, optional): Shared secret. When present, each webhook request includes an `X-Signature-SHA256: sha256=<hex>` HMAC signature header.
- `headers` (object, optional): Custom HTTP headers sent on every webhook POST, as a map of header name to string value (for example an `Authorization` key expected by the receiving endpoint). Values must be strings without control characters; a rule whose `headers` is not an object of strings is rejected with a warning naming the offending header. `Content-Type`, `Content-Length`, `Host`, and `X-Signature-SHA256` are reserved and cannot be overridden. Header values are never logged. Works together with `secret`: the HMAC signature header is still added.

Example rule with an `Authorization` header and an HMAC secret:

```json
[
  {
    "webhook_url": "https://bot.example.com/webhook",
    "chats": [7],
    "events": ["message_in", "reaction"],
    "secret": "your-shared-hmac-secret",
    "headers": {"Authorization": "Bearer <key>"}
  }
]
```

Each POST then carries `Content-Type: application/json`, `User-Agent: imessage-mcp-server/<version>`, `Authorization: Bearer <key>`, and `X-Signature-SHA256: sha256=<hex>` (HMAC-SHA256 of the raw JSON body).

Rules are read once at server startup from `WATCH_RULES` or `WATCH_CONFIG_FILE`; restart the server after changing them.

### Event Classification

`message_in` and `message_out` are only emitted for real messages. System rows (`item_type != 0`), group events (`group_action_type != 0`), and empty rows with no text, no `attributedBody` text, and no attachments (the rows that render as `<empty message>` from sender `Unknown`) are skipped. They still advance the cursor. Tapbacks are always classified as `reaction`.

### State Persistence & Resilience

- **State File:** Tracked in `WATCH_STATE_FILE` (default `~/.imessage-mcp/watch-state.json`). It records `last_seen_msg_id` and outgoing receipt statuses so server restarts do not replay past messages or miss offline updates.
- **Filesystem Watcher & Polling:** Uses `fs.watch` on the database directory combined with a fallback interval (`WATCH_POLL_INTERVAL_MS`, default 5000ms) to ensure timely detection even under aggressive macOS SQLite WAL checkpoints.
- **Bounded Retries:** Webhook delivery uses exponential backoff up to 3 retries with a 5000ms request timeout. Delivery errors are logged without payload bodies or secrets, and never crash the server.

### MCP Resource Subscriptions

Clients connected over MCP can also subscribe to `resource://messages/recent`. When new messages land in `chat.db`, the server notifies subscribed clients via standard MCP resource update notifications.

---

## On-Device Voice Note Transcription

The server provides fully on-device transcription for iMessage voice notes (`.caf`, `.m4a`, `.wav`). Whenever Apple's native transcript in `attachment.user_info` is missing (common on incoming notes and Spanish speech), the server transcribes the audio locally using `whisper.cpp` with Apple Silicon Metal acceleration, or optionally through macOS Speech framework.

All processing runs 100% locally on your Mac. Audio and transcript text never leave the host machine, and no paid or cloud APIs are required.

### Key Capabilities

- **Zero-Cloud Privacy:** All audio conversions and neural model inferences run strictly on-device. Audio files are converted to 16 kHz mono WAV inside private temporary directories with `0700` permissions and removed immediately after processing. Transcripts and audio contents are never printed to server logs.
- **Apple Precedence:** If Messages.app already transcribed the audio note into `attachment.user_info`, the server returns Apple's transcript directly (`transcription_source: "apple"`). The local engine runs only when Apple's transcript is missing.
- **Multilingual Support:** Auto-detects spoken languages with a priority hint list (`TRANSCRIBE_LANGUAGES`, default `"es,en"`). Returns standardized BCP-47 language codes (such as `"es"` or `"en"`).
- **Persistent Cache:** Transcriptions are saved in `~/.imessage-mcp/transcripts.db` (or `~/.imessage-mcp/index.db` when `INDEX_ENABLED=true`), keyed by attachment GUID, file size, and modification time. Each audio clip is transcribed only once.
- **Diacritic-Insensitive Search:** When `INDEX_ENABLED=true`, cached transcripts feed into the SQLite FTS5 search index with diacritic folding (`remove_diacritics 2`), so searching for "manana" matches "mañana".
- **Serial Execution & Low Priority:** Runs with single-job concurrency (`fcntl` file locking) and process renicing (`os.nice(10)`) to ensure the host MacBook Air remains cool, quiet, and responsive.

### Engine Setup & Installation

#### 1. Install whisper.cpp (Recommended Engine)

Install the standalone `whisper-cli` tool via Homebrew:

```bash
brew install whisper-cpp
```

This installs `whisper-cli` with native Apple Silicon Metal acceleration enabled.

#### 2. Download Model Weights

Models are stored under `~/.imessage-mcp/models/`. You can download and verify models using the provided helper script:

```bash
# Download the default high-accuracy multilingual model (547 MB, Q5_0 quantized)
./bin/download-transcribe-model large-v3-turbo-q5_0

# Or download via the imessage CLI
./bin/imessage transcribe download-model --model large-v3-turbo-q5_0
```

Available model targets:
- **`large-v3-turbo-q5_0`** (default, ~547 MB): Recommended for Apple Silicon. Exceptional accuracy on Spanish (including Mexican Spanish) and English, running in under 5 seconds for typical clips.
- **`small`** (~466 MB): Balanced multilingual model with lower memory footprint.
- **`tiny`** (~74 MB): Ultra-fast, lightweight option for constrained setups.

To prevent unexpected network activity, model files are never downloaded automatically at request time unless `TRANSCRIBE_AUTO_DOWNLOAD=true` is set.

#### 3. Optional Apple Speech Engine Fallback

If you prefer macOS native speech recognition without downloading Whisper model files, configure `TRANSCRIBE_ENGINE=apple`. This routes transcription to Apple's `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` via a Swift helper.

> [!NOTE]
> Running the Apple Speech engine requires macOS Speech Recognition permission (TCC) granted to the Terminal or parent process. Furthermore, non-English recognition (such as `es-MX`) requires on-device dictation assets installed in **System Settings → Keyboard → Dictation**.

### Performance & Resource Expectations (M-Series MacBook Air)

Tested on an Apple M2 MacBook Air (8 GB RAM):

| Metric | `large-v3-turbo-q5_0` | `tiny` |
| :--- | :--- | :--- |
| **Disk Footprint** | 547 MB | 74 MB |
| **Peak RAM Usage** | ~1.2 GB | ~250 MB |
| **Transcription Speed** | ~1.5x - 2x real-time (2.8s clip in ~4.5s on first cold run, ~1.8s warm) | ~10x real-time (2.8s clip in ~0.3s) |
| **Spanish Word Accuracy** | Near perfect (handles slang, accents, and punctuation) | Basic comprehension |

### Tool Response Format

Calling `imessage_get_attachment_payload` returns enriched transcription fields:

```json
{
  "filename": "/Users/matthias/Library/Messages/Attachments/.../Audio Message.caf",
  "mime_type": "audio/mp4",
  "is_audio": true,
  "duration_seconds": 15.2,
  "duration_formatted": "15s",
  "transcription": "Hola, te veo mañana para la reunión.",
  "language": "es",
  "transcription_source": "whisper",
  "transcription_status": "ok",
  "segments": [
    {
      "start": 0.0,
      "end": 2.4,
      "text": "Hola, te veo mañana para la reunión."
    }
  ]
}
```

`transcription_status` values:
- `"ok"`: Transcription completed successfully or loaded from cache.
- `"not_audio"`: The requested attachment is not an audio file.
- `"engine_unavailable"`: Neither `whisper-cli` nor the Apple Speech engine is installed.
- `"too_long"`: Audio duration exceeds `TRANSCRIBE_MAX_SECONDS` (default 600s).
- `"pending"`: Transcription queue wait timeout expired (`TRANSCRIBE_WAIT_MS`), indicating the engine is busy with another job.
- `"failed"`: Audio conversion or engine execution encountered an error.

### CLI Management Commands

```bash
# Check engine status, installed models, and cached transcript count
./bin/imessage transcribe status

# Download a specific model
./bin/imessage transcribe download-model --model small

# Backfill older voice notes from message history
./bin/imessage transcribe backfill --since 2026-01-01 --chat 46

# Clear cached transcripts
./bin/imessage transcribe clear-cache
```

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TRANSCRIBE_ENGINE` | `whisper` | Active transcription engine (`whisper` or `apple`). |
| `TRANSCRIBE_MODEL` | `large-v3-turbo-q5_0` | Default Whisper model name to load from `~/.imessage-mcp/models/`. |
| `TRANSCRIBE_MODEL_PATH` | _(auto-resolved)_ | Explicit filesystem path to a `.bin` Whisper model file. |
| `TRANSCRIBE_LANGUAGES` | `es,en` | Comma-separated language hint preference list for whisper auto-detection. |
| `TRANSCRIBE_MAX_SECONDS` | `600` | Maximum audio duration in seconds accepted for transcription. |
| `TRANSCRIBE_WAIT_MS` | `60000` | Maximum milliseconds to wait for the serial queue lock before returning status `"pending"`. |
| `TRANSCRIBE_JOB_TIMEOUT_SECONDS` | `120` | Subprocess execution timeout in seconds for transcription tasks. |
| `TRANSCRIBE_AUTO_DOWNLOAD` | `false` | When `true`, automatically downloads missing Whisper models on first request. |
| `TRANSCRIBE_ON_ARRIVAL` | `false` | When `true`, the background watcher queues transcription for incoming voice notes as soon as they arrive. |

---

## Local Search & Metadata Index (Optional Sidecar)

The server includes an optional local SQLite sidecar index designed to accelerate full-text searches and repeat reads across large message histories without duplicating the message database or attachment files.

`chat.db` remains the read-only single source of truth. The index never writes to `~/Library/Messages` and never makes network calls or cloud synchronizations.

### What the Index Stores

The index is stored in a single SQLite database in WAL mode (`~/.imessage-mcp/index.db` by default) with restricted permissions (directory `0700`, file `0600`):

- **`messages_idx`**: Core message metadata including message ROWID (`msg_id`), GUID, chat ID, handle ID, `is_from_me`, Apple epoch timestamp, Unix epoch seconds, item type, attachment flag, and decoded plain text (`text_decoded`). For messages stored with `attributedBody`, text is decoded once at index time using the server's binary parser.
- **`messages_fts`**: An SQLite FTS5 virtual table built over `messages_idx` (`content='messages_idx'`). It uses the `unicode61` tokenizer with `remove_diacritics 2`, enabling fast prefix, phrase, and accent-insensitive searches across English, Spanish, and other languages.
- **`attachments_idx`**: Attachment metadata only: attachment ROWID, message ID, filename, transfer name, MIME type, UTI, size in bytes, and the original file path in `chat.db`.
- **`contacts_idx`**: Normalized handles (E.164 phone numbers or lowercase email addresses) and display names resolved from macOS AddressBook.
- **`meta`**: Index schema version, last indexed message ID, last full sync timestamp, and `chat.db` filesystem inode and file size at sync time.

### What the Index Never Stores

- **No Attachment Files:** Binary attachment files, images, voice notes, and videos are never copied. The index stores only metadata and the original filesystem path already referenced by `chat.db`.
- **No Raw Message Blobs:** Full raw database rows, binary property lists, and raw `attributedBody` blobs are not stored in the index.
- **No Read or Delivery Status:** Read and delivery receipts are dynamic and change over time. They are never cached in the index and are always read live from `chat.db`.

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `INDEX_ENABLED` | `false` | Set to `true` to enable sidecar indexing and accelerated search. When `false`, missing, or lagging behind `chat.db`, all tools fall back transparently to reading `chat.db` directly. |
| `INDEX_DB_PATH` | `~/.imessage-mcp/index.db` | Filesystem path for the index SQLite database. Directory is created with `0700` and database file with `0600`. |
| `INDEX_RECHECK_DAYS` | `14` | Lookback window in days for detecting in-place message edits, unsends, and deletions during periodic sync passes. |

### Keeping the Index Current

The index stays synchronized with `chat.db` through three mechanisms:

1. **Initial Build:** Run `bin/imessage index build` (or automatic build on first sync). It reads `chat.db` in batches of 5,000 rows, runs with low process priority (`os.nice(10)`), streams progress to `stderr`, and handles histories of any size without loading everything into memory.
2. **Incremental Ingestion:** Whenever `INDEX_ENABLED=true`, the server watcher detects new rows and indexes everything past `last_indexed_msg_id`. This runs independently of webhook rules (`WATCH_ENABLED`).
3. **Edits, Unsends, and Deletions:** Because `chat.db` updates edited and retracted rows in place, the server re-checks the last N days (configured by `INDEX_RECHECK_DAYS`, default 14) at server startup and every 10 minutes. Changed messages have their `text_decoded` refreshed in the index, and deleted rows are purged.

### Fallback Behavior & Safety

If the index file is missing, corrupt, using an outdated schema version, or lagging behind `chat.db`'s newest message ROWID, the server logs a warning to `stderr` and falls back directly to `chat.db`. It never returns partial or stale search results silently.

### Search Sorting (Recent vs Relevance)

When searching with `imessage_search_messages` or `bin/imessage search`:
- **`order: "recent"`** (default): Sorts matching messages chronologically descending. Matches existing server behavior.
- **`order: "relevance"`**: Sorts matching messages by BM25 match quality score from SQLite FTS5.

### Disk-Size Expectations & Removal

Because the index stores only plain text and lightweight metadata, its footprint is small (typically under 5% of `chat.db` size, and orders of magnitude smaller than the Attachments directory).

To remove or reset the index:
```bash
# Delete index files
rm -f ~/.imessage-mcp/index.db ~/.imessage-mcp/index.db-wal ~/.imessage-mcp/index.db-shm

# Or trigger a clean rebuild via CLI
bin/imessage index rebuild
```

---

### Check on a real Mac after deploy

The fixture database covers the shapes this server parses. A live `chat.db` and `CallHistory.storedata` can still differ:

- Real `chat.db` receipt columns: verify that `is_delivered`, `date_delivered`, `is_read`, and `date_read` match expectations across macOS versions.
- Receipt timing: verify read receipt delivery timing when communicating with recipients who have read receipts enabled.
- Filesystem event delivery: confirm that `fs.watch` picks up SQLite WAL changes on `chat.db-wal` on APFS.
- `payload_data` for a current Spotify (or other) share may be an `NSKeyedArchiver` of `LPLinkMetadata`, a plain binary plist, or a newer specialization class. Confirm `link_preview.url`, `title`, `subtitle` or `artist`, and `site_name` on one real share, and that the `.pluginPayloadAttachment` is still listed under `attachments`.
- Tapback rows should use `associated_message_type` 2000 to 2006 (added) and 3000 to 3006 (removed), with `associated_message_guid` like `p:0/<message guid>`. Custom emoji reactions need the `associated_message_emoji` column (Ventura and later). If a reaction still shows up as text, note the integer type and guid prefix.
- On a 1:1 thread, an `is_from_me` row's `handle_id` points at the other person. Confirm `sender` is `Me`, `handle` is empty, and `participant` is that other handle. Group chats often leave `handle_id` empty on outgoing rows.
- `timestamp_iso` should use the Mac's local offset, including daylight-saving changes.
- Edit history for a real edited message should still list every revision. This build does not change how `message_summary_info` is decoded.
- `CallHistory.storedata`: Confirm Full Disk Access allows reading `CallHistory.storedata`. Check that incoming/outgoing phone calls and FaceTime video/audio calls appear with accurate `duration_seconds` and resolved contact names. Check if cellular iPhone calls appear (requires "Calls on Other Devices" enabled in FaceTime/Phone settings on your iPhone and Mac).

## Known Limitations & Considerations

1. **Host Mac Requirement:** Must run on a physical Mac or macOS VM signed into an active Apple ID.
2. **AppleScript Attachment Sandboxing:** Messages' sandbox blocks reading attachments from arbitrary paths (`/tmp`, `~/Desktop`, ...), which historically surfaced as "Not Delivered". This server avoids it by sending through the imsg CLI (which stages files itself), or in the AppleScript fallback by staging files under `~/Library/Messages/Attachments/imessage-mcp/` first (this folder is not pruned automatically). A logged-in user session is still required for Messages automation.
3. **Read-Only SQLite Access:** Database reads use `URI mode=ro` (`sqlite3.connect('file:chat.db?mode=ro', uri=True)`) to ensure `chat.db` is never locked or corrupted by server reads.
4. **SMS vs iMessage:** Text-only messages fallback gracefully to SMS if the recipient handle is a mobile phone number registered on your iPhone's Text Message Forwarding network.
5. **Message Editing Protocol & Architecture:** macOS 13+ introduced message editing over the iMessage protocol. Editing is subject to Apple protocol limits: only outgoing messages (`is_from_me = 1`) can be edited within 15 minutes of sending, up to a maximum of 5 times. AppleScript does not provide an API to edit messages. Programmatic editing is routed through the `imsg edit` CLI bridge, which interfaces with Apple's private `IMCore` framework (`IMChat editMessageItem:`). Operating `imsg edit` requires System Integrity Protection (SIP) to be disabled for dylib injection (`imsg launch`). If SIP is active or the bridge is not running, the tool returns an actionable diagnostic response.

---

## License

This project is licensed under the [MIT License](LICENSE).
