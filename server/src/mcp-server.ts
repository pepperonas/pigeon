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
        "Return buffered browser errors, newest first: console.error/warn, uncaught " +
        "exceptions, unhandled rejections, and failed network requests. " +
        "Optionally filter by level, page URL, or a `since` timestamp (epoch ms).",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional()
          .describe("Maximum number of errors to return."),
        level: z.enum(["error", "warn", "network"]).optional()
          .describe("Only return errors of this level ('network' = failed requests)."),
        pageUrl: z.string().optional()
          .describe("Only errors whose page URL contains this substring (case-insensitive)."),
        since: z.number().optional()
          .describe("Epoch milliseconds; only errors last seen at or after this time."),
      },
    },
    async ({ limit, level, pageUrl, since }) => {
      const items = buffer.getRecent({ limit, level, pageUrl, since });
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

  // --- Prompts (surface as slash-commands in Claude Code) ------------------

  server.registerPrompt(
    "analyze_browser_errors",
    {
      title: "Analyze browser errors",
      description:
        "Pull recent browser errors from Pigeon and analyze likely root causes, " +
        "grouped, with concrete fixes.",
      argsSchema: {
        limit: z.string().optional().describe("How many recent errors to include (default 20)."),
        level: z.enum(["error", "warn", "network"]).optional().describe("Only this level."),
        pageUrl: z.string().optional().describe("Only errors whose page URL contains this substring."),
      },
    },
    ({ limit, level, pageUrl }) => {
      const n = limit ? Math.max(1, Math.min(200, parseInt(limit, 10) || 20)) : 20;
      const items = buffer.getRecent({ limit: n, level, pageUrl });
      const body = items.length ? JSON.stringify(items, null, 2) : "(no errors are currently buffered)";
      const scope =
        (level ? ` (level=${level})` : "") + (pageUrl ? ` (page contains "${pageUrl}")` : "");
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `These are the ${items.length} most recent browser error(s) captured by Pigeon${scope}. ` +
                "Prefer `resolvedStack` over `stack` when present — it points at original source.\n\n" +
                "```json\n" + body + "\n```\n\n" +
                "Group them by likely root cause, explain each, and propose concrete code fixes. " +
                "If you need a fresh repro, use the `wait_for_next_error` tool.",
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "fix_latest_error",
    {
      title: "Fix the latest browser error",
      description: "Focus on the single most recent browser error and propose a fix.",
      argsSchema: {},
    },
    () => {
      const [latest] = buffer.getRecent({ limit: 1 });
      const text = latest
        ? "The most recent browser error captured by Pigeon:\n\n```json\n" +
          JSON.stringify(latest, null, 2) +
          "\n```\n\nUse `resolvedStack` if present. Locate the offending code, explain the cause, " +
          "and propose a fix."
        : "No browser errors are currently buffered. Ask me to reproduce the issue, then call " +
          "the `wait_for_next_error` tool.";
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected over stdio");
  return server;
}
