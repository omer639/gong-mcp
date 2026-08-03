/**
 * RFC 8414 authorization-server metadata.
 *
 * Tells the client where to register, where to send the user, and that PKCE
 * with S256 is required. Routed from /.well-known/oauth-authorization-server
 * (and the OpenID alias some clients probe) by vercel.json.
 */

import { getPublicOrigin } from "mcp-handler";

import { CORS_HEADERS, authorizationServerMetadata, jsonResponse } from "../../src/oauth.js";

export function GET(request: Request): Response {
  return jsonResponse(authorizationServerMetadata(getPublicOrigin(request)));
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
