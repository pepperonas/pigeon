import { ControlClient } from "./control.js";
import type { DaemonInfo } from "./control.js";
import { connectOrSpawn, projectName } from "./discover.js";
import { startMcpServer } from "./mcp-server.js";
import { VERSION } from "./version.js";
import { log } from "./log.js";

/**
 * MCP proxy: the process Claude Code launches per session. It holds no state —
 * it discovers the shared bridge daemon via the runtime file (auto-spawning it
 * detached if it isn't running) and forwards every tool/resource/prompt over
 * the control channel. Many sessions/projects thus share one browser feed.
 * All logs go to stderr (stdout is MCP JSON-RPC).
 */

async function main(): Promise<void> {
  // Identify this session so the CLI/dashboard can show which project it is.
  const identity = {
    pid: process.pid,
    cwd: process.cwd(),
    projectName: projectName(),
    clientStartedAt: Date.now(),
    mcpVersion: VERSION,
  };
  // Re-send register after every (re)connect, fire-and-forget.
  const client = new ControlClient(connectOrSpawn, (c) => c.notify("register", identity));

  const info = (await client.request("info")) as DaemonInfo;
  log(
    `connected to bridge (project "${identity.projectName}", eval ${info.allowEval ? "ON" : "off"}, ` +
      `history ${info.hasStore ? "ON" : "off"})`,
  );
  await startMcpServer(client, info);
  log("Pigeon MCP proxy ready");
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
