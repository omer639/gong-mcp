/**
 * The token endpoint: exchanges an authorization code for an access token, and
 * refreshes an expiring one.
 *
 * Both grants verify the presented artifact's signature, type and expiry, and
 * check that it was issued to the client now presenting it.
 */

import {
  type AccessPayload,
  CORS_HEADERS,
  type CodePayload,
  OAuthNotConfiguredError,
  jsonResponse,
  mintAccessToken,
  oauthError,
  verifyArtifact,
  verifyPkce,
} from "../../src/oauth.js";

export async function POST(request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      form = new URLSearchParams(Object.entries((await request.json()) as Record<string, string>));
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return oauthError("invalid_request", "Could not parse the request body.");
  }

  const grantType = form.get("grant_type");

  try {
    if (grantType === "authorization_code") return exchangeCode(form);
    if (grantType === "refresh_token") return refresh(form);
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) return oauthError("server_error", error.message, 500);
    throw error;
  }

  return oauthError(
    "unsupported_grant_type",
    "Supported grant types are authorization_code and refresh_token.",
  );
}

function exchangeCode(form: URLSearchParams): Response {
  const code = form.get("code");
  const clientId = form.get("client_id");
  const codeVerifier = form.get("code_verifier");

  if (!code) return oauthError("invalid_request", "code is required.");
  if (!codeVerifier) return oauthError("invalid_request", "code_verifier is required (PKCE).");

  const payload = verifyArtifact<CodePayload>("code", code);
  if (!payload) {
    return oauthError("invalid_grant", "The authorization code is invalid or has expired. Start the flow again.");
  }

  // A code is bound to the client it was issued to.
  if (clientId && clientId !== payload.client_id) {
    return oauthError("invalid_grant", "This authorization code was not issued to this client.");
  }

  // ...and to the redirect URI used, when the client sends it back.
  const redirectUri = form.get("redirect_uri");
  if (redirectUri && redirectUri !== payload.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri does not match the one used to obtain this code.");
  }

  if (!verifyPkce(codeVerifier, payload.code_challenge)) {
    return oauthError("invalid_grant", "code_verifier does not match the code_challenge.");
  }

  return jsonResponse(
    mintAccessToken({ clientId: payload.client_id, scope: payload.scope, resource: payload.resource }),
  );
}

function refresh(form: URLSearchParams): Response {
  const refreshToken = form.get("refresh_token");
  if (!refreshToken) return oauthError("invalid_request", "refresh_token is required.");

  const payload = verifyArtifact<AccessPayload>("refresh", refreshToken);
  if (!payload) {
    return oauthError("invalid_grant", "The refresh token is invalid or has expired. Reconnect to authorize again.");
  }

  const clientId = form.get("client_id");
  if (clientId && clientId !== payload.client_id) {
    return oauthError("invalid_grant", "This refresh token was not issued to this client.");
  }

  return jsonResponse(
    mintAccessToken({ clientId: payload.client_id, scope: payload.scope, resource: payload.resource }),
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
