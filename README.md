# libredesk-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Libredesk](https://libredesk.io) — the open-source omnichannel customer support desk.

Exposes the entire Libredesk REST API (54 endpoints) as MCP tools, generated dynamically from the official OpenAPI spec.

## Tools

All Libredesk REST endpoints become tools. Highlights:

- **Conversations** — `get_all_conversations`, `get_conversation`, `send_message`, `update_conversation_status`, `update_conversation_priority`, `update_conversationtags`, `update_user_assignee`, `update_team_assignee`, `search_conversations`, ...
- **Contacts** — `get_contacts`, `get_contact`, `update_contact`, `block_contact`, `search_contacts`, `get_contact_notes`, `create_contact_note`
- **Agents** — `get_agents`, `get_current_agent`, `create_agent`, `update_agent`, `generate_a_p_i_key`, `revoke_a_p_i_key`
- **Teams** — `get_teams`, `create_team`, `update_team`, `delete_team`
- **Status & Priority** — `get_statuses`, `get_priorities`, `create_status`, `update_status`
- **AI** — `a_i_completion`, `get_a_i_prompts`, `update_a_i_provider`
- **Search** — `search_conversations`, `search_contacts`, `search_messages`
- **Media** — `media_upload`
- **Health** — `health_check`

## Setup

### 1. Get a Libredesk API key

Log in to your Libredesk instance as an agent, open your profile, and generate an API key. You'll get an `api_key` and `api_secret`.

### 2. Add to Claude Code

```bash
claude mcp add-json libredesk --scope user '{
  "command": "node",
  "args": ["/absolute/path/to/libredesk-mcp/dist/index.js"],
  "env": {
    "LIBREDESK_URL": "http://localhost:9000",
    "LIBREDESK_API_KEY": "ak_...",
    "LIBREDESK_API_SECRET": "as_..."
  }
}'
```

Or once published to npm:

```bash
claude mcp add-json libredesk --scope user '{
  "command": "npx",
  "args": ["-y", "libredesk-mcp"],
  "env": {
    "LIBREDESK_URL": "http://localhost:9000",
    "LIBREDESK_API_KEY": "ak_...",
    "LIBREDESK_API_SECRET": "as_..."
  }
}'
```

Restart your Claude Code session; you should see `libredesk` as `✓ Connected` in `claude mcp list`.

### 3. Other MCP clients

Add to your MCP host's config (Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "libredesk": {
      "command": "node",
      "args": ["/absolute/path/to/libredesk-mcp/dist/index.js"],
      "env": {
        "LIBREDESK_URL": "http://localhost:9000",
        "LIBREDESK_API_KEY": "ak_...",
        "LIBREDESK_API_SECRET": "as_..."
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LIBREDESK_URL` | yes | Base URL of your Libredesk instance, no trailing slash. e.g. `http://localhost:9000` |
| `LIBREDESK_API_KEY` | yes | Agent API key from the Libredesk admin UI |
| `LIBREDESK_API_SECRET` | yes | Agent API secret paired with the key |

Authentication uses Libredesk's token scheme: `Authorization: token <api_key>:<api_secret>`.

## How it works

On startup the server reads a bundled copy of Libredesk's [OpenAPI spec](https://docs.libredesk.io/api-reference/openapi.json), walks every operation, and registers it as an MCP tool with:

- `tool name` — derived from the operation's `operationId` (e.g. `handleGetConversation` → `get_conversation`).
- `description` — built from the operation `summary`, `description`, HTTP method/path, and tags.
- `inputSchema` — flattened from path parameters, query parameters, and the request body's JSON schema (with `$ref`s resolved against `components.schemas`).

When a tool is called, the server substitutes path params, builds the query string, sets the auth header, sends the request, and returns the response body verbatim (pretty-printed JSON when applicable) along with the HTTP status line. Errors from Libredesk are returned as-is so you can see why a request was rejected.

## Develop

```bash
npm install
npm run build       # tsc + copy openapi.json into dist/
npm run dev         # tsx src/index.ts (live TypeScript)
npm start           # node dist/index.js
```

Refresh the bundled OpenAPI spec:

```bash
curl -sL https://docs.libredesk.io/api-reference/openapi.json > src/openapi.json
npm run build
```

## License

MIT
