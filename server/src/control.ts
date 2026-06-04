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
 */

const OPEN = 1;

export interface ControlRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface DaemonInfo {
  allowEval: boolean;
  hasStore: boolean;
}

// --- daemon side ------------------------------------------------------------

export interface ControlServerDeps {
  buffer: ErrorBuffer;
  commandBus: CommandBus;
  store?: ErrorStore;
  allowEval: boolean;
}

export async function startControlServer(
  host: string,
  startPort: number,
  deps: ControlServerDeps,
): Promise<{ wss: WebSocketServer; port: number }> {
  const { wss, port } = await bindWss(host, startPort);
  log(`control channel on ws://${host}:${port}`);
  wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
      let req: ControlRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!req || typeof req.id !== "string") return;
      try {
        const result = await handle(req.method, req.params ?? {}, deps);
        send(ws, { id: req.id, ok: true, result });
      } catch (e) {
        send(ws, { id: req.id, ok: false, error: (e as Error).message });
      }
    });
  });

  return { wss, port };
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

async function handle(
  method: string,
  params: Record<string, unknown>,
  { buffer, commandBus, store, allowEval }: ControlServerDeps,
): Promise<unknown> {
  switch (method) {
    case "info":
      return { allowEval, hasStore: !!store } satisfies DaemonInfo;
    case "getRecent":
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
 * Client used by the MCP proxy. `connector` returns a freshly opened socket to
 * the daemon (spawning it if needed); the client (re)connects lazily and
 * rejects all in-flight requests if the socket drops.
 */
export class ControlClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly connector: () => Promise<WebSocket>) {}

  private async ensure(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === OPEN) return this.ws;
    if (!this.connecting) {
      this.connecting = this.connector()
        .then((ws) => {
          this.attach(ws);
          this.connecting = null;
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
}
