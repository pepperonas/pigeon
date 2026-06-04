import { ErrorBuffer } from "./buffer.js";
import { CommandBus } from "./commandbus.js";
import { ErrorStore } from "./store.js";
import { startControlServer } from "./control.js";
import { startWebSocketServer } from "./ws-server.js";
import type { BufferedError } from "./types.js";
import { log } from "./log.js";

/**
 * Standalone Pigeon bridge daemon. Owns the WebSocket server the extension
 * connects to (:8765), the error buffer + persistence + command bus, and a
 * control channel (:8766) that per-session MCP proxies connect to.
 *
 * One daemon serves every Claude Code session and every dev project at once.
 * The control port is the singleton lock: if it's already bound, another daemon
 * is running and we exit cleanly.
 */

const HOST = "127.0.0.1";
const CONTROL_PORT = Number(process.env.PIGEON_CONTROL_PORT ?? 8766);

async function main(): Promise<void> {
  const buffer = new ErrorBuffer();
  const commandBus = new CommandBus();

  let store: ErrorStore | undefined;
  if (process.env.PIGEON_DB) {
    store = new ErrorStore(process.env.PIGEON_DB);
    const history = await store.loadRecent(200);
    buffer.hydrate(history);
    buffer.on("new", (e: BufferedError) => void store!.append(e));
    log(`persistence ON → ${process.env.PIGEON_DB} (${history.length} entries loaded)`);
  }

  // Bind the control port first — it's the singleton lock.
  const control = startControlServer(HOST, CONTROL_PORT, {
    buffer,
    commandBus,
    store,
    allowEval: process.env.PIGEON_ALLOW_EVAL === "1",
  });
  await new Promise<void>((resolve, reject) => {
    control.on("listening", () => resolve());
    control.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        log(`control port ${CONTROL_PORT} already in use — another bridge is running, exiting`);
        process.exit(0);
      }
      reject(e);
    });
  });

  // Now the extension-facing WebSocket server.
  startWebSocketServer(buffer, commandBus);

  log(
    `Pigeon bridge daemon ready (eval ${process.env.PIGEON_ALLOW_EVAL === "1" ? "ON" : "off"})`,
  );
}

main().catch((e) => {
  log("bridge fatal:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
