import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ControlClient } from "./control.js";
import type { DaemonInfo } from "./control.js";
import { pidAlive, readRuntime } from "./runtime.js";
import { startMcpServer } from "./mcp-server.js";
import { log } from "./log.js";

/**
 * MCP proxy: the process Claude Code launches per session. It holds no state —
 * it discovers the shared bridge daemon via the runtime file (auto-spawning it
 * detached if it isn't running) and forwards every tool/resource/prompt over
 * the control channel. Many sessions/projects thus share one browser feed.
 * All logs go to stderr (stdout is MCP JSON-RPC).
 */

const HOST = "127.0.0.1";
const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "bridge.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openControl(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", (e) => reject(e));
  });
}

/** Control port of a live daemon from the discovery file, or null. */
function liveControlPort(): number | null {
  const rt = readRuntime();
  return rt && pidAlive(rt.pid) ? rt.controlPort : null;
}

/** Connect to the daemon, spawning it detached if it isn't up yet. */
async function connectOrSpawn(): Promise<WebSocket> {
  const known = liveControlPort();
  if (known != null) {
    try {
      return await openControl(known);
    } catch {
      /* stale entry — fall through to spawn */
    }
  }

  log("starting Pigeon bridge daemon…");
  spawn(process.execPath, [BRIDGE_PATH], { detached: true, stdio: "ignore", env: process.env }).unref();

  const deadline = Date.now() + 8000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await sleep(150);
    const port = liveControlPort();
    if (port == null) continue;
    try {
      return await openControl(port);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not reach the Pigeon bridge: ${(lastErr as Error)?.message ?? "timeout"}`);
}

async function main(): Promise<void> {
  const client = new ControlClient(connectOrSpawn);
  const info = (await client.request("info")) as DaemonInfo;
  log(`connected to bridge (eval ${info.allowEval ? "ON" : "off"}, history ${info.hasStore ? "ON" : "off"})`);
  await startMcpServer(client, info);
  log("Pigeon MCP proxy ready");
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
