import { WebSocketServer } from "ws";
import type { ErrorBuffer } from "./buffer.js";
import type { ErrorEvent } from "./types.js";
import { log } from "./log.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PIGEON_WS_PORT ?? 8765);

const MAX_MESSAGE_LEN = 8000;
const MAX_STACK_LEN = 16000;

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
        if (ev) buffer.add(ev);
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

  return {
    level: r.level === "warn" ? "warn" : "error",
    message: r.message.slice(0, MAX_MESSAGE_LEN),
    stack: typeof r.stack === "string" ? r.stack.slice(0, MAX_STACK_LEN) : undefined,
    source: typeof r.source === "string" ? r.source : undefined,
    line: typeof r.line === "number" && Number.isFinite(r.line) ? r.line : undefined,
    col: typeof r.col === "number" && Number.isFinite(r.col) ? r.col : undefined,
    pageUrl: typeof r.pageUrl === "string" ? r.pageUrl : undefined,
    origin: typeof r.origin === "string" ? r.origin : undefined,
    timestamp:
      typeof r.timestamp === "number" && Number.isFinite(r.timestamp)
        ? r.timestamp
        : Date.now(),
  };
}
