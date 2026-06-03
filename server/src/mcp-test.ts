/**
 * End-to-end smoke test of the bridge:
 *   1. spawn dist/index.js as an MCP server (stdio)
 *   2. serve a minified file + inline source map over HTTP
 *   3. push errors over a WebSocket
 *   4. drive the MCP tools through a real MCP client and assert results
 *
 * Covers: tool/resource discovery, wait_for_next_error, source-map resolution,
 * network-level events, pageUrl filtering, dedup, and clear.
 *
 * Standalone process — console.* is fine here. Exits non-zero on failure.
 */
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SourceMapGenerator } from "source-map-js";
import WebSocket from "ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

// --- Serve a minified file with an inline source map ------------------------
const gen = new SourceMapGenerator({ file: "app.min.js" });
gen.addMapping({
  generated: { line: 1, column: 10 },
  original: { line: 42, column: 6 },
  source: "webpack://demo/./src/App.tsx",
  name: "render",
});
const inlineMap =
  "data:application/json;base64," + Buffer.from(gen.toString(), "utf8").toString("base64");
const minified = `function n(){throw new Error("boom")}n();\n//# sourceMappingURL=${inlineMap}\n`;

const http = createServer((req, res) => {
  if (req.url === "/app.min.js") {
    res.writeHead(200, { "content-type": "application/javascript" }).end(minified);
  } else if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const PORT = (http.address() as AddressInfo).port;
const PAGE = `http://127.0.0.1:${PORT}/`;

// --- Spawn the bridge as an MCP server --------------------------------------
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "pigeon-e2e", version: "0.1.0" });
await client.connect(transport);
console.error("connected MCP client");

// 1. tools advertised
const names = (await client.listTools()).tools.map((t) => t.name).sort();
console.error("tools:", names.join(", "));
for (const expected of ["clear_errors", "get_error_stats", "get_recent_errors", "wait_for_next_error"]) {
  assert(names.includes(expected), `tool ${expected} present`);
}

// 2. resource advertised
const resources = await client.listResources();
assert(resources.resources.some((r) => r.uri === "pigeon://errors"), "pigeon://errors resource present");

// 3. wait_for_next_error unblocks on a pushed error whose stack references app.min.js
const waitPromise = client.callTool({ name: "wait_for_next_error", arguments: { timeout_ms: 5000 } });
await sleep(300);
const ws = new WebSocket("ws://127.0.0.1:8765");
await new Promise<void>((res, rej) => {
  ws.on("open", () => res());
  ws.on("error", rej);
});
const jsError = {
  level: "error",
  origin: "onerror",
  message: "boom",
  stack: `Error: boom\n    at n (${PAGE}app.min.js:1:11)`,
  pageUrl: PAGE,
  tabId: 7,
  tabTitle: "Demo",
  timestamp: Date.now(),
};
ws.send(JSON.stringify(jsError));
assert(textOf(await waitPromise).includes("boom"), "wait_for_next_error returned the pushed error");
console.error("wait_for_next_error OK");

// 4. source-map resolution flows through (async) — poll until resolvedStack appears
let resolvedSeen = false;
for (let i = 0; i < 20 && !resolvedSeen; i++) {
  await sleep(100);
  const recent = textOf(await client.callTool({ name: "get_recent_errors", arguments: { limit: 5 } }));
  if (recent.includes("App.tsx:42:7")) resolvedSeen = true;
}
assert(resolvedSeen, "resolvedStack maps app.min.js -> src/App.tsx:42:7");
console.error("source-map resolution OK");

// 5. network-level event + pageUrl filtering
ws.send(
  JSON.stringify({
    level: "network",
    origin: "fetch",
    message: `GET ${PAGE}api/users → 500 Internal Server Error`,
    source: `${PAGE}api/users`,
    status: 500,
    pageUrl: PAGE,
    tabId: 7,
    timestamp: Date.now(),
  }),
);
await sleep(150);
const networkOnly = textOf(
  await client.callTool({ name: "get_recent_errors", arguments: { level: "network" } }),
);
assert(networkOnly.includes("500") && networkOnly.includes("api/users"), "level=network filter returns the request");
const byPage = textOf(
  await client.callTool({ name: "get_recent_errors", arguments: { pageUrl: `127.0.0.1:${PORT}` } }),
);
assert(byPage.includes("boom"), "pageUrl filter returns errors for the page");
const stats = JSON.parse(textOf(await client.callTool({ name: "get_error_stats", arguments: {} })));
assert(stats.byLevel.network >= 1, "stats count network level");
console.error("network + filtering OK:", JSON.stringify(stats.byLevel));

// 6. prompts advertised and rendered with live buffer content
const promptNames = (await client.listPrompts()).prompts.map((p) => p.name).sort();
console.error("prompts:", promptNames.join(", "));
assert(
  promptNames.includes("analyze_browser_errors") && promptNames.includes("fix_latest_error"),
  "both prompts advertised",
);
const fixPrompt = await client.getPrompt({ name: "fix_latest_error", arguments: {} });
const fixText = (fixPrompt.messages ?? []).map((m: any) => m.content?.text ?? "").join("\n");
assert(fixText.includes("most recent browser error"), "fix_latest_error renders buffer content");
console.error("prompts OK");

// 7. clear, then dedup on a clean buffer
await client.callTool({ name: "clear_errors", arguments: {} });
const dup = { level: "warn", origin: "console.warn", message: "dup", stack: "x", pageUrl: PAGE, timestamp: Date.now() };
ws.send(JSON.stringify(dup));
ws.send(JSON.stringify(dup));
await sleep(150);
const afterDedup = JSON.parse(textOf(await client.callTool({ name: "get_error_stats", arguments: {} })));
assert(afterDedup.total === 1, `dedup keeps a single entry (got total=${afterDedup.total})`);
console.error("dedup OK");

// 7. clear empties the buffer
await client.callTool({ name: "clear_errors", arguments: {} });
const empty = JSON.parse(textOf(await client.callTool({ name: "get_error_stats", arguments: {} })));
assert(empty.total === 0, "buffer empty after clear");
console.error("clear OK");

ws.close();
http.close();
await client.close();
console.error("\nALL E2E CHECKS PASSED");
process.exit(0);
