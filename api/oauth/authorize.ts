/**
 * The authorization endpoint.
 *
 * GET renders the consent screen; POST checks the password and redirects back
 * to the client with an authorization code.
 *
 * Two classes of error are handled differently, as OAuth requires: a problem
 * with the client or redirect URI is shown to the user here, because bouncing
 * to an unvalidated URI is how open redirects happen. Anything after the
 * redirect target is known to be legitimate goes back to the client as
 * `error` parameters.
 */

import {
  type ClientPayload,
  OAuthNotConfiguredError,
  SCOPE,
  consentPage,
  consentPassword,
  isAllowedRedirectUri,
  mintCode,
  oauthError,
  secretsMatch,
  verifyArtifact,
} from "../../src/oauth.js";

/** Parameters carried through the consent screen and needed to mint a code. */
const CARRIED_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

interface ValidatedRequest {
  client: ClientPayload;
  params: Record<string, string>;
  clientId: string;
  redirectUri: string;
}

/** Validates far enough to know that redirecting to `redirect_uri` is safe. */
function validateClientAndRedirect(params: Record<string, string>): ValidatedRequest | Response {
  const clientId = params.client_id;
  if (!clientId) return oauthError("invalid_request", "client_id is required.");

  let client: ClientPayload | null;
  try {
    client = verifyArtifact<ClientPayload>("client", clientId);
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) return oauthError("server_error", error.message, 500);
    throw error;
  }
  if (!client) {
    return oauthError(
      "invalid_client",
      "Unknown, expired or tampered client_id. Remove the connector and add it again to re-register.",
    );
  }

  // Omitting redirect_uri is only unambiguous when exactly one is registered.
  const redirectUri = params.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required.");
  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri does not match any URI registered by this client.");
  }
  if (!isAllowedRedirectUri(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri scheme is not permitted.");
  }

  return { client, params, clientId, redirectUri };
}

function redirectBack(redirectUri: string, values: Record<string, string | undefined>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

/** Checks the request itself, once the redirect target is trusted. */
function validateAuthorizationRequest(validated: ValidatedRequest): Response | null {
  const { params, redirectUri } = validated;
  const state = params.state;

  if (params.response_type !== "code") {
    return redirectBack(redirectUri, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported.",
      state,
    });
  }
  if (!params.code_challenge) {
    return redirectBack(redirectUri, {
      error: "invalid_request",
      error_description: "PKCE is required: code_challenge is missing.",
      state,
    });
  }
  if ((params.code_challenge_method ?? "S256") !== "S256") {
    return redirectBack(redirectUri, {
      error: "invalid_request",
      error_description: "Only code_challenge_method=S256 is supported.",
      state,
    });
  }
  return null;
}

function collectParams(source: URLSearchParams | FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const key of CARRIED_PARAMS) {
    const value = source.get(key);
    if (typeof value === "string" && value !== "") params[key] = value;
  }
  return params;
}

export function GET(request: Request): Response {
  const params = collectParams(new URL(request.url).searchParams);
  const validated = validateClientAndRedirect(params);
  if (validated instanceof Response) return validated;

  const invalid = validateAuthorizationRequest(validated);
  if (invalid) return invalid;

  return consentPage({
    params: { ...params, redirect_uri: validated.redirectUri },
    clientName: validated.client.client_name,
    redirectUri: validated.redirectUri,
  });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "Expected a form submission.");
  }

  const params = collectParams(form);
  const validated = validateClientAndRedirect(params);
  if (validated instanceof Response) return validated;

  const invalid = validateAuthorizationRequest(validated);
  if (invalid) return invalid;

  const submitted = form.get("password");
  let expected: string;
  try {
    expected = consentPassword();
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) return oauthError("server_error", error.message, 500);
    throw error;
  }

  if (typeof submitted !== "string" || submitted === "" || !secretsMatch(submitted, expected)) {
    // Re-render rather than redirect: a wrong password is the user's problem to
    // fix here, and telling the client would leak that someone tried.
    return consentPage({
      params: { ...params, redirect_uri: validated.redirectUri },
      clientName: validated.client.client_name,
      redirectUri: validated.redirectUri,
      error: "That password is not correct.",
    });
  }

  const code = mintCode({
    clientId: validated.clientId,
    redirectUri: validated.redirectUri,
    codeChallenge: params.code_challenge,
    scope: params.scope || SCOPE,
    resource: params.resource,
  });

  return redirectBack(validated.redirectUri, { code, state: params.state });
}
