# iMessage MCP Server

Model Context Protocol (MCP) Server for macOS iMessage integration over Streamable HTTP and SSE transports.

Exposes your local Mac's iMessage database (`~/Library/Messages/chat.db`), Address Book contacts, and AppleScript / Swift automation capabilities to AI assistants (Antigravity, Claude, Cursor, etc.).

---

## Features

* **Dual Transports:** Supports modern Streamable HTTP (`/mcp`) and Server-Sent Events (`/sse`).
* **Cloudflare Pro Tunnel:** Publicly accessible at `https://imessage.genericservice.app` over Cloudflare edge HTTPS.
* **Authentication:** Protected with Bearer token authentication header (`Authorization: Bearer <TOKEN>`).
* **Attachment Support:** Full inline attachment reading and sending (photos, documents, audio, video). Converts HEIC photos to JPEG automatically for vision LLM analysis.
* **Single-Bubble Delivery:** Pastes attachments and message text directly into Messages app for single-bubble delivery.
* **Contacts Integration:** Searches macOS Address Book contacts (`AddressBook-v22.abcddb`) to resolve names, phone numbers, and emails.
* **Full-Text Message Search:** High-performance search across historical iMessage conversations.

---

## Exposed MCP Tools

| Tool Name | Description | Key Parameters |
| :--- | :--- | :--- |
| `imessage_list_chats` | Discover active chats, ROWIDs, display names, and handles | `limit` (number, default: 30) |
| `imessage_read_messages` | Read message history with inline attachment details | `chat` (string, required), `days` (number, default: 14) |
| `imessage_search_messages` | Full-text search across all historical iMessages | `query` (string, required), `limit` (number, default: 30) |
| `imessage_search_contacts` | Search macOS Address Book by name, phone, or email | `query` (string, optional) |
| `imessage_get_chat_members` | List members and handles in group chats | `chat` (string, required) |
| `imessage_get_attachment_payload` | Fetch attachment metadata and base64 payload (HEIC to JPEG) | `path` (string, required) |
| `imessage_send_message` | Send iMessage (supports text & single-bubble attachments) | `recipient` (string, required), `message`, `attachment` |

---

## Client Configuration (`mcp_config.json`)

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
        "Authorization: Bearer <YOUR_AUTH_TOKEN>"
      ],
      "trust": true
    }
  }
}
```

---

## Architecture & Permissions

### macOS TCC & System Events Requirements
To enable attachment pasting and automated sending over SSH / background daemons:
1. Open **System Settings → Privacy & Security → Accessibility**.
2. Add `/usr/libexec/sshd-keygen-wrapper` (use `Cmd+Shift+G` in the file picker) and turn **ON**.
3. Under **Automation**, ensure **System Events** and **Messages** are allowed for terminal / sshd.

---

## License
MIT
