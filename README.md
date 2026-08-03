# Gong MCP Server

A Model Context Protocol (MCP) server exposing Gong call data — call lists, transcripts, and Gong's AI-generated highlights — to MCP clients like Claude.

It runs two ways from one codebase:

| | Entrypoint | Transport | Use for |
|---|---|---|---|
| **Local** | `src/index.ts` → `dist/index.js` | stdio | Claude Desktop / Claude Code on your machine, via node or Docker |
| **Remote** | `api/mcp.ts` | Streamable HTTP | A deployed endpoint on Vercel, reachable from any MCP client |

Both register the same tools from `src/tools.ts` against the same client in `src/gong-client.ts`.

## Tools

| Tool | Description |
|---|---|
| `list_calls` | Lists calls most recent first. Defaults to the last 90 days. Optional `fromDateTime`, `toDateTime`, `limit`. Follows Gong's pagination cursor and reports when a result set was truncated. |
| `retrieve_transcripts` | Transcripts for up to 20 call IDs, as timestamped lines labeled with participant names, under topic headings, preceded by a roster of speakers with their affiliation and title (`format: "text"`, the default) — or Gong's raw per-sentence JSON (`format: "json"`). Set `resolveSpeakers: false` to skip the name lookup and show raw speaker IDs. |
| `get_call_highlights` | Gong's AI-generated brief, key points, outcome and outline for one call. Highlights can take several hours after a call to become available. |

## Prerequisites

- Node.js 20 or later
- Gong API credentials — an Access Key and Access Secret from **Company Settings → Ecosystem → API** in Gong

## Local use (stdio)

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your Gong credentials, then point your client at the built entrypoint:

```json
{
  "mcpServers": {
    "gong": {
      "command": "node",
      "args": ["/absolute/path/to/gong-mcp/dist/index.js"],
      "env": {
        "GONG_ACCESS_KEY": "your_access_key_here",
        "GONG_ACCESS_SECRET": "your_access_secret_here"
      }
    }
  }
}
```

Or with Docker:

```bash
docker build -t gong-mcp .
```

```json
{
  "mcpServers": {
    "gong": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GONG_ACCESS_KEY", "-e", "GONG_ACCESS_SECRET", "gong-mcp"],
      "env": {
        "GONG_ACCESS_KEY": "your_access_key_here",
        "GONG_ACCESS_SECRET": "your_access_secret_here"
      }
    }
  }
}
```

## Deploying to Vercel

The HTTP endpoint is a single Vercel Function at `/api/mcp`. No framework, no build configuration beyond `vercel.json`.

### 1. Deploy

```bash
npx vercel        # preview deployment
npx vercel --prod # production
```

### 2. Set environment variables

In the Vercel project, under **Settings → Environment Variables**, add all three as encrypted variables for the environments you deploy to:

| Variable | Value |
|---|---|
| `GONG_ACCESS_KEY` | Your Gong access key |
| `GONG_ACCESS_SECRET` | Your Gong access secret |
| `MCP_AUTH_TOKEN` | A secret you generate: `openssl rand -hex 32` |
| `MCP_LOGIN_PASSWORD` | Optional. The password for the OAuth consent screen; defaults to `MCP_AUTH_TOKEN` |

**`MCP_AUTH_TOKEN` is not optional.** The Gong credentials live in the function's environment, so anyone who can reach the URL can spend them and read your entire call library — and a deployment URL is not a secret. The endpoint requires this token as a bearer credential on every request, and **refuses all requests while the variable is unset**, so a misconfiguration fails closed rather than exposing your calls.

Two things worth doing alongside it:

- Turn on **Deployment Protection** so preview deployments aren't publicly reachable.
- Redeploy after changing environment variables — running deployments don't pick up new values.

### 3. Connect a client

Claude Code:

```bash
claude mcp add --transport http gong https://your-project.vercel.app/api/mcp \
  --header "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
```

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gong": {
      "url": "https://your-project.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

### 4. Connect claude.ai, Claude Desktop or Claude mobile

These connect over OAuth only — they have no way to send a fixed header unless your organization has the request-header beta. The deployment includes a small OAuth 2.1 authorization server for exactly this, so no extra configuration is needed:

1. **Admin settings → Connectors** (org-wide) or **Settings → Connectors** (just you)
2. **Add custom connector**, URL `https://your-project.vercel.app/api/mcp`
3. Leave OAuth Client ID and Secret **empty** — the server registers clients dynamically
4. Click **Add**, then **Connect**
5. A consent screen appears. Enter your `MCP_LOGIN_PASSWORD`, or `MCP_AUTH_TOKEN` if you didn't set one, and click **Approve**

Access tokens last 30 days and refresh automatically, so this is a one-time step per client.

Because the consent password is typed by hand — sometimes on a phone — setting `MCP_LOGIN_PASSWORD` to something memorable is worth doing. Without it you'll be pasting 64 hex characters.

#### What the OAuth server does and doesn't do

It implements protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591), and the authorization-code grant with mandatory PKCE S256, plus refresh tokens.

It is deliberately single-user. There is no user database: approving an authorization means proving you know the shared password, so every client that connects has the same full read access. Per-person identity would need a real identity provider behind the `/authorize` step.

All state is carried in the artifacts themselves, each signed with a key derived from `MCP_AUTH_TOKEN`, so nothing needs storing between requests. Two consequences worth knowing:

- **Rotating `MCP_AUTH_TOKEN` invalidates every issued client registration and token.** That is the revocation mechanism — there is nothing else to revoke. Every client then has to reconnect.
- **Authorization codes are not single-use**, since enforcing that requires shared state. They expire after five minutes, and PKCE means a stolen code is useless without the client's `code_verifier`.

### Serverless constraints worth knowing

These shape how the tools behave, and why some of them refuse work rather than failing opaquely:

- **Response bodies are capped at 4.5 MB.** Exceeding it produces a `413` with no usable error, so tool results are refused above ~2 MB with a message telling you to narrow the request. Transcript output is compact by default for the same reason.
- **`maxDuration` is 120s** in `vercel.json` (the platform allows up to 300s). Gong's cursor pages are sequential, so `list_calls` stops after 10 pages (1000 calls) and flags the result `truncated` with a note — narrow the date range for a complete, correctly ordered window.
- **Every request is stateless.** A fresh server instance is built per invocation; nothing is cached between them.

Transcripts identify speakers only by an opaque numeric ID, so `retrieve_transcripts` resolves names through a second `/v2/calls/extensive` request — one per tool call, however many call IDs it covers. That lookup is supplementary: if it fails (a missing scope, say), the transcript is still returned with raw speaker IDs rather than erroring.

## Development

```bash
npm run typecheck   # typecheck src/ and api/
npm run build       # emit dist/ for the stdio entrypoint
```

To exercise the HTTP endpoint locally, run `npx vercel dev` and connect the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to `http://localhost:3000/api/mcp` over Streamable HTTP, with an `Authorization: Bearer <token>` header.

## License

MIT License — see LICENSE file for details.
