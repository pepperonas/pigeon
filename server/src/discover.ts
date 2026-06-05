import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { pidAlive, readRuntime } from "./runtime.js";
import { log } from "./log.js";

/**
 * Daemon discovery shared by the MCP proxy (`index.ts`) and the `pigeon` CLI.
 * Both find the running bridge via the runtime file; the proxy may spawn one,
 * the CLI never does ("not running" is a valid answer there).
 */

export const HOST = "127.0.0.1";
const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "bridge.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openControl(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", (e) => reject(e));
  });
}

/** Control port of a live daemon from the discovery file, or null. */
export function liveControlPort(): number | null {
  const rt = readRuntime();
  return rt && pidAlive(rt.pid) ? rt.controlPort : null;
}

/** Connect to a running daemon, or null if none is up. Never spawns. */
export async function connectOnly(): Promise<WebSocket | null> {
  const port = liveControlPort();
  if (port == null) return null;
  try {
    return await openControl(port);
  } catch {
    return null;
  }
}

/** Connect to the daemon, spawning it detached if it isn't up yet. */
export async function connectOrSpawn(): Promise<WebSocket> {
  const known = liveControlPort();
  if (known != null) {
    // A live daemon is recorded — retry briefly (it may be mid-startup or busy)
    // before assuming it's gone and spawning a new one.
    for (let i = 0; i < 3; i++) {
      try {
        return await openControl(known);
      } catch {
        if (i < 2) await sleep(150);
      }
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

/**
 * Human-friendly name for the project a session runs in: the git repository
 * root's folder name, falling back to the cwd's folder name.
 */
export function projectName(cwd = process.cwd()): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    const top = r.status === 0 ? r.stdout.trim() : "";
    if (top) return basename(top);
  } catch {
    /* git missing or not a repo — fall back */
  }
  return basename(cwd) || cwd;
}
