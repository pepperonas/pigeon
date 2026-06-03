import { ErrorBuffer } from "./buffer.js";
import { startWebSocketServer } from "./ws-server.js";
import { startMcpServer } from "./mcp-server.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const buffer = new ErrorBuffer();
  startWebSocketServer(buffer);
  await startMcpServer(buffer);
  log("Pigeon bridge ready");
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
