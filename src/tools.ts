import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  GongApiError,
  type GongCall,
  type GongCallTranscript,
  type GongClient,
  type GongParty,
} from "./gong-client.js";

/**
 * Ceiling on the text of a single tool result.
 *
 * Vercel Functions cap the response body at 4.5 MB, and this text is
 * JSON-escaped into the JSON-RPC envelope before it counts against that. A
 * result over the cap becomes a 413 with no usable error, so it is better to
 * refuse with an explanation than to emit it.
 */
const MAX_RESULT_BYTES = 2_000_000;

/** Transcripts are large; asking for too many calls at once cannot succeed. */
const MAX_CALL_IDS = 20;

/**
 * Ceiling on how many calls a single transcript search will scan.
 *
 * Search fetches the full transcript of every candidate call, so cost grows
 * with the window. This caps the work one invocation will do before it risks
 * the function timeout; when the window holds more calls than this, the search
 * scans the most recent `MAX_SEARCH_SCAN` and says so.
 */
const MAX_SEARCH_SCAN = 500;

/** Default scan size — one function call's worth of work without tuning. */
const DEFAULT_SEARCH_SCAN = 120;

/** Cap on snippets returned per matching call, so one chatty call can't dominate the result. */
const DEFAULT_SNIPPETS_PER_CALL = 5;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Serializes compactly — pretty-printing inflates transcript payloads for no benefit to the reader. */
function jsonResult(data: unknown, whatToNarrow: string): ToolResult {
  const text = JSON.stringify(data);
  return guardSize(text, whatToNarrow);
}

function guardSize(text: string, whatToNarrow: string): ToolResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_RESULT_BYTES) {
    return errorResult(
      `This result is ${(bytes / 1_000_000).toFixed(1)} MB, over the ${(MAX_RESULT_BYTES / 1_000_000).toFixed(1)} MB ` +
        `serverless response limit, so it cannot be returned. ${whatToNarrow}`,
    );
  }
  return textResult(text);
}

/** `mm:ss` from Gong's millisecond offsets. */
function timestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Maps `speakerId` to a display name for one call.
 *
 * Names are used bare on transcript lines to keep them short. Where two parties
 * share a name, affiliation is appended so the lines stay unambiguous.
 */
function buildSpeakerNames(parties: GongParty[]): Map<string, string> {
  const speaking = parties.filter(
    (party): party is GongParty & { speakerId: string } =>
      typeof party.speakerId === "string" && party.speakerId.length > 0 && !!party.name?.trim(),
  );

  const nameCounts = new Map<string, number>();
  for (const party of speaking) {
    const name = party.name!.trim();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const names = new Map<string, string>();
  for (const party of speaking) {
    const name = party.name!.trim();
    const ambiguous = (nameCounts.get(name) ?? 0) > 1;
    names.set(party.speakerId, ambiguous && party.affiliation ? `${name} (${party.affiliation})` : name);
  }
  return names;
}

/** One-line roster giving each speaker's affiliation and title once, up front. */
function formatRoster(parties: GongParty[]): string | undefined {
  const entries = parties
    .filter((party) => typeof party.speakerId === "string" && party.speakerId.length > 0 && party.name?.trim())
    .map((party) => {
      const qualifiers = [party.affiliation, party.title].filter(Boolean);
      return qualifiers.length > 0 ? `${party.name!.trim()} (${qualifiers.join(", ")})` : party.name!.trim();
    });
  return entries.length > 0 ? `Speakers: ${entries.join(" · ")}` : undefined;
}

/**
 * Renders transcripts as speaker-labeled lines.
 *
 * Gong's transcript JSON is one object per sentence, which costs several times
 * the bytes of the text it carries. Reading is the point of this tool, so this
 * is the default shape; `format: "json"` returns the raw payload.
 */
function formatTranscripts(
  callTranscripts: GongCallTranscript[],
  partiesByCall: Map<string, GongParty[]>,
): string {
  if (callTranscripts.length === 0) {
    return "No transcripts returned. The calls may not be transcribed yet, or the API key may lack access to them.";
  }

  const sections: string[] = [];
  for (const { callId, transcript } of callTranscripts) {
    const monologues = transcript ?? [];
    const parties = partiesByCall.get(callId) ?? [];
    const speakerNames = buildSpeakerNames(parties);
    const lines = [`## Call ${callId}`];

    const roster = formatRoster(parties);
    if (roster) lines.push(roster);

    if (monologues.length === 0) {
      lines.push("(no transcript content — the call may not be transcribed yet)");
    }

    // `topic` repeats on every monologue in a stretch; only note it when it changes.
    let currentTopic: string | undefined;
    for (const monologue of monologues) {
      const sentences = monologue.sentences ?? [];
      if (sentences.length === 0) continue;

      if (monologue.topic && monologue.topic !== currentTopic) {
        currentTopic = monologue.topic;
        lines.push(`\n### ${monologue.topic}`);
      }

      // Fall back to the raw ID for a speaker no party matched.
      const speaker = speakerNames.get(monologue.speakerId) ?? monologue.speakerId ?? "unknown";
      const text = sentences.map((sentence) => sentence.text).join(" ");
      lines.push(`[${timestamp(sentences[0].start)}] ${speaker}: ${text}`);
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

/** One transcript line that matched, with the phrases it hit. */
interface TranscriptSnippet {
  time: string;
  /** Raw Gong speaker ID, kept so a name can be filled in after matching. */
  speakerId: string;
  /** Display name once resolved; falls back to the raw ID. */
  speaker: string;
  text: string;
  matched: string[];
}

/** A call whose transcript matched the query, ranked and trimmed for the result. */
interface TranscriptMatch {
  callId: string;
  title?: string;
  url?: string;
  started?: string;
  /** Which of the query phrases appear anywhere in this call. */
  matchedPhrases: string[];
  /** Total transcript lines that hit at least one phrase (before snippet trimming). */
  matchingLines: number;
  snippets: TranscriptSnippet[];
}

/**
 * Scans one call's transcript for the query phrases.
 *
 * A call matches under `"all"` only when every phrase appears somewhere in the
 * call (not necessarily the same line); under `"any"` a single hit is enough.
 * Snippets are the individual lines that contain a phrase, capped so one long
 * call can't crowd out the rest of the results.
 */
function matchTranscript(
  call: { transcript: GongCallTranscript; meta?: GongCall },
  loweredPhrases: Array<{ original: string; lowered: string }>,
  matchMode: "any" | "all",
  maxSnippets: number,
): TranscriptMatch | undefined {
  const foundPhrases = new Set<string>();
  const snippets: TranscriptSnippet[] = [];
  let matchingLines = 0;

  for (const monologue of call.transcript.transcript ?? []) {
    const sentences = monologue.sentences ?? [];
    if (sentences.length === 0) continue;

    const text = sentences.map((sentence) => sentence.text).join(" ");
    const lowered = text.toLowerCase();
    const hits = loweredPhrases.filter((phrase) => lowered.includes(phrase.lowered));
    if (hits.length === 0) continue;

    matchingLines += 1;
    for (const hit of hits) foundPhrases.add(hit.original);

    if (snippets.length < maxSnippets) {
      const speakerId = monologue.speakerId ?? "unknown";
      snippets.push({
        time: timestamp(sentences[0].start),
        speakerId,
        // Filled in later for matched calls; the raw ID is a safe default.
        speaker: speakerId,
        text,
        matched: hits.map((hit) => hit.original),
      });
    }
  }

  const satisfied =
    matchMode === "all" ? foundPhrases.size === loweredPhrases.length : foundPhrases.size > 0;
  if (!satisfied) return undefined;

  const meta = call.meta;
  return {
    callId: call.transcript.callId,
    title: meta?.title,
    url: meta?.url,
    started: meta?.started ?? meta?.scheduled,
    matchedPhrases: [...foundPhrases],
    matchingLines,
    snippets,
  };
}

/**
 * Registers the Gong tools on a server instance.
 *
 * `getClient` is called per invocation so both entrypoints — stdio and the
 * Vercel HTTP function — can resolve credentials at request time and surface a
 * configuration problem as a tool error rather than a crash.
 */
export function registerGongTools(server: McpServer, getClient: () => GongClient): void {
  server.registerTool(
    "list_calls",
    {
      title: "List Gong calls",
      description:
        "List Gong calls, most recent first. Defaults to the last 90 days when no date range is given. " +
        "Returns call ID, title, start time, duration and URL. Pagination is bounded, so prefer a narrow " +
        "date range when the range holds more than a few hundred calls.",
      inputSchema: z.object({
        fromDateTime: z
          .string()
          .optional()
          .describe("Start of the range, ISO 8601 (e.g. 2026-03-01T00:00:00Z). Defaults to 90 days ago."),
        toDateTime: z
          .string()
          .optional()
          .describe("End of the range, ISO 8601 (e.g. 2026-03-31T23:59:59Z). Defaults to now."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum calls to return, most recent first. Defaults to everything fetched."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fromDateTime, toDateTime, limit }) => {
      try {
        const result = await getClient().listCalls({ fromDateTime, toDateTime, limit });
        return jsonResult(result, "Narrow the date range or set a smaller limit.");
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  server.registerTool(
    "retrieve_transcripts",
    {
      title: "Retrieve Gong call transcripts",
      description:
        "Retrieve transcripts for specific call IDs, as timestamped lines labeled with participant names. " +
        `Accepts up to ${MAX_CALL_IDS} call IDs per request; transcripts are large, so request a few at a time.`,
      inputSchema: z.object({
        callIds: z
          .array(z.string())
          .min(1)
          .max(MAX_CALL_IDS)
          .describe("Gong call IDs to retrieve transcripts for."),
        format: z
          .enum(["text", "json"])
          .default("text")
          .describe(
            "'text' (default) for readable speaker-labeled lines; 'json' for Gong's raw per-sentence payload.",
          ),
        resolveSpeakers: z
          .boolean()
          .default(true)
          .describe(
            "Look up participant names so speakers are named rather than shown as opaque IDs. " +
              "Costs one extra API request per call to this tool; set false to skip it.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ callIds, format, resolveSpeakers }) => {
      try {
        const client = getClient();

        // Speaker names come from a second endpoint. It is supplementary, so a
        // failure there (missing scope, say) degrades to raw speaker IDs rather
        // than losing the transcript. Both requests go out together.
        const [callTranscripts, partiesByCall] = await Promise.all([
          client.retrieveTranscripts(callIds),
          resolveSpeakers
            ? client.getCallParties(callIds).catch((error): Map<string, GongParty[]> => {
                console.error(`Could not resolve speaker names, falling back to speaker IDs: ${error}`);
                return new Map();
              })
            : Promise.resolve(new Map<string, GongParty[]>()),
        ]);

        const narrowingHint = "Request fewer call IDs per call.";
        if (format === "json") {
          const parties = Object.fromEntries(partiesByCall);
          return jsonResult(
            resolveSpeakers ? { callTranscripts, parties } : { callTranscripts },
            narrowingHint,
          );
        }
        return guardSize(formatTranscripts(callTranscripts, partiesByCall), narrowingHint);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  server.registerTool(
    "get_call_highlights",
    {
      title: "Get Gong call highlights",
      description:
        "Retrieve Gong's AI-generated highlights for one call: brief summary, key points, outcome and outline. " +
        "Highlights can take several hours after a call ends to become available.",
      inputSchema: z.object({
        callId: z.string().describe("The Gong call ID to retrieve highlights for."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ callId }) => {
      try {
        const highlights = await getClient().getCallHighlights(callId);
        return jsonResult(highlights, "Request a single call ID.");
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  server.registerTool(
    "search_call_transcripts",
    {
      title: "Search Gong call transcripts",
      description:
        "Find calls whose transcript mentions given words or phrases — the content search Gong's own API " +
        "does not offer (it filters calls by title and metadata only). Use this to answer questions like " +
        '"which calls asked about the Telegram data API?" or "who reported bug X?". ' +
        "Returns the matching calls, ranked by relevance, each with the exact transcript snippets, the speaker, " +
        "and a timestamp — then feed the call IDs to retrieve_transcripts for the full context.\n\n" +
        "How it works: it fetches and scans the transcripts of recent calls in the date range, so it is much " +
        "heavier than list_calls. Keep the date range tight and the query phrases specific. Matching is " +
        "case-insensitive substring matching, so include the variants a speaker might use " +
        '(e.g. ["Telegram data API", "Telegram API", "Telegram"]).',
      inputSchema: z.object({
        phrases: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe(
            'Words or phrases to look for in transcripts, e.g. ["Telegram data API", "Telegram API"]. ' +
              "A phrase matches as a case-insensitive substring of a spoken line.",
          ),
        matchMode: z
          .enum(["any", "all"])
          .default("any")
          .describe(
            "'any' (default) matches a call that mentions at least one phrase; 'all' requires every phrase " +
              "to appear somewhere in the same call.",
          ),
        fromDateTime: z
          .string()
          .optional()
          .describe("Start of the range to search, ISO 8601. Defaults to 90 days ago."),
        toDateTime: z
          .string()
          .optional()
          .describe("End of the range to search, ISO 8601. Defaults to now."),
        maxCalls: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_SCAN)
          .default(DEFAULT_SEARCH_SCAN)
          .describe(
            `How many of the most recent calls in the range to scan. Defaults to ${DEFAULT_SEARCH_SCAN}, ` +
              `capped at ${MAX_SEARCH_SCAN}. Each scanned call costs a transcript fetch, so a larger value ` +
              "is slower and can hit the request timeout — prefer narrowing the date range instead.",
          ),
        snippetsPerCall: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(DEFAULT_SNIPPETS_PER_CALL)
          .describe(`Maximum matching lines to return per call. Defaults to ${DEFAULT_SNIPPETS_PER_CALL}.`),
        resolveSpeakers: z
          .boolean()
          .default(true)
          .describe(
            "Name the speaker on each snippet instead of showing a raw ID. Costs one extra API request; " +
              "set false to skip it.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ phrases, matchMode, fromDateTime, toDateTime, maxCalls, snippetsPerCall, resolveSpeakers }) => {
      try {
        const client = getClient();

        // Which calls to scan: the most recent in the window, capped so the
        // transcript fetches that follow stay within one function's budget.
        const listed = await client.listCalls({ fromDateTime, toDateTime, limit: maxCalls });
        const candidates = listed.calls;
        if (candidates.length === 0) {
          return jsonResult(
            { query: { phrases, matchMode }, scanned: 0, matchCount: 0, matches: [] },
            "Widen the date range.",
          );
        }

        const metaById = new Map(candidates.map((call) => [call.id, call]));
        const transcripts = await client.retrieveTranscriptsForCalls(candidates.map((call) => call.id));

        const loweredPhrases = phrases.map((phrase) => ({
          original: phrase,
          lowered: phrase.toLowerCase(),
        }));

        const matches: TranscriptMatch[] = [];
        for (const transcript of transcripts) {
          const match = matchTranscript(
            { transcript, meta: metaById.get(transcript.callId) },
            loweredPhrases,
            matchMode,
            snippetsPerCall,
          );
          if (match) matches.push(match);
        }

        // Resolve speaker names only for the calls that matched — far fewer than
        // the scanned set — and degrade to raw IDs if the lookup fails.
        if (resolveSpeakers && matches.length > 0) {
          const partiesByCall = await client
            .getCallParties(matches.map((match) => match.callId))
            .catch((error): Map<string, GongParty[]> => {
              console.error(`Could not resolve speaker names, falling back to speaker IDs: ${error}`);
              return new Map();
            });
          for (const match of matches) {
            const names = buildSpeakerNames(partiesByCall.get(match.callId) ?? []);
            for (const snippet of match.snippets) {
              snippet.speaker = names.get(snippet.speakerId) ?? snippet.speakerId;
            }
          }
        }

        // Most relevant first: more distinct phrases hit, then more lines, then most recent.
        matches.sort(
          (a, b) =>
            b.matchedPhrases.length - a.matchedPhrases.length ||
            b.matchingLines - a.matchingLines ||
            (b.started ?? "").localeCompare(a.started ?? ""),
        );

        const notes: string[] = [];
        if (listed.truncated || candidates.length >= maxCalls) {
          notes.push(
            `Scanned the ${candidates.length} most recent calls in the range` +
              `${listed.totalRecords != null ? ` of ${listed.totalRecords} total` : ""}. ` +
              "Calls outside that window were not searched — narrow the date range, or raise maxCalls, " +
              "to cover the rest.",
          );
        }

        return jsonResult(
          {
            query: { phrases, matchMode },
            scanned: transcripts.length,
            matchCount: matches.length,
            ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
            matches,
          },
          "Return fewer snippets per call, use more specific phrases, or narrow the date range.",
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function describeError(error: unknown): string {
  if (error instanceof GongApiError) {
    return error.body ? `${error.message}\n\nGong response: ${error.body}` : error.message;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
