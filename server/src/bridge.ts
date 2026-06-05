import { randomBytes } from "node:crypto";
import { ErrorBuffer } from "./buffer.js";
import { CommandBus } from "./commandbus.js";
import { ErrorStore } from "./store.js";
import { startControlServer } from "./control.js";
import type { DaemonMeta } from "./control.js";
import { startWebSocketServer } from "./ws-server.js";
import { startDashboard } from "./dashboard.js";
import { acquireLock, releaseRuntime, writeRuntime } from "./runtime.js";
import { VERSION } from "./version.js";
import type { BufferedError } from "./types.js";
import { log } from "./log.js";

/**
 * Standalone Pigeon bridge daemon. Owns the extension WebSocket, the error
 * buffer + persistence + command bus, a control channel for MCP proxies, and a
 * local web dashboard.
 *
 * Ports are chosen cleverly so it runs out of the box: a lock file gives
 * single-daemon semantics, and the WS + control + dashboard servers each bind
 * the first free port at/after their base. The chosen ports are written to the
 * runtime discovery file that proxies read (and the extension scans the WS
 * range for).
 */

const HOST = "127.0.0.1";
const WS_BASE = Number(process.env.PIGEON_WS_PORT ?? 8765);
const CONTROL_BASE = Number(process.env.PIGEON_CONTROL_PORT ?? 8766);
const DASHBOARD_BASE = Number(process.env.PIGEON_DASHBOARD_PORT ?? 8767);
const DASHBOARD_ENABLED = process.env.PIGEON_DASHBOARD !== "0"; // on by default

async function main(): Promise<void> {
  if (!acquireLock()) {
    log("another Pigeon daemon is already running — exiting");
    process.exit(0);
  }

  // Tidy up the lock + discovery file on the way out.
  const cleanup = () => releaseRuntime();
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }

  const buffer = new ErrorBuffer();
  const commandBus = new CommandBus();
  const allowEval = process.env.PIGEON_ALLOW_EVAL === "1";

  let store: ErrorStore | undefined;
  if (process.env.PIGEON_DB) {
    store = new ErrorStore(process.env.PIGEON_DB);
    const history = await store.loadRecent(200);
    buffer.hydrate(history);
    buffer.on("new", (e: BufferedError) => void store!.append(e));
    log(`persistence ON → ${process.env.PIGEON_DB} (${history.length} entries loaded)`);
  }

  // Mutable metadata, shared with control + dashboard; ports filled after bind.
  const meta: DaemonMeta = {
    pid: process.pid,
    version: VERSION,
    startedAt: Date.now(),
    wsPort: 0,
    controlPort: 0,
  };
  const token = randomBytes(16).toString("hex");

  const control = await startControlServer(HOST, CONTROL_BASE, { buffer, commandBus, store, allowEval, meta });
  const ws = await startWebSocketServer(buffer, commandBus, WS_BASE);
  meta.wsPort = ws.port;
  meta.controlPort = control.port;

  if (DASHBOARD_ENABLED) {
    await startDashboard(HOST, DASHBOARD_BASE, {
      buffer,
      commandBus,
      store,
      allowEval,
      meta,
      token,
      listSessions: control.listSessions,
    });
  }

  writeRuntime({
    pid: process.pid,
    wsPort: ws.port,
    controlPort: control.port,
    startedAt: meta.startedAt,
    dashboardPort: meta.dashboardPort,
    token,
  });

  log(
    `Pigeon bridge daemon ready — extension ws:${ws.port}, control ws:${control.port}, ` +
      (meta.dashboardPort ? `dashboard http:${meta.dashboardPort}, ` : "dashboard off, ") +
      `eval ${allowEval ? "ON" : "off"}`,
  );
}

main().catch((e) => {
  releaseRuntime();
  log("bridge fatal:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
