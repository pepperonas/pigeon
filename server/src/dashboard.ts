import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { ErrorBuffer } from "./buffer.js";
import type { CommandBus } from "./commandbus.js";
import type { ErrorStore } from "./store.js";
import type { DaemonMeta, SessionInfo } from "./control.js";
import { PORT_SCAN_RANGE } from "./runtime.js";
import { dashboardHtml } from "./dashboard-html.js";
import { log } from "./log.js";

/**
 * Local web dashboard served by the daemon: overview of buffer, connected
 * sessions, and daemon health, plus clear/shutdown. 127.0.0.1 only.
 *
 * Security: the buffer can hold sensitive page data, and a localhost HTTP
 * listener is reachable by any local page (incl. via DNS-rebinding), so:
 *  - bind 127.0.0.1 only;
 *  - validate the Host header against a localhost allowlist (anti-rebinding);
 *  - gate every /api/* call on a per-daemon token (in the 600-mode runtime
 *    file + embedded in the served HTML). A remote page can't read either, so
 *    it can't forge calls. Mutations additionally require a same-origin Origin.
 *  - eval gating is shown read-only — never toggled here.
 */

export interface DashboardDeps {
  buffer: ErrorBuffer;
  commandBus: CommandBus;
  store?: ErrorStore;
  allowEval: boolean;
  meta: DaemonMeta;
  token: string;
  listSessions: () => SessionInfo[];
}

export interface DashboardServer {
  port: number;
  close(): void;
}

function bindHttp(
  host: string,
  startPort: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryOne = () => {
      const server = createServer(handler);
      server.once("listening", () => resolve({ port, close: () => server.close() }));
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < startPort + PORT_SCAN_RANGE) {
          try {
            server.close();
          } catch {
            /* failed bind holds nothing */
          }
          port += 1;
          tryOne();
        } else {
          reject(e);
        }
      });
      server.listen(port, host);
    };
    tryOne();
  });
}

export async function startDashboard(
  host: string,
  startPort: number,
  deps: DashboardDeps,
): Promise<DashboardServer> {
  const { buffer, commandBus, store, allowEval, meta, token, listSessions } = deps;

  const hostAllowed = (req: IncomingMessage): boolean => {
    const h = req.headers.host ?? "";
    return h === `127.0.0.1:${meta.dashboardPort}` || h === `localhost:${meta.dashboardPort}`;
  };
  const tokenOk = (req: IncomingMessage, url: URL): boolean => {
    const t = req.headers["x-pigeon-token"] ?? url.searchParams.get("token") ?? "";
    return t === token;
  };
  const sameOrigin = (req: IncomingMessage): boolean => {
    const o = req.headers.origin;
    if (!o) return true; // non-browser / same-origin fetch without Origin
    return o === `http://127.0.0.1:${meta.dashboardPort}` || o === `http://localhost:${meta.dashboardPort}`;
  };
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (!hostAllowed(req)) {
      res.writeHead(403).end("forbidden host");
      return;
    }

    // The page itself: no token (it's how you bootstrap it), Host-checked above.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml(token));
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404).end("not found");
      return;
    }
    if (!tokenOk(req, url)) {
      res.writeHead(403).end("bad token");
      return;
    }

    // --- read endpoints ---
    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, {
        info: {
          allowEval,
          hasStore: !!store,
          pid: meta.pid,
          version: meta.version,
          startedAt: meta.startedAt,
          wsPort: meta.wsPort,
          controlPort: meta.controlPort,
          dashboardPort: meta.dashboardPort,
          extensionConnections: commandBus.count(),
        },
        stats: buffer.stats(),
        sessions: listSessions(),
        errors: buffer.getRecent({ limit: 50 }),
      });
      return;
    }

    const att = /^\/api\/errors\/(\d+)\/(screenshot|dom)$/.exec(url.pathname);
    if (req.method === "GET" && att) {
      const a = buffer.getAttachment(Number(att[1]));
      if (att[2] === "screenshot" && a?.screenshot) {
        const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(a.screenshot);
        if (m) {
          res.writeHead(200, { "content-type": m[1] });
          res.end(Buffer.from(m[2], "base64"));
          return;
        }
      }
      if (att[2] === "dom" && a?.dom) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(a.dom);
        return;
      }
      res.writeHead(404).end("no attachment");
      return;
    }

    // --- mutations: token + same-origin ---
    if (req.method === "POST" && !sameOrigin(req)) {
      res.writeHead(403).end("cross-origin");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/clear") {
      json(res, 200, { cleared: buffer.clear() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      json(res, 200, { ok: true });
      log("shutdown requested via dashboard");
      setTimeout(() => process.exit(0), 50);
      return;
    }

    res.writeHead(404).end("not found");
  };

  const server = await bindHttp(host, startPort, handler);
  meta.dashboardPort = server.port;
  log(`dashboard on http://${host}:${server.port}`);
  return server;
}
