import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

/**
 * Runtime coordination so Pigeon works out of the box even if its default ports
 * are taken: the daemon picks the first free port from a base, records its
 * chosen ports in a discovery file that MCP proxies read, and a lock file gives
 * single-daemon semantics. (The extension can't read files, so it scans a small
 * port range to find the daemon — see PORT_SCAN_RANGE.)
 */

export const PORT_SCAN_RANGE = 16; // daemon tries / extension scans this many ports from the base

export interface RuntimeInfo {
  pid: number;
  wsPort: number;
  controlPort: number;
  startedAt: number;
}

export function runtimeDir(): string {
  return process.env.PIGEON_RUNTIME_DIR || join(homedir(), ".pigeon");
}
function runtimeFile(): string {
  return join(runtimeDir(), "runtime.json");
}
function lockFile(): string {
  return join(runtimeDir(), "daemon.lock");
}
function ensureDir(): void {
  mkdirSync(runtimeDir(), { recursive: true });
}

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRuntime(): RuntimeInfo | null {
  return readJSON<RuntimeInfo>(runtimeFile());
}

export function writeRuntime(info: RuntimeInfo): void {
  ensureDir();
  writeFileSync(runtimeFile(), JSON.stringify(info));
}

/** Acquire the single-daemon lock. Returns false if a healthy daemon already holds it. */
export function acquireLock(): boolean {
  ensureDir();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile(), "wx"); // atomic exclusive create
      writeSync(fd, JSON.stringify({ pid: process.pid }));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = readJSON<{ pid: number }>(lockFile());
      if (info && pidAlive(info.pid)) return false; // a live daemon owns it
      try {
        unlinkSync(lockFile()); // stale (crashed) — reclaim and retry
      } catch {
        /* lost a race; loop retries */
      }
    }
  }
  return false;
}

export function releaseRuntime(): void {
  for (const p of [runtimeFile(), lockFile()]) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Create a WebSocketServer on the first free port at or after `startPort`,
 * trying up to PORT_SCAN_RANGE ports. Resolves once it's listening.
 */
export function bindWss(host: string, startPort: number): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryOne = () => {
      const wss = new WebSocketServer({ host, port });
      wss.once("listening", () => resolve({ wss, port }));
      wss.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < startPort + PORT_SCAN_RANGE) {
          port += 1;
          tryOne();
        } else {
          reject(e);
        }
      });
    };
    tryOne();
  });
}
