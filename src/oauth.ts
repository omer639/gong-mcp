/**
 * A minimal OAuth 2.1 authorization server, sized for a single owner.
 *
 * claude.ai connects to remote MCP servers over OAuth only, so a bearer token
 * in a header is not enough. This implements just the surface an MCP client
 * needs — RFC 9728 protected-resource metadata, RFC 8414 authorization-server
 * metadata, RFC 7591 dynamic client registration, and an authorization-code
 * grant with PKCE.
 *
 * Everything is stateless. Registered clients, authorization codes, and tokens
 * are all self-describing values carrying an HMAC over their own contents, so
 * there is nothing to store between requests — which matters on a platform
 * where each invocation starts cold. The trade-off is noted on `verifyArtifact`.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Everything an access token grants. There is one owner, so there is one scope. */
export const SCOPE = "gong:read";

const CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
/** Registrations are long-lived; clients are expected to keep reusing them. */
const CLIENT_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;

type ArtifactType = "client" | "code" | "access" | "refresh";

interface ArtifactPayload {
  /** Artifact type, so one kind of token can never be replayed as another. */
  t: ArtifactType;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface ClientPayload extends ArtifactPayload {
  t: "client";
  redirect_uris: string[];
  client_name?: string;
}

export interface CodePayload extends ArtifactPayload {
  t: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource?: string;
  /** Makes each code unique even when minted in the same second. */
  jti: string;
}

export interface AccessPayload extends ArtifactPayload {
  t: "access" | "refresh";
  client_id: string;
  scope: string;
  resource?: string;
  jti: string;
}

export class OAuthNotConfiguredError extends Error {
  constructor() {
    super(
      "MCP_AUTH_TOKEN is not set, so the OAuth endpoints cannot sign anything. " +
        "Set it in the Vercel project's environment variables and redeploy.",
    );
    this.name = "OAuthNotConfiguredError";
  }
}

/**
 * Derives the artifact-signing key from the master secret.
 *
 * The raw `MCP_AUTH_TOKEN` is a bearer credential in its own right, so it is
 * not used directly as a signing key: a label is mixed in so the two uses
 * cannot be substituted for one another. Rotating the token invalidates every
 * issued client, code and access token, which is the desired behaviour.
 */
function signingKey(): Buffer {
  const master = process.env.MCP_AUTH_TOKEN;
  if (!master) throw new OAuthNotConfiguredError();
  return createHmac("sha256", master).update("gong-mcp/oauth-artifact-signing/v1").digest();
}

/** The password that approves an authorization request on the consent screen. */
export function consentPassword(): string {
  const password = process.env.MCP_LOGIN_PASSWORD || process.env.MCP_AUTH_TOKEN;
  if (!password) throw new OAuthNotConfiguredError();
  return password;
}

export function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function mintArtifact(payload: Omit<ArtifactPayload, "iat" | "exp">, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }), "utf8").toString(
    "base64url",
  );
  const mac = createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Verifies an artifact's signature, type and expiry, returning null on any
 * failure so callers cannot accidentally treat a bad value as good.
 *
 * Note on replay: authorization codes are not single-use, because enforcing
 * that requires shared state this server deliberately does not have. The
 * exposure is bounded by a five-minute expiry and by mandatory PKCE — a
 * replayed code is worthless without the matching `code_verifier`, which never
 * leaves the client.
 */
export function verifyArtifact<T extends ArtifactPayload>(expected: ArtifactType, artifact: string): T | null {
  const parts = artifact.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;

  let expectedMac: string;
  try {
    expectedMac = createHmac("sha256", signingKey()).update(body).digest("base64url");
  } catch {
    return null;
  }

  const given = Buffer.from(mac, "base64url");
  const wanted = Buffer.from(expectedMac, "base64url");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }

  if (payload.t !== expected) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function registerClient(redirectUris: string[], clientName?: string): string {
  return mintArtifact({ t: "client", redirect_uris: redirectUris, client_name: clientName }, CLIENT_TTL_SECONDS);
}

export function mintCode(args: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
}): string {
  return mintArtifact(
    {
      t: "code",
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      code_challenge: args.codeChallenge,
      scope: args.scope,
      resource: args.resource,
      jti: randomBytes(12).toString("base64url"),
    },
    CODE_TTL_SECONDS,
  );
}

export function mintAccessToken(args: { clientId: string; scope: string; resource?: string }) {
  const common = { client_id: args.clientId, scope: args.scope, resource: args.resource };
  return {
    access_token: mintArtifact(
      { ...common, t: "access", jti: randomBytes(12).toString("base64url") },
      ACCESS_TOKEN_TTL_SECONDS,
    ),
    refresh_token: mintArtifact(
      { ...common, t: "refresh", jti: randomBytes(12).toString("base64url") },
      REFRESH_TOKEN_TTL_SECONDS,
    ),
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: args.scope,
    token_type: "Bearer" as const,
  };
}

/** PKCE S256 check. The plain method is not accepted. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects redirect URIs that could turn the consent screen into an open
 * redirect. Loopback HTTP is allowed because native MCP clients rely on it.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // Custom schemes (e.g. a desktop app's claude://) carry no host to validate.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== "javascript:" && url.protocol !== "data:";
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [SCOPE],
  };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
  );

/**
 * The consent screen.
 *
 * There is exactly one legitimate user, so approval is proof of knowing the
 * shared secret rather than a user database lookup. The original request
 * parameters ride along in hidden fields, so the POST is self-contained and no
 * session is needed.
 */
export function consentPage(args: {
  params: Record<string, string>;
  clientName?: string;
  redirectUri: string;
  error?: string;
}): Response {
  const hidden = Object.entries(args.params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("\n        ");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Authorize access — Gong MCP</title>
    <style>
      :root {
        color-scheme: light dark;
        --fg: #18181b; --muted: #71717a; --bg: #fafafa; --card: #ffffff;
        --border: #e4e4e7; --accent: #2563eb; --accent-fg: #ffffff; --danger: #b91c1c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --fg: #f4f4f5; --muted: #a1a1aa; --bg: #09090b; --card: #18181b;
          --border: #27272a; --accent: #3b82f6; --accent-fg: #0b1220; --danger: #f87171;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem 1.25rem;
        background: var(--bg); color: var(--fg);
        font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      form {
        width: 100%; max-width: 26rem; background: var(--card); border: 1px solid var(--border);
        border-radius: 12px; padding: 1.5rem;
      }
      h1 { font-size: 1.125rem; margin: 0 0 0.25rem; }
      p { margin: 0 0 1rem; color: var(--muted); font-size: 0.9375rem; }
      dl { margin: 0 0 1.25rem; font-size: 0.875rem; }
      dt { color: var(--muted); }
      dd {
        margin: 0 0 0.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        overflow-wrap: anywhere;
      }
      label { display: block; font-size: 0.875rem; margin-bottom: 0.375rem; }
      input[type="password"] {
        width: 100%; padding: 0.625rem 0.75rem; font-size: 1rem; color: var(--fg);
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      }
      button {
        width: 100%; margin-top: 1rem; padding: 0.625rem 1rem; font-size: 1rem; font-weight: 500;
        color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
      }
      .error {
        margin: 0 0 1rem; padding: 0.625rem 0.75rem; font-size: 0.875rem; color: var(--danger);
        border: 1px solid currentColor; border-radius: 8px;
      }
    </style>
  </head>
  <body>
    <form method="post">
      <h1>Authorize access to Gong</h1>
      <p>This will let the application below read your Gong calls, transcripts and highlights. It cannot change anything.</p>
      ${args.error ? `<p class="error">${escapeHtml(args.error)}</p>` : ""}
      <dl>
        <dt>Application</dt>
        <dd>${escapeHtml(args.clientName || "Unnamed client")}</dd>
        <dt>Will return to</dt>
        <dd>${escapeHtml(args.redirectUri)}</dd>
      </dl>
      <label for="password">Authorization password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      ${hidden}
      <button type="submit">Approve</button>
    </form>
  </body>
</html>`;

  return new Response(html, {
    status: args.error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
