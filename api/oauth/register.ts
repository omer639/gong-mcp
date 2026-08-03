/**
 * RFC 7591 dynamic client registration.
 *
 * claude.ai registers itself rather than using a pre-shared client ID, so this
 * has to exist. The issued `client_id` is a signed value carrying the client's
 * own redirect URIs, which is what lets /authorize validate a redirect target
 * without a client database.
 *
 * Registration is deliberately open, as the MCP authorization flow expects.
 * Registering grants nothing on its own — every authorization still has to get
 * past the password on the consent screen.
 */

import {
  CORS_HEADERS,
  OAuthNotConfiguredError,
  SCOPE,
  isAllowedRedirectUri,
  jsonResponse,
  oauthError,
  registerClient,
} from "../../src/oauth.js";

export async function POST(request: Request): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return oauthError("invalid_client_metadata", "Request body must be JSON.");
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings.");
  }
  const rejected = (redirectUris as string[]).filter((uri) => !isAllowedRedirectUri(uri));
  if (rejected.length > 0) {
    return oauthError(
      "invalid_redirect_uri",
      `Unsupported redirect URI: ${rejected[0]}. Use https, a loopback http address, or a custom scheme.`,
    );
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : undefined;

  let clientId: string;
  try {
    clientId = registerClient(redirectUris as string[], clientName);
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) {
      return oauthError("server_error", error.message, 500);
    }
    throw error;
  }

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      ...(clientName ? { client_name: clientName } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: the authorization code is bound by PKCE, not a secret.
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
