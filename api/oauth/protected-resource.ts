/**
 * RFC 9728 protected-resource metadata.
 *
 * The 401 from /api/mcp points here via `WWW-Authenticate`; this is the first
 * document an MCP client fetches, and it names the authorization server.
 * Routed from /.well-known/oauth-protected-resource by vercel.json.
 */

import { getPublicOrigin } from "mcp-handler";

import { CORS_HEADERS, jsonResponse, protectedResourceMetadata } from "../../src/oauth.js";

export function GET(request: Request): Response {
  return jsonResponse(protectedResourceMetadata(getPublicOrigin(request)));
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
