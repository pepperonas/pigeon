import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ControlClient } from "./control.js";
import type { DaemonInfo } from "./control.js";
import { startMcpServer } from "./mcp-server.js";
import { log } from "./log.js";

/**
 * MCP proxy: the process Claude Code launches per session. It does NOT own the
 * buffer or the browser WebSocket — it connects to the shared bridge daemon
 * over the control channel (auto-spawning the daemon if it isn't running), and
 * forwards every tool/resource/prompt to it. This lets many sessions/projects
 * share one browser feed. All logs go to stderr (stdout is MCP JSON-RPC).
 */

const HOST = "127.0.0.1";
const CONTROL_PORT = Number(process.env.PIGEON_CONTROL_PORT ?? 8766);
const CONTROL_URL = `ws://${HOST}:${CONTROL_PORT}`;
const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "bridge.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a socket to the control channel. */
function openControl(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONTROL_URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", (e) => reject(e));
  });
}

/** Connect to the daemon, spawning it detached if it isn't up yet. */
async function connectOrSpawn(): Promise<WebSocket> {
  try {
    return await openControl();
  } catch {
    /* not running — spawn it */
  }
  log("starting Pigeon bridge daemon…");
  spawn(process.execPath, [BRIDGE_PATH], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();

  const deadline = Date.now() + 8000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      return await openControl();
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
