# iMessage MCP Server

Model Context Protocol (MCP) Server for macOS iMessage integration over Streamable HTTP and SSE transports.

Exposes your local Mac's iMessage database (`~/Library/Messages/chat.db`) and AppleScript (`osascript`) sending capabilities to AI coding assistants (Claude Desktop, Antigravity, Cursor, etc.) running on remote laptops or local sessions.

---

## Features

* **Dual Transports:** Supports modern Streamable HTTP (`/mcp`) and Server-Sent Events (`/sse`).
* **Cloudflare Pro Tunnel:** Publicly accessible at `https://imessage.genericservice.app` over Cloudflare edge HTTPS.
* **Authentication:** Protected with Bearer token authentication header (`Authorization: Bearer <TOKEN>`).
* **Discovery Page & Endpoint:** Interactive landing page at `/` and structured JSON discovery at `/discover`.
* **Built-in System Instructions:** Sends tool guidelines directly to connecting AI models during MCP protocol initialization.

---

## Exposed MCP Tools

| Tool Name | Description | Parameters |
| :--- | :--- | :--- |
| `imessage_list_chats` | List recent conversation IDs, display names, and handles | `limit` (number, default: 30) |
| `imessage_read_messages` | Fetch past message history from a target chat | `chat` (string, required), `days` (number, default: 14) |
| `imessage_send_message` | Send an outbound iMessage to a contact | `recipient` (string, required), `message` (string, required) |

---

## Client Configuration (`mcp_config.json`)

### Option A: Streamable HTTP Transport (`/mcp`)
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
        "Authorization: Bearer REDACTED_AUTH_TOKEN"
      ],
      "trust": true
    }
  }
}
```

### Option B: SSE Transport (`/sse`)
```json
{
  "mcpServers": {
    "imessage": {
      "command": "pnpm",
      "args": [
        "dlx",
        "mcp-remote",
        "https://imessage.genericservice.app/sse",
        "--transport",
        "sse-only",
        "--header",
        "Authorization: Bearer REDACTED_AUTH_TOKEN"
      ],
      "trust": true
    }
  }
}
```

---

## Management Commands

Use the [`imessage-mcp`](file:///Users/matthias/bin/imessage-mcp) CLI manager:

```bash
# Check status and health
imessage-mcp status

# Print client config snippet
imessage-mcp config

# Restart service
imessage-mcp restart

# Stop service
imessage-mcp stop
```

---

## Endpoints

* `GET /` &mdash; Human-readable discovery page with copyable configs and documentation.
* `GET /discover` &mdash; Machine-readable JSON metadata describing endpoints, auth, and tools.
* `GET /health` &mdash; Server status check and active session counts.
* `ALL /mcp` &mdash; Streamable HTTP transport endpoint.
* `GET /sse` &mdash; Server-Sent Events transport endpoint.
