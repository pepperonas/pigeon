#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "./control.js";
import type { DaemonInfo, SessionInfo } from "./control.js";
import type { ErrorStats } from "./types.js";
import { openControl, liveControlPort } from "./discover.js";
import { readRuntime, pidAlive, runtimeDir } from "./runtime.js";
import { VERSION } from "./version.js";

/**
 * `pigeon` user CLI: inspect and control the shared bridge daemon. Unlike the
 * MCP proxy, stdout is free here — this is a normal terminal program.
 *
 *   pigeon status     # daemon health, ports, buffer, connected sessions
 *   pigeon doctor     # actionable PASS/WARN/FAIL checks
 *   pigeon stop       # shut the daemon down gracefully
 *   pigeon dashboard  # open the web dashboard in a browser
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function fmtAgo(t?: number): string {
  if (!t) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Open a client to a running daemon, or null if none is up (never spawns). */
function clientToRunningDaemon(): ControlClient | null {
  if (liveControlPort() == null) return null;
  return new ControlClient(async () => {
    const port = liveControlPort();
    if (port == null) throw new Error("daemon went away");
    return openControl(port);
  });
}

async function cmdStatus(): Promise<number> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) {
    console.log("Pigeon bridge: not running");
    console.log("  Start it by launching any Claude Code session with the pigeon MCP server,");
    console.log("  or run the daemon directly:  npm --prefix server run bridge");
    return 0;
  }
  const client = clientToRunningDaemon();
  if (!client) {
    console.log("Pigeon bridge: recorded but unreachable (stale runtime file?)");
    return 1;
  }
  try {
    const info = (await client.request("info")) as DaemonInfo;
    const stats = (await client.request("stats")) as ErrorStats;
    const sessions = (await client.request("listSessions")) as SessionInfo[];

    console.log(`Pigeon bridge: running  (pid ${info.pid}, v${info.version ?? "?"}, up ${fmtAgo(info.startedAt)})`);
    console.log(
      `  ports     ws:${info.wsPort}  control:${info.controlPort}` +
        (info.dashboardPort ? `  dashboard:http://127.0.0.1:${info.dashboardPort}` : "  dashboard:off"),
    );
    console.log(`  extension ${info.extensionConnections ? `connected (${info.extensionConnections})` : "not connected"}`);
    console.log(`  features  eval ${info.allowEval ? "ON" : "off"} · history ${info.hasStore ? "ON" : "off"}`);
    const levels = Object.entries(stats.byLevel).map(([k, v]) => `${k}:${v}`).join(" ") || "—";
    console.log(`  buffer    ${stats.total} error(s)  [${levels}]`);

    console.log(`  sessions  ${sessions.length}`);
    for (const s of sessions) {
      const scope = s.pageUrlHint ? `→ ${s.pageUrlHint}` : "";
      console.log(
        `    • ${s.projectName ?? "?"}  (pid ${s.pid ?? "—"})  connected ${fmtAgo(s.connectedAt)} ago, ` +
          `idle ${fmtAgo(s.lastActivity)} ${scope}`,
      );
    }
    return 0;
  } catch (e) {
    console.log(`Pigeon bridge: error talking to daemon: ${(e as Error).message}`);
    return 1;
  }
}

async function cmdDoctor(): Promise<number> {
  let worst = 0; // 0 ok, 1 warn, 2 fail
  const line = (state: "PASS" | "WARN" | "FAIL", msg: string, hint?: string) => {
    worst = Math.max(worst, state === "FAIL" ? 2 : state === "WARN" ? 1 : 0);
    console.log(`  [${state}] ${msg}${hint ? `\n         ↳ ${hint}` : ""}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 18 ? "PASS" : "FAIL", `Node.js ${process.versions.node}`, major >= 18 ? undefined : "Pigeon needs Node 18+");

  const bridgeBuilt = existsSync(join(HERE, "bridge.js"));
  line(bridgeBuilt ? "PASS" : "FAIL", `build present (${HERE})`, bridgeBuilt ? undefined : "run: npm run build");

  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) {
    line("WARN", "daemon not running", "starts automatically on first Claude Code session, or: npm --prefix server run bridge");
    console.log(`\nDoctor: ${worst === 0 ? "all good" : worst === 1 ? "warnings" : "problems found"} (runtime dir: ${runtimeDir()})`);
    return worst === 2 ? 1 : 0;
  }
  line("PASS", `daemon running (pid ${rt.pid})`);

  const client = clientToRunningDaemon();
  if (!client) {
    line("FAIL", "daemon recorded but its control port is unreachable", "stale runtime file — try: pigeon stop, then restart");
  } else {
    try {
      const info = (await client.request("info")) as DaemonInfo;
      line(
        info.extensionConnections ? "PASS" : "WARN",
        `browser extension ${info.extensionConnections ? `connected (${info.extensionConnections})` : "not connected"}`,
        info.extensionConnections ? undefined : "load extension/dist in chrome://extensions and open a localhost dev page",
      );
      line("PASS", `ports reachable (ws:${info.wsPort}, control:${info.controlPort})`);
      if (info.dashboardPort) line("PASS", `dashboard at http://127.0.0.1:${info.dashboardPort}`);
      line("PASS", `eval gating ${info.allowEval ? "ON (PIGEON_ALLOW_EVAL=1)" : "off (safe default)"}`);
    } catch (e) {
      line("FAIL", `control channel error: ${(e as Error).message}`);
    }
  }

  console.log(`\nDoctor: ${worst === 0 ? "all good" : worst === 1 ? "warnings" : "problems found"} (runtime dir: ${runtimeDir()})`);
  return worst === 2 ? 1 : 0;
}

async function cmdStop(): Promise<number> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) {
    console.log("Pigeon bridge: not running");
    return 0;
  }
  const client = clientToRunningDaemon();
  if (!client) {
    console.log("Could not reach the daemon. Fallback:  pkill -f dist/bridge.js");
    return 1;
  }
  try {
    await client.request("shutdown", {}, 3000);
  } catch {
    /* the daemon exits ~50ms after replying; a dropped socket is expected */
  }
  console.log(`Pigeon bridge: stop requested (was pid ${rt.pid}).`);
  return 0;
}

function cmdDashboard(): number {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid) || !rt.dashboardPort) {
    console.log("Dashboard not available (daemon not running, or dashboard disabled with PIGEON_DASHBOARD=0).");
    return 1;
  }
  const url = `http://127.0.0.1:${rt.dashboardPort}/`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
    console.log(`Opening ${url}`);
  } catch {
    console.log(`Open the dashboard at: ${url}`);
  }
  return 0;
}

function usage(): void {
  console.log(`pigeon v${VERSION} — control the browser-error bridge

Usage: pigeon <command>

  status      Daemon health, ports, buffer and connected sessions
  doctor      Diagnose setup problems with actionable hints
  stop        Shut the daemon down gracefully
  dashboard   Open the web dashboard in your browser
  help        Show this help`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  let code = 0;
  switch (cmd) {
    case "status": code = await cmdStatus(); break;
    case "doctor": code = await cmdDoctor(); break;
    case "stop": code = await cmdStop(); break;
    case "dashboard": code = cmdDashboard(); break;
    case "help": case "-h": case "--help": usage(); break;
    default:
      console.log(`unknown command: ${cmd}\n`);
      usage();
      code = 1;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("pigeon:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
