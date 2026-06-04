/**
 * Dummy WebSocket client: pushes a few fake errors at the running bridge so you
 * can exercise the buffer without the Chrome extension.
 *
 *   npm run build && npm start          # in one terminal (note: MCP waits on stdio)
 *   npm run test:client                 # in another
 *
 * This is a standalone process, so console.* here is fine.
 */
import WebSocket from "ws";
import { readRuntime } from "./runtime.js";

// Discover the daemon's actual WS port (it may have shifted from the base).
const wsPort = readRuntime()?.wsPort ?? 8765;
const URL = process.env.PIGEON_WS_URL ?? `ws://127.0.0.1:${wsPort}`;
const ws = new WebSocket(URL);

ws.on("open", () => {
  const now = Date.now();
  const samples = [
    {
      level: "error",
      origin: "console.error",
      message: "Cannot read properties of undefined (reading 'id')",
      stack: "TypeError: Cannot read properties of undefined\n    at App (app.js:42:13)",
      source: "http://localhost:3000/app.js",
      line: 42,
      col: 13,
      pageUrl: "http://localhost:3000/",
      timestamp: now,
    },
    {
      level: "warn",
      origin: "console.warn",
      message: "Deprecated API used",
      pageUrl: "http://localhost:3000/",
      timestamp: now,
    },
  ];
  for (const s of samples) ws.send(JSON.stringify(s));
  console.error(`sent ${samples.length} sample errors to ${URL}`);
  setTimeout(() => ws.close(), 200);
});

ws.on("error", (e) => {
  console.error("failed to connect:", (e as Error).message);
  process.exit(1);
});
ws.on("close", () => process.exit(0));
