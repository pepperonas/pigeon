/**
 * Dashboard test: spawns the daemon with isolated ports + runtime dir, pushes
 * an error over the extension WebSocket, and exercises the dashboard HTTP API —
 * token gating, /api/state contents, the served page, and clear.
 *
 * Standalone process — console.* is fine. Exits non-zero on failure.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { readRuntime } from "./runtime.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const RUNTIME_DIR = mkdtempSync(join(tmpdir(), "pigeon-rt-dash-"));
process.env.PIGEON_RUNTIME_DIR = RUNTIME_DIR; // so readRuntime() in this process reads the same file
const env = {
  ...process.env,
  PIGEON_RUNTIME_DIR: RUNTIME_DIR,
  PIGEON_WS_PORT: "8965",
  PIGEON_CONTROL_PORT: "8966",
  PIGEON_DASHBOARD_PORT: "8967",
  PIGEON_DB: join(RUNTIME_DIR, "history.jsonl"), // exercise the History tab/endpoint
} as Record<string, string>;

const daemon = spawn("node", ["dist/bridge.js"], { env, stdio: "inherit" });

async function shutdown(): Promise<void> {
  const rt = readRuntime();
  if (rt) {
    try {
      const cws = new WebSocket(`ws://127.0.0.1:${rt.controlPort}`);
      await new Promise<void>((res) => {
        cws.on("open", () => res());
        cws.on("error", () => res());
      });
      cws.send(JSON.stringify({ id: "x", method: "shutdown" }));
      await sleep(150);
      cws.close();
    } catch {
      /* ignore */
    }
  }
  try {
    daemon.kill();
  } catch {
    /* ignore */
  }
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // Wait for the daemon to advertise its ports + token.
  let rt = readRuntime();
  const deadline = Date.now() + 8000;
  while ((!rt || !rt.dashboardPort || !rt.token) && Date.now() < deadline) {
    await sleep(150);
    rt = readRuntime();
  }
  assert(rt?.dashboardPort && rt.token, "daemon advertised a dashboard port + token");
  const base = `http://127.0.0.1:${rt!.dashboardPort}`;
  const token = rt!.token!;

  // Feed one error through the extension WebSocket.
  const ws = new WebSocket(`ws://127.0.0.1:${rt!.wsPort}`);
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ level: "error", origin: "onerror", message: "DASH_MARKER", pageUrl: "http://localhost:3000/", timestamp: Date.now() }));
  // An event whose pageUrl is the dashboard itself must be dropped by the daemon.
  ws.send(JSON.stringify({ level: "network", origin: "fetch", message: "SELF_DASH_DROP", status: 403, pageUrl: `http://127.0.0.1:${rt!.dashboardPort}/`, timestamp: Date.now() }));
  await sleep(250);

  // /api/state requires the token.
  const noTok = await fetch(`${base}/api/state`);
  assert(noTok.status === 403, "/api/state without token is rejected (403)");

  const ok = await fetch(`${base}/api/state`, { headers: { "x-pigeon-token": token } });
  assert(ok.status === 200, "/api/state with token is accepted");
  const state = (await ok.json()) as { errors: { message: string }[]; info: { version: string; dashboardPort: number } };
  assert(state.errors.some((e) => e.message.includes("DASH_MARKER")), "state includes the pushed error");
  assert(!state.errors.some((e) => e.message.includes("SELF_DASH_DROP")), "daemon drops events captured from its own dashboard");
  assert(state.info.dashboardPort === rt!.dashboardPort, "state reports the dashboard port");
  console.log("token gating + state + self-capture drop OK");

  // The served page embeds the token so its own fetches authenticate.
  const page = await (await fetch(`${base}/`)).text();
  assert(page.includes(token), "served page embeds the API token");
  assert(/Pigeon/.test(page), "served page is the dashboard");
  console.log("page serve OK");

  // Clear via the API empties the buffer.
  const cleared = await fetch(`${base}/api/clear`, { method: "POST", headers: { "x-pigeon-token": token } });
  assert(cleared.status === 200, "clear accepted");
  await sleep(100);
  const after = (await (await fetch(`${base}/api/state`, { headers: { "x-pigeon-token": token } })).json()) as { errors: unknown[] };
  assert(after.errors.length === 0, "buffer is empty after clear");
  console.log("clear OK");

  // History (PIGEON_DB) persists the error even after the buffer was cleared.
  const hist = (await (await fetch(`${base}/api/history`, { headers: { "x-pigeon-token": token } })).json()) as {
    enabled: boolean;
    errors: { message: string }[];
  };
  assert(hist.enabled === true, "history endpoint reports enabled (PIGEON_DB set)");
  assert(hist.errors.some((e) => e.message.includes("DASH_MARKER")), "history still has the error after buffer clear");
  console.log("history persistence OK");

  ws.close();
  console.log("\nDASHBOARD CHECKS PASSED");
}

main()
  .then(async () => {
    await shutdown();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nDASHBOARD CHECKS FAILED:", e instanceof Error ? e.message : String(e));
    await shutdown();
    process.exit(1);
  });
