#!/usr/bin/env node

/**
 * stdio entrypoint — for running the server locally as a subprocess of an MCP
 * client (Claude Desktop, Claude Code, the Docker image).
 *
 * The HTTP entrypoint used by the Vercel deployment lives in `api/mcp.ts`; both
 * register the same tools from `./tools.js`.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import dotenv from "dotenv";

import { gongClientFromEnv } from "./gong-client.js";
import { registerGongTools } from "./tools.js";

// stdout is the MCP wire on this transport, so anything logged there corrupts
// the protocol stream. Push stray logging to stderr.
const originalError = console.error.bind(console);
console.log = originalError;
console.info = originalError;
console.warn = originalError;
console.debug = originalError;

dotenv.config({ quiet: true });

serveStdio(() => {
  const server = new McpServer(
    { name: "gong-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  registerGongTools(server, gongClientFromEnv);
  return server;
});
