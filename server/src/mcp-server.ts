import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ErrorBuffer } from "./buffer.js";
import { log } from "./log.js";

const ERRORS_URI = "pigeon://errors";

export async function startMcpServer(buffer: ErrorBuffer): Promise<McpServer> {
  const server = new McpServer({ name: "pigeon", version: "0.1.0" });

  server.registerTool(
    "get_recent_errors",
    {
      title: "Get recent browser errors",
      description:
        "Return buffered browser console errors and uncaught exceptions, newest first. " +
        "Optionally filter by level or by a `since` timestamp (epoch ms).",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional()
          .describe("Maximum number of errors to return."),
        level: z.enum(["error", "warn"]).optional()
          .describe("Only return errors of this level."),
        since: z.number().optional()
          .describe("Epoch milliseconds; only errors last seen at or after this time."),
      },
    },
    async ({ limit, level, since }) => {
      const items = buffer.getRecent({ limit, level, since });
      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
      };
    },
  );

  server.registerTool(
    "clear_errors",
    {
      title: "Clear the error buffer",
      description: "Discard all buffered browser errors. Returns how many were cleared.",
      inputSchema: {},
    },
    async () => {
      const n = buffer.clear();
      return { content: [{ type: "text", text: `Cleared ${n} buffered error(s).` }] };
    },
  );

  server.registerTool(
    "wait_for_next_error",
    {
      title: "Wait for the next browser error",
      description:
        "Block until a new browser error arrives or the timeout elapses. " +
        "Useful for: 'reproduce the bug in the browser, then check'. " +
        "Returns the new error as JSON, or a timeout notice.",
      inputSchema: {
        timeout_ms: z.number().int().positive().max(600000).optional()
          .describe("How long to wait in milliseconds (default 30000)."),
      },
    },
    async ({ timeout_ms }) => {
      const ev = await buffer.waitForNext(timeout_ms ?? 30000);
      return {
        content: [
          {
            type: "text",
            text: ev ? JSON.stringify(ev, null, 2) : "No new error arrived within the timeout.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_error_stats",
    {
      title: "Get error statistics",
      description: "Return counts per level, total buffered, and the newest/oldest timestamps.",
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(buffer.stats(), null, 2) }] };
    },
  );

  server.registerResource(
    "errors",
    ERRORS_URI,
    {
      title: "Browser console errors",
      description: "Live snapshot of buffered browser errors as JSON (newest first).",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(buffer.getRecent(), null, 2),
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected over stdio");
  return server;
}
