/**
 * Real-browser smoke test: loads the BUILT extension into system Chrome and
 * verifies the whole capture path end-to-end (inject → console/error/rejection/
 * fetch hooks → content relay → service-worker WebSocket → bridge), plus a
 * reload command round-trip.
 *
 * Uses playwright-core against installed Chrome (no browser download — works
 * behind the outgoing-traffic firewall). Standalone process; console.* is fine.
 *
 *   npm --prefix extension run test:browser
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
// Default to Playwright's bundled Chromium (Chrome for Testing) — branded Chrome
// blocks unpacked-extension loading. Override with PIGEON_CHROME if needed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

// --- mock bridge: WS server that collects errors and can send commands ------
const errors = [];
let swSocket = null;
const commandResults = new Map();
const wss = new WebSocketServer({ port: 8765 }); // all interfaces (v4 + v6)
wss.on("connection", (ws) => {
  console.error("[bridge] service worker connected");
  swSocket = ws;
  ws.on("message", (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.kind === "command-result") {
      commandResults.set(m.id, m);
    } else if (m && typeof m.message === "string") {
      errors.push(m);
    }
  });
});
await new Promise((r) => wss.on("listening", r));

// --- test page that triggers every capture path -----------------------------
const PAGE = `<!doctype html><html><head><title>pigeon-test</title></head><body>
<h1>pigeon test</h1>
<script>
  console.error("CE_MARKER");
  fetch("/missing-404").catch(function(){});
  Promise.reject(new Error("REJECT_MARKER"));
  setTimeout(function(){ throw new Error("THROW_MARKER"); }, 50);
</script>
</body></html>`;
const http = createServer((req, res) => {
  if (req.url === "/missing-404") {
    res.writeHead(404).end("nope");
  } else {
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  }
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const port = http.address().port;
const url = `http://127.0.0.1:${port}/`;

// --- launch real Chrome with the unpacked extension ------------------------
const userDataDir = mkdtempSync(join(tmpdir(), "pigeon-pw-"));
const headlessArgs = process.env.PIGEON_HEADED ? [] : ["--headless=new"];
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(process.env.PIGEON_CHROME ? { executablePath: process.env.PIGEON_CHROME } : {}),
  args: [
    ...headlessArgs,
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let exitCode = 0;
context.on("serviceworker", (w) => console.error("[chrome] serviceworker:", w.url()));
console.error("[chrome] existing serviceworkers:", context.serviceWorkers().map((w) => w.url()));

try {
  const page = await context.newPage();
  page.on("console", (m) => console.error("[page]", m.type(), m.text()));
  page.on("pageerror", (e) => console.error("[page] pageerror:", e.message));
  await page.goto(url, { waitUntil: "load" });
  await sleep(500);
  console.error("[chrome] serviceworkers after load:", context.serviceWorkers().map((w) => w.url()));

  // Wait until all four markers have arrived at the mock bridge.
  const deadline = Date.now() + 20000;
  const seen = () => ({
    ce: errors.some((e) => e.message.includes("CE_MARKER")),
    thrown: errors.some((e) => e.message.includes("THROW_MARKER") && e.origin === "onerror"),
    reject: errors.some((e) => e.message.includes("REJECT_MARKER") && e.origin === "unhandledrejection"),
    net: errors.some((e) => e.level === "network" && e.message.includes("missing-404")),
  });
  let s = seen();
  while (Date.now() < deadline && !(s.ce && s.thrown && s.reject && s.net)) {
    await sleep(250);
    s = seen();
  }
  console.error("captured:", JSON.stringify(s), `(${errors.length} events)`);
  console.error("events:", JSON.stringify(errors.map((e) => ({ origin: e.origin, level: e.level, message: e.message.slice(0, 50) })), null, 1));
  assert(s.ce, "console.error captured (CE_MARKER)");
  assert(s.thrown, "uncaught exception captured (THROW_MARKER, origin onerror)");
  assert(s.reject, "unhandled rejection captured (REJECT_MARKER)");
  assert(s.net, "failed fetch captured as network level (missing-404)");

  // tab context should be attached by the service worker
  assert(
    errors.some((e) => typeof e.tabId === "number" && typeof e.pageUrl === "string"),
    "events carry tabId + pageUrl",
  );

  // reload command round-trip (no allowControl needed)
  assert(swSocket, "service worker connected to the bridge");
  swSocket.send(JSON.stringify({ kind: "command", id: "reload-1", name: "reload" }));
  const rd = Date.now() + 8000;
  while (Date.now() < rd && !commandResults.has("reload-1")) await sleep(200);
  const rr = commandResults.get("reload-1");
  assert(rr && rr.ok, "reload command acknowledged by the extension");
  console.error("reload command OK:", JSON.stringify(rr.result));

  console.error("\nBROWSER SMOKE PASSED");
} catch (e) {
  console.error("\nBROWSER SMOKE FAILED:", e.message);
  exitCode = 1;
} finally {
  await context.close();
  wss.close();
  http.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
