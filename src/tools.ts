import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  GongApiError,
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
}

function describeError(error: unknown): string {
  if (error instanceof GongApiError) {
    return error.body ? `${error.message}\n\nGong response: ${error.body}` : error.message;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
