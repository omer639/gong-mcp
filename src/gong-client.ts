/**
 * Gong's global API host, which routes to the right cell for the credentials
 * presented. Some accounts are also reachable at a company-specific host such
 * as `https://us-18795.api.gong.io`; both accept the same keys, but the base URL
 * is configurable via GONG_API_BASE_URL for accounts where the cell host is
 * required, or if Gong's dashboard shows a different one.
 */
const DEFAULT_GONG_API_URL = "https://api.gong.io/v2";

function gongApiUrl(): string {
  const configured = process.env.GONG_API_BASE_URL?.trim();
  if (!configured) return DEFAULT_GONG_API_URL;
  const withoutTrailingSlash = configured.replace(/\/+$/, "");
  // Accept either the bare host or a URL that already includes the /v2 prefix.
  return /\/v\d+$/.test(withoutTrailingSlash) ? withoutTrailingSlash : `${withoutTrailingSlash}/v2`;
}

/** Gong returns at most 100 records per request and pages with an opaque cursor. */
const GONG_PAGE_SIZE = 100;

/**
 * Ceiling on cursor-following inside a single tool call. Gong's cursor pages are
 * sequential, so an unbounded loop is the easiest way to hit a function timeout.
 * Callers are told when this cap truncated their results.
 */
const DEFAULT_MAX_PAGES = 10;

export interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

/** One speaker's uninterrupted run of sentences. */
export interface GongMonologue {
  speakerId: string;
  topic?: string;
  sentences: Array<{ start: number; end?: number; text: string }>;
}

/**
 * Gong returns transcripts as one entry per call, each wrapping its own list of
 * monologues under `transcript` — the monologues do not carry the call ID.
 */
export interface GongCallTranscript {
  callId: string;
  transcript: GongMonologue[];
}

/**
 * A participant on a call.
 *
 * `speakerId` is what links a party to the monologues in a transcript, but it is
 * only set for parties Gong actually heard speak — invitees who never spoke, or
 * were never matched to a voice, carry `null`.
 */
export interface GongParty {
  id?: string;
  name?: string;
  emailAddress?: string;
  title?: string;
  userId?: string;
  speakerId?: string | null;
  /** "Internal", "External", or "Unknown". */
  affiliation?: string;
  methods?: string[];
}

export interface GongHighlight {
  title?: string;
  items?: Array<{ description: string; speakerId?: string; startTime?: number }>;
}

export interface GongCallHighlights {
  callId: string;
  highlights?: GongHighlight[];
  brief?: string;
  outline?: Array<{ title: string; duration?: number }>;
  callOutcome?: { outcome: string; description?: string };
  keyPoints?: Array<{ text: string }>;
}

export interface ListCallsResult {
  calls: GongCall[];
  /** Total matching the filter as reported by Gong, across all pages. */
  totalRecords?: number;
  /** True when the page ceiling stopped us before Gong ran out of pages. */
  truncated: boolean;
  /** Human-readable note attached whenever `truncated` is true. */
  note?: string;
}

/** Shape of the `records` envelope Gong wraps paged responses in. */
interface GongRecords {
  totalRecords?: number;
  currentPageSize?: number;
  currentPageNumber?: number;
  cursor?: string;
}

/**
 * Describes the credentials this deployment is actually using, for the server
 * logs only.
 *
 * Enough shape to spot a truncated secret or a key that was changed without
 * redeploying, without writing either value out in full. Never returned in a
 * response.
 */
function describeDeployedCredentials(origin: string): string {
  const shape = (name: string) => {
    const raw = process.env[name];
    if (!raw) return `${name}=<not set>`;
    const value = raw.trim();
    const edges = value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "<too short to mask>";
    const whitespace = raw !== value ? ", had surrounding whitespace" : "";
    return `${name}=${edges} (length ${value.length}${whitespace})`;
  };

  return (
    `Gong rejected these credentials. Host ${origin}. ` +
    `${shape("GONG_ACCESS_KEY")}; ${shape("GONG_ACCESS_SECRET")}. ` +
    "A Gong access key is 32 characters and the secret is a JWT of about 180. " +
    "If either looks short it was truncated on paste; if they are not the values you expect, " +
    "the deployment predates the change — redeploy after editing environment variables."
  );
}

export class GongApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GongApiError";
  }
}

export interface GongClientOptions {
  accessKey: string;
  accessSecret: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Minimal client for the Gong public API.
 *
 * Authentication is HTTP Basic with the access key as the username and the
 * access secret as the password, which is what Gong's public API expects.
 */
export class GongClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor({ accessKey, accessSecret, timeoutMs = 60_000 }: GongClientOptions) {
    this.authHeader = `Basic ${Buffer.from(`${accessKey}:${accessSecret}`).toString("base64")}`;
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    { params, body }: { params?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${gongApiUrl()}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new GongApiError(
          `Gong API request timed out after ${this.timeoutMs}ms (${method} ${path}). Try a narrower date range or fewer call IDs.`,
        );
      }
      throw new GongApiError(
        `Could not reach the Gong API (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        // To the deployment's private logs. A rejected key is indistinguishable
        // from a stale or truncated one from the outside, and the usual causes —
        // changing the variable without redeploying, or pasting only part of the
        // secret — are both visible in the shape of what actually got deployed.
        console.error(describeDeployedCredentials(url.origin));
      }
      const hint =
        response.status === 401 || response.status === 403
          ? " Check that GONG_ACCESS_KEY and GONG_ACCESS_SECRET are correct and that the key has the required scopes."
          : response.status === 429
            ? " Gong rate-limited this request; retry in a moment."
            : "";
      throw new GongApiError(
        `Gong API returned ${response.status} ${response.statusText} for ${method} ${path}.${hint}`,
        response.status,
        text.slice(0, 2_000),
      );
    }

    return (await response.json()) as T;
  }

  /**
   * List calls in a date range, most recent first.
   *
   * Gong pages this endpoint 100 records at a time and does not accept a sort
   * order, so "most recent first" requires collecting the pages before sorting.
   * Pagination is bounded by `maxPages`; when that bound is what stops the loop
   * the result is flagged `truncated` rather than silently short.
   */
  async listCalls({
    fromDateTime,
    toDateTime,
    limit,
    maxPages = DEFAULT_MAX_PAGES,
  }: {
    fromDateTime?: string;
    toDateTime?: string;
    limit?: number;
    maxPages?: number;
  } = {}): Promise<ListCallsResult> {
    // Default to the last 90 days so "recent calls" works without arguments.
    const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const collected: GongCall[] = [];
    let cursor: string | undefined;
    let totalRecords: number | undefined;
    let pages = 0;
    let exhausted = false;

    while (pages < maxPages) {
      const page = await this.request<{ calls?: GongCall[]; records?: GongRecords }>(
        "GET",
        "/calls",
        {
          params: {
            fromDateTime: fromDateTime ?? defaultFrom.toISOString(),
            toDateTime,
            cursor,
          },
        },
      );

      collected.push(...(page.calls ?? []));
      totalRecords = page.records?.totalRecords ?? totalRecords;
      pages += 1;

      cursor = page.records?.cursor;
      if (!cursor) {
        exhausted = true;
        break;
      }
    }

    // Sort newest first on whichever timestamp the call actually carries.
    const sorted = collected.sort((a, b) =>
      (b.started ?? b.scheduled ?? "").localeCompare(a.started ?? a.scheduled ?? ""),
    );
    const calls = limit != null ? sorted.slice(0, limit) : sorted;

    const truncated = !exhausted;
    return {
      calls,
      totalRecords,
      truncated,
      ...(truncated
        ? {
            note:
              `Stopped after ${pages} pages (${pages * GONG_PAGE_SIZE} calls max) of a larger result set` +
              `${totalRecords != null ? ` of ${totalRecords} total` : ""}. ` +
              `"Most recent first" therefore only ranks the calls that were fetched — ` +
              `narrow fromDateTime/toDateTime to get a complete, correctly ordered window.`,
          }
        : {}),
    };
  }

  async retrieveTranscripts(callIds: string[]): Promise<GongCallTranscript[]> {
    const response = await this.request<{ callTranscripts?: GongCallTranscript[] }>(
      "POST",
      "/calls/transcript",
      { body: { filter: { callIds } } },
    );
    return response.callTranscripts ?? [];
  }

  /**
   * Participants for the given calls, keyed by call ID.
   *
   * Transcripts identify speakers only by an opaque `speakerId`, so resolving
   * names needs this second endpoint. One request covers every requested call.
   */
  async getCallParties(callIds: string[]): Promise<Map<string, GongParty[]>> {
    const response = await this.request<{
      calls?: Array<{ metaData?: { id?: string }; parties?: GongParty[] }>;
    }>("POST", "/calls/extensive", {
      body: {
        filter: { callIds },
        contentSelector: { exposedFields: { parties: true } },
      },
    });

    const byCall = new Map<string, GongParty[]>();
    for (const call of response.calls ?? []) {
      const id = call.metaData?.id;
      if (id) byCall.set(id, call.parties ?? []);
    }
    return byCall;
  }

  async getCallHighlights(callId: string): Promise<GongCallHighlights> {
    const response = await this.request<{
      calls?: Array<{ metaData?: { id: string }; content?: Record<string, unknown> }>;
    }>("POST", "/calls/extensive", {
      body: {
        filter: { callIds: [callId] },
        contentSelector: {
          exposedFields: {
            content: {
              highlights: true,
              brief: true,
              outline: true,
              callOutcome: true,
              keyPoints: true,
            },
          },
        },
      },
    });

    const content = response.calls?.[0]?.content;
    if (!content) return { callId, highlights: [] };

    return {
      callId,
      highlights: content.highlights as GongHighlight[] | undefined,
      brief: content.brief as string | undefined,
      outline: content.outline as GongCallHighlights["outline"],
      callOutcome: content.callOutcome as GongCallHighlights["callOutcome"],
      keyPoints: content.keyPoints as GongCallHighlights["keyPoints"],
    };
  }
}

/**
 * Builds a client from the environment.
 *
 * This runs per request rather than at module load: on a serverless platform a
 * missing variable at import time takes the whole function down with an opaque
 * error, where a thrown error here surfaces as a readable tool result.
 */
export function gongClientFromEnv(): GongClient {
  const accessKey = process.env.GONG_ACCESS_KEY;
  const accessSecret = process.env.GONG_ACCESS_SECRET;

  if (!accessKey || !accessSecret) {
    throw new Error(
      "Gong credentials are not configured. Set GONG_ACCESS_KEY and GONG_ACCESS_SECRET " +
        "(locally in .env, on Vercel as encrypted environment variables).",
    );
  }

  const timeoutMs = Number(process.env.GONG_TIMEOUT_MS ?? "") || undefined;
  return new GongClient({ accessKey, accessSecret, timeoutMs });
}
