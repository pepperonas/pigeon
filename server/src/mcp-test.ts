/**
 * End-to-end smoke test of the bridge:
 *   1. spawn dist/index.js as an MCP server (stdio)
 *   2. connect a WebSocket and push an error
 *   3. call the MCP tools through a real MCP client and assert results
 *
 * Standalone process — console.* is fine here. Exits non-zero on failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "pigeon-e2e", version: "0.1.0" });

await client.connect(transport);
console.error("connected MCP client");

// 1. tools are advertised
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.error("tools:", names.join(", "));
for (const expected of ["clear_errors", "get_error_stats", "get_recent_errors", "wait_for_next_error"]) {
  assert(names.includes(expected), `tool ${expected} present`);
}

// 2. resource is advertised
const resources = await client.listResources();
assert(
  resources.resources.some((r) => r.uri === "pigeon://errors"),
  "pigeon://errors resource present",
);

// 3. start a wait_for_next_error, then push an error over WS and confirm it unblocks
const waitPromise = client.callTool({ name: "wait_for_next_error", arguments: { timeout_ms: 5000 } });

await sleep(300); // let the WS server bind
const ws = new WebSocket("ws://127.0.0.1:8765");
await new Promise<void>((res, rej) => {
  ws.on("open", () => res());
  ws.on("error", rej);
});
const sample = {
  level: "error",
  origin: "console.error",
  message: "E2E boom",
  stack: "Error: E2E boom\n    at t (test.js:1:1)",
  pageUrl: "http://localhost:3000/",
  timestamp: Date.now(),
};
ws.send(JSON.stringify(sample));

const waited = textOf(await waitPromise);
assert(waited.includes("E2E boom"), "wait_for_next_error returned the pushed error");
console.error("wait_for_next_error unblocked OK");

await sleep(100);

// 4. get_recent_errors sees it
const recent = textOf(await client.callTool({ name: "get_recent_errors", arguments: { limit: 10 } }));
assert(recent.includes("E2E boom"), "get_recent_errors contains the error");

// 5. dedup: push the same error twice quickly → count should climb, total stays 1
ws.send(JSON.stringify(sample));
ws.send(JSON.stringify(sample));
await sleep(150);
const stats = JSON.parse(textOf(await client.callTool({ name: "get_error_stats", arguments: {} })));
assert(stats.total === 1, `dedup keeps a single entry (got total=${stats.total})`);
assert(stats.byLevel.error === 1, "one error-level entry");
console.error("dedup OK:", JSON.stringify(stats));

// 6. clear empties the buffer
const cleared = textOf(await client.callTool({ name: "clear_errors", arguments: {} }));
assert(/Cleared \d+/.test(cleared), "clear_errors reports a count");
const afterClear = JSON.parse(textOf(await client.callTool({ name: "get_error_stats", arguments: {} })));
assert(afterClear.total === 0, "buffer empty after clear");
console.error("clear OK");

ws.close();
await client.close();
console.error("\nALL E2E CHECKS PASSED");
process.exit(0);
