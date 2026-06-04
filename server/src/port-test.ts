/**
 * Clever-port test: with the default ports occupied by unrelated servers, the
 * daemon must shift to free ports, record them in the runtime discovery file,
 * and still be reachable on the control channel. Proves out-of-the-box startup.
 *
 * Standalone process — console.* is fine. Exits non-zero on failure.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { readRuntime } from "./runtime.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const WS_BASE = 8765;
const CONTROL_BASE = 8766;
const RUNTIME_DIR = mkdtempSync(join(tmpdir(), "pigeon-ports-"));
process.env.PIGEON_RUNTIME_DIR = RUNTIME_DIR;

// Occupy the default ports with unrelated servers.
const blockers = [];
for (const p of [WS_BASE, CONTROL_BASE]) {
  const s = createServer(() => {});
  await new Promise<void>((res, rej) => {
    s.once("error", rej);
    s.listen(p, "127.0.0.1", () => res());
  });
  blockers.push(s);
}
console.error(`occupied ${WS_BASE} + ${CONTROL_BASE}`);

spawn(process.execPath, ["dist/bridge.js"], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env },
}).unref();

// Wait for the daemon to record its chosen ports.
let rt = readRuntime();
for (let i = 0; i < 40 && !rt; i++) {
  await sleep(150);
  rt = readRuntime();
}
console.error("runtime.json:", JSON.stringify(rt));
assert(rt, "daemon wrote the runtime discovery file");
assert(rt!.wsPort > WS_BASE, `WS port shifted past ${WS_BASE} (got ${rt!.wsPort})`);
assert(rt!.controlPort > CONTROL_BASE, `control port shifted past ${CONTROL_BASE} (got ${rt!.controlPort})`);

// The shifted control port must actually work.
const ctrl = new WebSocket(`ws://127.0.0.1:${rt!.controlPort}`);
await new Promise<void>((res, rej) => {
  ctrl.on("open", () => res());
  ctrl.on("error", rej);
});
const info = await new Promise<any>((resolve) => {
  ctrl.on("message", (d) => resolve(JSON.parse(d.toString())));
  ctrl.send(JSON.stringify({ id: "i", method: "info" }));
});
assert(info.ok && info.result && typeof info.result.allowEval === "boolean", "control channel answers on the shifted port");
console.error("control reachable on shifted port OK");

// Cleanup: shut the daemon down, release the blockers.
ctrl.send(JSON.stringify({ id: "s", method: "shutdown" }));
await sleep(300);
ctrl.close();
for (const s of blockers) s.close();
rmSync(RUNTIME_DIR, { recursive: true, force: true });
console.error("\nPORT-FALLBACK CHECKS PASSED");
process.exit(0);
