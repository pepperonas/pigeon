import { WebSocketServer } from "ws";
import type { ErrorBuffer } from "./buffer.js";
import type { ErrorEvent } from "./types.js";
import { resolveStack } from "./sourcemap.js";
import { log } from "./log.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PIGEON_WS_PORT ?? 8765);

const MAX_MESSAGE_LEN = 8000;
const MAX_STACK_LEN = 16000;
const MAX_DOM_LEN = 1_000_000;
const MAX_SCREENSHOT_LEN = 6_000_000; // base64 data URL upper bound

export function startWebSocketServer(buffer: ErrorBuffer): WebSocketServer {
  const wss = new WebSocketServer({ host: HOST, port: PORT });

  wss.on("listening", () => log(`WebSocket listening on ws://${HOST}:${PORT}`));

  wss.on("connection", (ws, req) => {
    log("extension connected from", req.socket.remoteAddress ?? "?");
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        log("dropped non-JSON message");
        return;
      }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of batch) {
        const ev = normalize(raw);
        if (!ev) continue;
        const entry = buffer.add(ev);
        // Resolve the minified stack in the background; mutate the stored entry.
        if (entry.stack && !entry.resolvedStack) {
          resolveStack(entry.stack, entry.pageUrl)
            .then((r) => {
              if (r) entry.resolvedStack = r;
            })
            .catch(() => {
              /* best-effort */
            });
        }
      }
    });
    ws.on("close", () => log("extension disconnected"));
    ws.on("error", (e) => log("connection error", e.message));
  });

  wss.on("error", (e) => log("WebSocket server error", (e as Error).message));

  return wss;
}

function normalize(raw: unknown): ErrorEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.message !== "string") return null;

  const level: "error" | "warn" | "network" =
    r.level === "warn" ? "warn" : r.level === "network" ? "network" : "error";

  return {
    level,
    message: r.message.slice(0, MAX_MESSAGE_LEN),
    stack: typeof r.stack === "string" ? r.stack.slice(0, MAX_STACK_LEN) : undefined,
    source: typeof r.source === "string" ? r.source : undefined,
    line: typeof r.line === "number" && Number.isFinite(r.line) ? r.line : undefined,
    col: typeof r.col === "number" && Number.isFinite(r.col) ? r.col : undefined,
    pageUrl: typeof r.pageUrl === "string" ? r.pageUrl : undefined,
    tabId: typeof r.tabId === "number" && Number.isFinite(r.tabId) ? r.tabId : undefined,
    tabTitle: typeof r.tabTitle === "string" ? r.tabTitle : undefined,
    status: typeof r.status === "number" && Number.isFinite(r.status) ? r.status : undefined,
    dom: typeof r.dom === "string" ? r.dom.slice(0, MAX_DOM_LEN) : undefined,
    screenshot:
      typeof r.screenshot === "string" && r.screenshot.startsWith("data:image/")
        ? r.screenshot.slice(0, MAX_SCREENSHOT_LEN)
        : undefined,
    origin: typeof r.origin === "string" ? r.origin : undefined,
    timestamp:
      typeof r.timestamp === "number" && Number.isFinite(r.timestamp)
        ? r.timestamp
        : Date.now(),
  };
}
