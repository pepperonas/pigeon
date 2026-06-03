import { ErrorBuffer } from "./buffer.js";
import { CommandBus } from "./commandbus.js";
import { ErrorStore } from "./store.js";
import { startWebSocketServer } from "./ws-server.js";
import { startMcpServer } from "./mcp-server.js";
import type { BufferedError } from "./types.js";
import { log } from "./log.js";

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

  startWebSocketServer(buffer, commandBus);
  await startMcpServer(buffer, commandBus, store);
  log("Pigeon bridge ready");
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
