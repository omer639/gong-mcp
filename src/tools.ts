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

/** Turns of surrounding context returned on each side of a matching line. */
const DEFAULT_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 6;

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

type CallAffiliation = "external" | "internal" | "unknown";

/** Which side to filter by; "anyone" disables the filter. */
type Side = "external" | "internal" | "anyone";

/** One transcript turn — the matching line, or a line of surrounding context. */
interface SnippetTurn {
  time: string;
  /** Raw Gong speaker ID, kept so a name can be filled in after matching. */
  speakerId: string;
  /** Display name once resolved; falls back to the raw ID. */
  speaker: string;
  /** The speaker's affiliation, resolved from the call's parties. */
  affiliation: CallAffiliation;
  text: string;
  /** True on the line that actually hit the query (as opposed to context). */
  isMatch?: boolean;
  /** Phrases hit on this line; present only on the matching line. */
  matched?: string[];
}

/** A matching line together with the turns around it, in chronological order. */
interface Snippet {
  /** Phrases hit on the matching line. */
  matched: string[];
  turns: SnippetTurn[];
}

/** A call whose transcript matched the query, ranked and trimmed for the result. */
interface TranscriptMatch {
  callId: string;
  title?: string;
  url?: string;
  started?: string;
  /** Whether the call had an external participant; "unknown" when no party data was available. */
  affiliation?: CallAffiliation;
  /** Affiliation of the first speaker to mention the topic — who raised it. */
  topicRaisedBy?: CallAffiliation;
  /** Which of the query phrases appear in this call (under the mentionedBy filter, if any). */
  matchedPhrases: string[];
  /** Number of matching lines (after the mentionedBy filter), before snippet trimming. */
  matchingLines: number;
  snippets: Snippet[];
}

/**
 * Classifies a call by participant affiliation.
 *
 * A call counts as "external" (a customer/prospect call) if any party is
 * external, since a typical customer call also has internal reps on it. It is
 * "internal" only when parties are present and none are external. Missing party
 * data — a failed lookup, or a call Gong never tagged — is "unknown" rather than
 * silently assumed one way or the other.
 */
function classifyAffiliation(parties: GongParty[] | undefined): CallAffiliation {
  if (!parties || parties.length === 0) return "unknown";
  if (parties.some((party) => party.affiliation === "External")) return "external";
  if (parties.some((party) => party.affiliation === "Internal")) return "internal";
  return "unknown";
}

/** Maps each `speakerId` to its speaker's affiliation, for per-line direction/attribution. */
function buildSpeakerAffiliations(parties: GongParty[]): Map<string, CallAffiliation> {
  const sides = new Map<string, CallAffiliation>();
  for (const party of parties) {
    if (typeof party.speakerId === "string" && party.speakerId.length > 0) {
      sides.set(
        party.speakerId,
        party.affiliation === "External"
          ? "external"
          : party.affiliation === "Internal"
            ? "internal"
            : "unknown",
      );
    }
  }
  return sides;
}

/**
 * Fills in party-derived fields on matched calls once parties are known: the
 * call-level affiliation, each turn's speaker affiliation, and — when
 * `resolveNames` is set — each turn's speaker name.
 */
function annotateMatches(
  matches: TranscriptMatch[],
  partiesByCall: Map<string, GongParty[]>,
  resolveNames: boolean,
): void {
  for (const match of matches) {
    const parties = partiesByCall.get(match.callId) ?? [];
    match.affiliation = classifyAffiliation(parties.length > 0 ? parties : undefined);
    const names = resolveNames ? buildSpeakerNames(parties) : undefined;
    const sides = buildSpeakerAffiliations(parties);
    for (const snippet of match.snippets) {
      for (const turn of snippet.turns) {
        if (names) turn.speaker = names.get(turn.speakerId) ?? turn.speakerId;
        turn.affiliation = sides.get(turn.speakerId) ?? "unknown";
      }
    }
  }
}

/** One flattened transcript turn: a speaker's uninterrupted run of sentences. */
interface Turn {
  start: number;
  speakerId: string;
  text: string;
  lowered: string;
  /** Query phrases this turn hits. */
  hits: string[];
}

/**
 * Scans one call's transcript for the query phrases.
 *
 * A call matches under `"all"` only when every phrase appears somewhere in the
 * call (not necessarily the same line); under `"any"` a single hit is enough.
 *
 * `mentionedBy` restricts which speaker's lines count as a match (e.g. only what
 * an external participant said); `raisedBy` requires the *first* mention of the
 * topic in the call to come from a given side, which is the "who brought it up"
 * signal. Both need `affiliationBySpeaker`; when it is empty (party data
 * unavailable) neither filter is applied and affiliations come out "unknown".
 * Each returned snippet carries up to `contextLines` turns on either side so the
 * exchange around the mention is legible.
 */
function matchTranscript(
  call: { transcript: GongCallTranscript; meta?: GongCall },
  loweredPhrases: Array<{ original: string; lowered: string }>,
  opts: {
    matchMode: "any" | "all";
    mentionedBy: Side;
    raisedBy: Side;
    contextLines: number;
    maxSnippets: number;
    affiliationBySpeaker: Map<string, CallAffiliation>;
  },
): TranscriptMatch | undefined {
  const { matchMode, mentionedBy, raisedBy, contextLines, maxSnippets, affiliationBySpeaker } = opts;
  const sideOf = (speakerId: string): CallAffiliation => affiliationBySpeaker.get(speakerId) ?? "unknown";

  const turns: Turn[] = [];
  for (const monologue of call.transcript.transcript ?? []) {
    const sentences = monologue.sentences ?? [];
    if (sentences.length === 0) continue;
    const text = sentences.map((sentence) => sentence.text).join(" ");
    const lowered = text.toLowerCase();
    turns.push({
      start: sentences[0].start,
      speakerId: monologue.speakerId ?? "unknown",
      text,
      lowered,
      hits: loweredPhrases.filter((phrase) => lowered.includes(phrase.lowered)).map((phrase) => phrase.original),
    });
  }
  if (turns.length === 0) return undefined;

  // Who first mentioned the topic — the earliest turn (transcripts are in call
  // order) that hits any phrase, regardless of the mentionedBy filter.
  const firstMention = turns.find((turn) => turn.hits.length > 0);
  const topicRaisedBy = firstMention ? sideOf(firstMention.speakerId) : undefined;
  if (raisedBy !== "anyone" && topicRaisedBy !== raisedBy) return undefined;

  // Matching lines, honoring mentionedBy: a hit only counts if the speaker is on
  // the requested side. matchMode is evaluated over the phrases that survive it.
  const foundPhrases = new Set<string>();
  const matchIndices: number[] = [];
  turns.forEach((turn, index) => {
    if (turn.hits.length === 0) return;
    if (mentionedBy !== "anyone" && sideOf(turn.speakerId) !== mentionedBy) return;
    matchIndices.push(index);
    for (const hit of turn.hits) foundPhrases.add(hit);
  });

  const satisfied =
    matchMode === "all" ? foundPhrases.size === loweredPhrases.length : foundPhrases.size > 0;
  if (!satisfied) return undefined;

  const toTurn = (turn: Turn, isMatch: boolean): SnippetTurn => ({
    time: timestamp(turn.start),
    speakerId: turn.speakerId,
    // speaker/affiliation are filled in by annotateMatches; safe defaults here.
    speaker: turn.speakerId,
    affiliation: sideOf(turn.speakerId),
    text: turn.text,
    ...(isMatch ? { isMatch: true, matched: turn.hits } : {}),
  });

  const snippets: Snippet[] = [];
  for (const index of matchIndices.slice(0, maxSnippets)) {
    const from = Math.max(0, index - contextLines);
    const to = Math.min(turns.length - 1, index + contextLines);
    const groupTurns: SnippetTurn[] = [];
    for (let j = from; j <= to; j++) groupTurns.push(toTurn(turns[j], j === index));
    snippets.push({ matched: turns[index].hits, turns: groupTurns });
  }

  const meta = call.meta;
  return {
    callId: call.transcript.callId,
    title: meta?.title,
    url: meta?.url,
    started: meta?.started ?? meta?.scheduled,
    topicRaisedBy,
    matchedPhrases: [...foundPhrases],
    matchingLines: matchIndices.length,
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
        "By default it searches only customer/prospect calls (those with an external participant) and skips " +
        "internal team calls; set participants to widen or invert that. To tell apart who said something, use " +
        "mentionedBy (the side that spoke the matching line — e.g. only what the customer said) and raisedBy " +
        "(the side that mentioned the topic first — customer-initiated demand vs. we introduced it). Snippets " +
        "carry surrounding context lines and per-line speaker affiliation, so the caller can judge whether a " +
        "topic was pitched or asked about.\n\n" +
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
        participants: z
          .enum(["external", "internal", "all"])
          .default("external")
          .describe(
            "Which calls to search by participant affiliation. 'external' (default) restricts to customer/" +
              "prospect calls — those with at least one external participant — so internal team calls are " +
              "skipped; 'internal' keeps only calls with no external participant; 'all' searches everything. " +
              "Calls whose participant affiliation Gong did not record are reported separately, not silently dropped.",
          ),
        mentionedBy: z
          .enum(["external", "internal", "anyone"])
          .default("anyone")
          .describe(
            "Restrict matches to lines spoken by one side. 'external' keeps only what a customer/prospect " +
              "said (use this for \"the customer asked about X\"); 'internal' keeps only what your team said " +
              '(use this for "we brought up X"); \'anyone\' (default) does not filter by speaker. ' +
              "This is a line-level filter, distinct from participants, which is about who was on the call.",
          ),
        raisedBy: z
          .enum(["external", "internal", "anyone"])
          .default("anyone")
          .describe(
            "Keep only calls where the *first* mention of the topic came from this side — the 'who brought it " +
              "up' signal. 'external' finds customer-initiated demand (they raised it first); 'internal' finds " +
              "calls where your team introduced it; 'anyone' (default) does not filter. Each match reports " +
              "topicRaisedBy so you can see who mentioned it first regardless of this setting.",
          ),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT_LINES)
          .default(DEFAULT_CONTEXT_LINES)
          .describe(
            `Transcript turns to include on each side of a matching line, so the surrounding exchange is ` +
              `visible (helpful for judging whether something was pitched vs. asked). Defaults to ` +
              `${DEFAULT_CONTEXT_LINES}; 0 returns just the matching line. Capped at ${MAX_CONTEXT_LINES}.`,
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
    async ({
      phrases,
      matchMode,
      participants,
      mentionedBy,
      raisedBy,
      contextLines,
      fromDateTime,
      toDateTime,
      maxCalls,
      snippetsPerCall,
      resolveSpeakers,
    }) => {
      try {
        const client = getClient();
        const queryEcho = { phrases, matchMode, participants, mentionedBy, raisedBy, contextLines };

        // Which calls to consider: the most recent in the window, capped so the
        // transcript fetches that follow stay within one function's budget.
        const listed = await client.listCalls({ fromDateTime, toDateTime, limit: maxCalls });
        const candidates = listed.calls;
        if (candidates.length === 0) {
          return jsonResult({ query: queryEcho, scanned: 0, matchCount: 0, matches: [] }, "Widen the date range.");
        }

        const metaById = new Map(candidates.map((call) => [call.id, call]));
        const notes: string[] = [];

        // Anything that classifies speakers — the participants filter, the
        // per-line mentionedBy/raisedBy filters, or naming speakers — needs the
        // parties, which live on a separate endpoint. Fetch them once, up front:
        // for the participants filter this is also a net saving, since excluded
        // calls then never incur their (much larger) transcript fetch.
        const affiliationFilters = participants !== "all" || mentionedBy !== "anyone" || raisedBy !== "anyone";
        let candidateParties = new Map<string, GongParty[]>();
        if (affiliationFilters || resolveSpeakers) {
          candidateParties = await client
            .getCallParties(candidates.map((call) => call.id))
            .catch((error): Map<string, GongParty[]> => {
              console.error(`Could not fetch participant affiliation: ${error}`);
              return new Map();
            });
        }

        // If the lookup failed but affiliation-based filters were requested, fall
        // back to searching everything rather than silently returning nothing.
        let effParticipants = participants;
        let effMentionedBy = mentionedBy;
        let effRaisedBy = raisedBy;
        if (affiliationFilters && candidateParties.size === 0) {
          const disabled = [
            participants !== "all" ? `participants='${participants}'` : undefined,
            mentionedBy !== "anyone" ? `mentionedBy='${mentionedBy}'` : undefined,
            raisedBy !== "anyone" ? `raisedBy='${raisedBy}'` : undefined,
          ].filter(Boolean);
          effParticipants = "all";
          effMentionedBy = "anyone";
          effRaisedBy = "anyone";
          notes.push(
            `Could not determine participant affiliation (the lookup failed), so ${disabled.join(", ")} ` +
              `${disabled.length > 1 ? "were" : "was"} not applied and all calls in the window were searched.`,
          );
        }

        // Call-level participants filter: keep only external/internal calls.
        let toScan = candidates;
        if (effParticipants !== "all") {
          let excludedByFilter = 0;
          let undetermined = 0;
          toScan = candidates.filter((call) => {
            const affiliation = classifyAffiliation(candidateParties.get(call.id));
            if (affiliation === "unknown") {
              undetermined += 1;
              return false;
            }
            const keep =
              effParticipants === "external" ? affiliation === "external" : affiliation === "internal";
            if (!keep) excludedByFilter += 1;
            return keep;
          });
          const skipped = effParticipants === "external" ? "internal" : "external";
          notes.push(
            `participants='${effParticipants}': kept ${toScan.length} of ${candidates.length} calls, ` +
              `excluding ${excludedByFilter} ${skipped} call(s)` +
              (undetermined > 0
                ? ` and ${undetermined} whose affiliation Gong did not record (use participants='all' to include those)`
                : "") +
              ".",
          );
        }

        if (toScan.length === 0) {
          return jsonResult(
            {
              query: queryEcho,
              scanned: 0,
              matchCount: 0,
              ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
              matches: [],
            },
            "Set participants='all' to include internal or unclassified calls, or widen the date range.",
          );
        }

        const transcripts = await client.retrieveTranscriptsForCalls(toScan.map((call) => call.id));

        const loweredPhrases = phrases.map((phrase) => ({
          original: phrase,
          lowered: phrase.toLowerCase(),
        }));

        const matches: TranscriptMatch[] = [];
        for (const transcript of transcripts) {
          const match = matchTranscript({ transcript, meta: metaById.get(transcript.callId) }, loweredPhrases, {
            matchMode,
            mentionedBy: effMentionedBy,
            raisedBy: effRaisedBy,
            contextLines,
            maxSnippets: snippetsPerCall,
            affiliationBySpeaker: buildSpeakerAffiliations(candidateParties.get(transcript.callId) ?? []),
          });
          if (match) matches.push(match);
        }

        // Resolve display fields from the parties we already hold.
        if (matches.length > 0 && candidateParties.size > 0) {
          annotateMatches(matches, candidateParties, resolveSpeakers);
        }

        if (effMentionedBy !== "anyone" || effRaisedBy !== "anyone") {
          notes.push(
            "Line-level filters are active" +
              (effMentionedBy !== "anyone" ? `, mentionedBy='${effMentionedBy}'` : "") +
              (effRaisedBy !== "anyone" ? `, raisedBy='${effRaisedBy}'` : "") +
              ". Mentions on lines Gong could not attribute to a speaker are not counted by these filters.",
          );
        }

        // Most relevant first: more distinct phrases hit, then more lines, then most recent.
        matches.sort(
          (a, b) =>
            b.matchedPhrases.length - a.matchedPhrases.length ||
            b.matchingLines - a.matchingLines ||
            (b.started ?? "").localeCompare(a.started ?? ""),
        );

        if (listed.truncated || candidates.length >= maxCalls) {
          notes.push(
            `Considered the ${candidates.length} most recent calls in the range` +
              `${listed.totalRecords != null ? ` of ${listed.totalRecords} total` : ""}. ` +
              "Calls outside that window were not searched — narrow the date range, or raise maxCalls, " +
              "to cover the rest.",
          );
        }

        return jsonResult(
          {
            query: queryEcho,
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
