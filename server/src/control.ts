import { WebSocketServer, WebSocket } from "ws";
import type { ErrorBuffer } from "./buffer.js";
import type { CommandBus } from "./commandbus.js";
import type { ErrorStore } from "./store.js";
import { bindWss } from "./runtime.js";
import { log } from "./log.js";

/**
 * Control channel between the standalone bridge daemon and the per-session MCP
 * proxies. The daemon owns the buffer/commandbus/store and serves RPC requests
 * over a localhost WebSocket; each MCP proxy connects and forwards tool calls.
 *
 * Wire shape:
 *   request : { id, method, params? }
 *   response: { id, ok: true, result } | { id, ok: false, error }
 *
 * Each control connection that calls `register` becomes a tracked **session**
 * (project/pid/cwd) so the CLI and dashboard can show who is connected.
 */

const OPEN = 1;

export interface ControlRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Mutable daemon metadata, filled in by the bridge after all servers bind. */
export interface DaemonMeta {
  pid: number;
  version: string;
  startedAt: number;
  wsPort: number;
  controlPort: number;
  dashboardPort?: number;
}

/** Reply to the `info` RPC. allowEval/hasStore are always present; the rest are
 *  reported by daemons new enough to send them (older proxies ignore them). */
export interface DaemonInfo {
  allowEval: boolean;
  hasStore: boolean;
  pid?: number;
  version?: string;
  startedAt?: number;
  wsPort?: number;
  controlPort?: number;
  dashboardPort?: number;
  bufferTotal?: number;
  extensionConnections?: number;
  sessionCount?: number;
}

/** A connected MCP proxy that has identified itself via `register`. */
export interface SessionInfo {
  id: number;
  pid?: number;
  cwd?: string;
  projectName?: string;
  clientStartedAt?: number;
  connectedAt: number;
  lastActivity: number;
  /** Most recent pageUrl filter this session queried with — its inferred scope. */
  pageUrlHint?: string;
}

// --- daemon side ------------------------------------------------------------

export interface ControlServerDeps {
  buffer: ErrorBuffer;
  commandBus: CommandBus;
  store?: ErrorStore;
  allowEval: boolean;
  /** Filled in by the bridge after binding; read lazily when `info` is called. */
  meta: DaemonMeta;
}

export interface ControlServer {
  wss: WebSocketServer;
  port: number;
  /** Snapshot of currently-registered sessions (for CLI/dashboard). */
  listSessions(): SessionInfo[];
}

export async function startControlServer(
  host: string,
  startPort: number,
  deps: ControlServerDeps,
): Promise<ControlServer> {
  const { wss, port } = await bindWss(host, startPort);
  log(`control channel on ws://${host}:${port}`);

  const sessions = new Map<WebSocket, SessionInfo>();
  let seq = 0;
  const listSessions = (): SessionInfo[] =>
    [...sessions.values()].filter((s) => s.pid != null).map((s) => ({ ...s }));

  wss.on("connection", (ws) => {
    const session: SessionInfo = { id: ++seq, connectedAt: Date.now(), lastActivity: Date.now() };
    sessions.set(ws, session);

    ws.on("message", async (data) => {
      let req: ControlRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!req || typeof req.id !== "string") return;
      session.lastActivity = Date.now();
      try {
        const result = await handle(req.method, req.params ?? {}, deps, session, listSessions);
        send(ws, { id: req.id, ok: true, result });
      } catch (e) {
        send(ws, { id: req.id, ok: false, error: (e as Error).message });
      }
    });

    ws.on("close", () => sessions.delete(ws));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  return { wss, port, listSessions };
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function handle(
  method: string,
  params: Record<string, unknown>,
  { buffer, commandBus, store, allowEval, meta }: ControlServerDeps,
  session: SessionInfo,
  listSessions: () => SessionInfo[],
): Promise<unknown> {
  switch (method) {
    case "register":
      session.pid = num(params.pid);
      session.cwd = str(params.cwd);
      session.projectName = str(params.projectName);
      session.clientStartedAt = num(params.clientStartedAt);
      return { id: session.id };
    case "info":
      return {
        allowEval,
        hasStore: !!store,
        pid: meta.pid,
        version: meta.version,
        startedAt: meta.startedAt,
        wsPort: meta.wsPort,
        controlPort: meta.controlPort,
        dashboardPort: meta.dashboardPort,
        bufferTotal: buffer.stats().total,
        extensionConnections: commandBus.count(),
        sessionCount: listSessions().length,
      } satisfies DaemonInfo;
    case "listSessions":
      return listSessions();
    case "getRecent":
      if (typeof params.pageUrl === "string" && params.pageUrl) session.pageUrlHint = params.pageUrl;
      return buffer.getRecent(params);
    case "clear":
      return buffer.clear();
    case "stats":
      return buffer.stats();
    case "history":
      if (!store) throw new Error("history is disabled (PIGEON_DB not set on the bridge)");
      return store.query(params);
    case "getAttachment":
      return buffer.getAttachment(Number(params.id)) ?? null;
    case "waitForNext":
      return buffer.waitForNext(typeof params.timeoutMs === "number" ? params.timeoutMs : 30000);
    case "sendCommand":
      return commandBus.send(
        String(params.name),
        (params.params as Record<string, unknown>) ?? {},
        typeof params.timeoutMs === "number" ? params.timeoutMs : 5000,
      );
    case "shutdown":
      log("shutdown requested via control channel");
      setTimeout(() => process.exit(0), 50);
      return { ok: true };
    default:
      throw new Error(`unknown control method: ${method}`);
  }
}

// --- proxy side -------------------------------------------------------------

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Client used by the MCP proxy (and the CLI). `connector` returns a freshly
 * opened socket to the daemon (spawning it if needed); the client (re)connects
 * lazily and rejects all in-flight requests if the socket drops. `onOpen` runs
 * after every (re)connect — the proxy uses it to (re-)send `register`.
 */
export class ControlClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly connector: () => Promise<WebSocket>,
    private readonly onOpen?: (client: ControlClient) => void,
  ) {}

  private async ensure(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === OPEN) return this.ws;
    if (!this.connecting) {
      this.connecting = this.connector()
        .then((ws) => {
          this.attach(ws);
          this.connecting = null;
          try {
            this.onOpen?.(this);
          } catch {
            /* onOpen is best-effort */
          }
          return ws;
        })
        .catch((e) => {
          this.connecting = null;
          throw e;
        });
    }
    return this.connecting;
  }

  private attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on("message", (data) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg.id) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "control request failed"));
    });
    const drop = () => {
      if (this.ws === ws) this.ws = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("bridge connection lost"));
      }
      this.pending.clear();
    };
    ws.on("close", drop);
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const ws = await this.ensure();
    const id = `c_${++this.seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`control '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Fire-and-forget RPC (used for `register` from onOpen — we don't await it). */
  notify(method: string, params: Record<string, unknown> = {}): void {
    void this.request(method, params).catch(() => {
      /* best-effort */
    });
  }
}
