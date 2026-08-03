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
import { createHash, timingSafeEqual } from "node:crypto";

import { gongClientFromEnv } from "../src/gong-client.js";
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
 * Constant-time comparison of two secrets of unequal length.
 *
 * `timingSafeEqual` throws on length mismatch, which would leak the token
 * length; comparing fixed-width digests sidesteps that.
 */
function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Single-tenant bearer check.
 *
 * The Gong credentials live in this function's environment, so anyone who can
 * reach this URL can spend them and read the whole call library. The endpoint is
 * public once deployed, so it fails closed: with MCP_AUTH_TOKEN unset, nothing
 * is served.
 */
async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    console.error(
      "MCP_AUTH_TOKEN is not set — refusing every request. Set it in the Vercel " +
        "project's environment variables, and send it as 'Authorization: Bearer <token>'.",
    );
    return undefined;
  }
  if (!bearerToken || !secretsMatch(bearerToken, expected)) return undefined;

  return { token: bearerToken, scopes: [], clientId: "gong-mcp-owner" };
}

const authenticatedHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authenticatedHandler as GET, authenticatedHandler as POST, authenticatedHandler as DELETE };
