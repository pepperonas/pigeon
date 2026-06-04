/**
 * Multi-session test: two MCP proxies (two "Claude Code sessions") share ONE
 * auto-spawned bridge daemon. Verifies they see the same buffer and that each
 * scopes to its own project via the pageUrl filter.
 *
 * Standalone process — console.* is fine. Exits non-zero on failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any): string => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const WS_PORT = 8867;
const CONTROL_PORT = 8868;

async function shutdownDaemon(): Promise<void> {
  try {
    const cws = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}`);
    await new Promise<void>((res, rej) => {
      cws.on("open", () => res());
      cws.on("error", rej);
    });
    cws.send(JSON.stringify({ id: "shutdown", method: "shutdown" }));
    await sleep(200);
    cws.close();
  } catch {
    /* nothing running */
  }
}

function makeClient(name: string) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "inherit",
    env: {
      ...process.env,
      PIGEON_WS_PORT: String(WS_PORT),
      PIGEON_CONTROL_PORT: String(CONTROL_PORT),
    } as Record<string, string>,
  });
  return { client: new Client({ name, version: "0.1.0" }), transport };
}

await shutdownDaemon();

// Session 1 starts the daemon; session 2 connects to the same one.
const a = makeClient("session-A");
await a.client.connect(a.transport);
const b = makeClient("session-B");
await b.client.connect(b.transport);
console.error("two MCP proxies connected");

// Mock extension feeds the shared bridge.
const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
await new Promise<void>((res, rej) => {
  ws.on("open", () => res());
  ws.on("error", rej);
});

const PAGE_A = "http://localhost:3000/"; // e.g. viacamp
const PAGE_B = "http://localhost:5173/"; // e.g. another project
ws.send(JSON.stringify({ level: "error", origin: "onerror", message: "errA-3000", pageUrl: PAGE_A, tabId: 1, timestamp: Date.now() }));
ws.send(JSON.stringify({ level: "error", origin: "onerror", message: "errB-5173", pageUrl: PAGE_B, tabId: 2, timestamp: Date.now() }));
await sleep(250);

// Both sessions see the shared buffer.
const allFromA = textOf(await a.client.callTool({ name: "get_recent_errors", arguments: { limit: 50 } }));
assert(allFromA.includes("errA-3000") && allFromA.includes("errB-5173"), "session A sees both errors (shared buffer)");
const allFromB = textOf(await b.client.callTool({ name: "get_recent_errors", arguments: { limit: 50 } }));
assert(allFromB.includes("errA-3000") && allFromB.includes("errB-5173"), "session B sees both errors (shared buffer)");

// Each session scopes to its project via pageUrl.
const aScoped = textOf(await a.client.callTool({ name: "get_recent_errors", arguments: { pageUrl: "3000" } }));
assert(aScoped.includes("errA-3000") && !aScoped.includes("errB-5173"), "session A pageUrl=3000 sees only its project");
const bScoped = textOf(await b.client.callTool({ name: "get_recent_errors", arguments: { pageUrl: "5173" } }));
assert(bScoped.includes("errB-5173") && !bScoped.includes("errA-3000"), "session B pageUrl=5173 sees only its project");
console.error("cross-project pageUrl scoping OK");

// Shared state: clearing from A empties B's view too (same daemon).
await a.client.callTool({ name: "clear_errors", arguments: {} });
await sleep(100);
const bStats = JSON.parse(textOf(await b.client.callTool({ name: "get_error_stats", arguments: {} })));
assert(bStats.total === 0, "clear from session A is visible to session B (single shared daemon)");
console.error("shared-daemon state OK");

ws.close();
await a.client.close();
await b.client.close();
await shutdownDaemon();
console.error("\nMULTI-SESSION CHECKS PASSED");
process.exit(0);
