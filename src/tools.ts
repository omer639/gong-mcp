import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { GongApiError, type GongClient, type GongTranscript } from "./gong-client.js";

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
 * Renders transcripts as speaker-labeled lines.
 *
 * Gong's transcript JSON is one object per sentence, which costs several times
 * the bytes of the text it carries. Reading is the point of this tool, so this
 * is the default shape; `format: "json"` returns the raw payload.
 */
function formatTranscripts(transcripts: GongTranscript[]): string {
  if (transcripts.length === 0) {
    return "No transcripts returned. The calls may not be transcribed yet, or the API key may lack access to them.";
  }

  const byCall = new Map<string, GongTranscript[]>();
  for (const transcript of transcripts) {
    const key = transcript.callId ?? "(unknown call)";
    const existing = byCall.get(key);
    if (existing) existing.push(transcript);
    else byCall.set(key, [transcript]);
  }

  const sections: string[] = [];
  for (const [callId, monologues] of byCall) {
    const lines = [`## Call ${callId}`];
    for (const monologue of monologues) {
      const sentences = monologue.sentences ?? [];
      if (sentences.length === 0) continue;
      const speaker = monologue.speakerId ?? "unknown";
      const topic = monologue.topic ? ` (${monologue.topic})` : "";
      const text = sentences.map((sentence) => sentence.text).join(" ");
      lines.push(`[${timestamp(sentences[0].start)}] ${speaker}${topic}: ${text}`);
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
        "Retrieve transcripts for specific call IDs, as speaker-labeled timestamped lines. " +
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
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ callIds, format }) => {
      try {
        const transcripts = await getClient().retrieveTranscripts(callIds);
        const narrowingHint = "Request fewer call IDs per call.";
        return format === "json"
          ? jsonResult({ transcripts }, narrowingHint)
          : guardSize(formatTranscripts(transcripts), narrowingHint);
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
