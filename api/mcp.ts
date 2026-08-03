/**
 * HTTP entrypoint — Streamable HTTP MCP endpoint, deployed as a Vercel Function
 * at `/api/mcp`.
 *
 * `mcp-handler` is stateless: every request builds a fresh server instance, so
 * nothing is cached between invocations and no session store is needed.
 *
 * The stdio entrypoint for local use is `src/index.ts`; both register the same
 * tools from `src/tools.ts`.
 */

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";

import { gongClientFromEnv } from "../src/gong-client.js";
import { type AccessPayload, SCOPE, masterSecret, secretsMatch, verifyArtifact } from "../src/oauth.js";
import { registerGongTools } from "../src/tools.js";

const handler = createMcpHandler(
  (server: McpServer) => {
    registerGongTools(server, gongClientFromEnv);
  },
  {
    serverInfo: { name: "gong-mcp", version: "0.2.0" },
    capabilities: { tools: {} },
  },
);

/**
 * Accepts either credential this server issues.
 *
 * An OAuth access token from /api/oauth/token, which is what claude.ai and the
 * Claude apps use; or the raw MCP_AUTH_TOKEN presented directly as a bearer
 * token, which is simpler for clients that can set a header themselves (Claude
 * Code, Cursor, curl). Both grant the same read-only access.
 *
 * The Gong credentials live in this function's environment, so anyone who can
 * reach this URL can spend them and read the whole call library. It therefore
 * fails closed: with MCP_AUTH_TOKEN unset nothing is served, and nothing can be
 * signed either.
 */
async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  let master: string;
  try {
    master = masterSecret();
  } catch {
    console.error(
      "MCP_AUTH_TOKEN is not set — refusing every request. Set it in the Vercel " +
        "project's environment variables and redeploy.",
    );
    return undefined;
  }
  if (!bearerToken) return undefined;

  const oauthToken = verifyArtifact<AccessPayload>("access", bearerToken);
  if (oauthToken) {
    return {
      token: bearerToken,
      scopes: oauthToken.scope ? oauthToken.scope.split(" ") : [SCOPE],
      clientId: oauthToken.client_id,
      expiresAt: oauthToken.exp,
    };
  }

  if (secretsMatch(bearerToken, master)) {
    return { token: bearerToken, scopes: [SCOPE], clientId: "gong-mcp-owner" };
  }

  return undefined;
}

const authenticatedHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authenticatedHandler as GET, authenticatedHandler as POST, authenticatedHandler as DELETE };
