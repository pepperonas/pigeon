/**
 * Service worker: the bridge between the page and the local Pigeon server.
 *
 * MV3 service workers are evicted after ~30s idle and restart fresh (all module
 * globals reset). We handle that by:
 *   - reconnecting lazily whenever an error arrives or the popup asks,
 *   - persisting the pending queue + enabled flag in chrome.storage.session/local
 *     so a restart doesn't lose buffered errors or the on/off setting,
 *   - a chrome.alarms heartbeat that keeps the socket warm / reconnects on wake.
 */
// The daemon binds the first free port from WS_BASE; it can't tell us which one
// (a content script can't read files), so we scan this range. Keep in sync with
// PORT_SCAN_RANGE in server/src/runtime.ts.
const WS_BASE = 8765;
const WS_PORT_SCAN = 16;
const MAX_QUEUE = 100;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 30000;
const HEARTBEAT_MINUTES = 0.5; // ~30s, matches the idle-eviction window

type PigeonError = Record<string, unknown>;

let socket: WebSocket | null = null;
let connected = false;
let backoff = INITIAL_BACKOFF;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let portIdx = 0; // which candidate port we're trying
let failedAttempts = 0; // consecutive failures since the last successful connect

function currentWsUrl(): string {
  return `ws://localhost:${WS_BASE + (portIdx % WS_PORT_SCAN)}`;
}
let enabled = true;
let snapshots = true; // capture screenshot + DOM on uncaught errors
let allowControl = false; // allow remote eval_in_page (off by default)
let lastCaptureAt = 0;
let queue: PigeonError[] = [];

// ---------------------------------------------------------------------------
// Persistence (survives service-worker eviction)
// ---------------------------------------------------------------------------

async function loadState(): Promise<void> {
  const local = await chrome.storage.local.get(["enabled", "snapshots", "allowControl"]);
  enabled = local.enabled !== false; // default ON
  snapshots = local.snapshots !== false; // default ON
  allowControl = local.allowControl === true; // default OFF
  const session = await chrome.storage.session.get(["queue", "wsPort"]);
  if (Array.isArray(session.queue)) queue = session.queue as PigeonError[];
  if (typeof session.wsPort === "number") {
    const offset = session.wsPort - WS_BASE;
    if (offset >= 0 && offset < WS_PORT_SCAN) portIdx = offset; // resume on the last-working port
  }
}

async function persistQueue(): Promise<void> {
  try {
    await chrome.storage.session.set({ queue });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!enabled || reconnectTimer !== null) return;
  portIdx += 1; // try the next candidate port on the next attempt
  failedAttempts += 1;
  // Sweep the whole port range quickly first; only back off once a full sweep
  // turned up no daemon (it's probably not running).
  const fastScan = failedAttempts <= WS_PORT_SCAN;
  const delay = fastScan ? 250 : backoff;
  if (!fastScan) backoff = Math.min(backoff * 2, MAX_BACKOFF);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (!enabled) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearReconnectTimer();

  let ws: WebSocket;
  try {
    ws = new WebSocket(currentWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    connected = true;
    backoff = INITIAL_BACKOFF;
    failedAttempts = 0;
    // Remember the working port so we try it first next time.
    void chrome.storage.session.set({ wsPort: WS_BASE + (portIdx % WS_PORT_SCAN) });
    void flush();
    void updateBadge();
  };
  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      connected = false;
    }
    void updateBadge();
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows; reconnect is handled there.
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  ws.onmessage = (ev) => {
    void handleCommand(ev.data);
  };
}

// ---------------------------------------------------------------------------
// Remote control (Claude → page): eval_in_page / reload_tab
// ---------------------------------------------------------------------------

function sendRaw(obj: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

async function activeLocalhostTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? undefined;
  } catch {
    return undefined;
  }
}

async function evalInTab(
  tabId: number,
  expression: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [expression],
      func: (expr: string) => {
        try {
          // eslint-disable-next-line no-eval
          const value = (0, eval)(expr);
          let repr: string;
          try {
            repr = JSON.stringify(value);
          } catch {
            repr = String(value);
          }
          if (repr === undefined) repr = String(value);
          return { ok: true, type: typeof value, repr };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    });
    const r = injection?.result as
      | { ok: boolean; type?: string; repr?: string; error?: string }
      | undefined;
    if (!r) return { ok: false, error: "no result from page" };
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, result: { type: r.type, repr: r.repr } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleCommand(data: unknown): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    return;
  }
  if (!msg || msg.kind !== "command" || typeof msg.id !== "string") return;

  const respond = (ok: boolean, result?: unknown, error?: string) =>
    sendRaw({ kind: "command-result", id: msg.id, ok, result, error });

  try {
    const tabId =
      typeof msg.tabId === "number" ? msg.tabId : await activeLocalhostTabId();
    if (tabId == null) return respond(false, undefined, "no target tab available");

    if (msg.name === "reload") {
      await chrome.tabs.reload(tabId);
      return respond(true, { reloaded: tabId });
    }
    if (msg.name === "eval") {
      if (!allowControl) {
        return respond(
          false,
          undefined,
          "remote eval is disabled in the Pigeon extension — enable 'Allow remote eval' in the popup",
        );
      }
      const out = await evalInTab(tabId, String(msg.expression ?? ""));
      return respond(out.ok, out.result, out.error);
    }
    respond(false, undefined, `unknown command: ${String(msg.name)}`);
  } catch (e) {
    respond(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

async function flush(): Promise<void> {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return;
  const pending = queue;
  queue = [];
  const failed: PigeonError[] = [];
  for (const ev of pending) {
    try {
      socket.send(JSON.stringify(ev));
    } catch {
      failed.push(ev);
    }
  }
  if (failed.length) queue = failed.concat(queue);
  await persistQueue();
}

function enqueue(ev: PigeonError): void {
  queue.push(ev);
  if (queue.length > MAX_QUEUE) queue.shift();
}

/** Best-effort visible-tab screenshot, rate-limited to respect Chrome's quota. */
async function captureScreenshot(windowId: number): Promise<string | undefined> {
  const now = Date.now();
  if (now - lastCaptureAt < 1100) return undefined;
  lastCaptureAt = now;
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 50 });
  } catch {
    return undefined; // active tab may not be a permitted origin
  }
}

async function handleError(payload: PigeonError, windowId?: number): Promise<void> {
  if (!enabled) return;

  const origin = typeof payload.origin === "string" ? payload.origin : "";
  const isUncaught = origin === "onerror" || origin === "unhandledrejection";
  if (!snapshots) {
    delete payload.dom; // honour the toggle even though injected.ts always attaches it
  } else if (isUncaught && typeof windowId === "number") {
    const shot = await captureScreenshot(windowId);
    if (shot) payload.screenshot = shot;
  }

  if (connected && socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
      return;
    } catch {
      /* fall through to queue */
    }
  }
  enqueue(payload);
  await persistQueue();
  await updateBadge();
  connect();
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

async function setEnabled(value: boolean): Promise<void> {
  enabled = value;
  await chrome.storage.local.set({ enabled });
  if (enabled) {
    connect();
  } else {
    clearReconnectTimer();
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    socket = null;
    connected = false;
  }
  await updateBadge();
}

async function setSnapshots(value: boolean): Promise<void> {
  snapshots = value;
  await chrome.storage.local.set({ snapshots });
}

async function setAllowControl(value: boolean): Promise<void> {
  allowControl = value;
  await chrome.storage.local.set({ allowControl });
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function updateBadge(): Promise<void> {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ text: "off" });
      await chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
      return;
    }
    if (queue.length > 0) {
      await chrome.action.setBadgeText({ text: String(queue.length) });
      await chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
    } else {
      await chrome.action.setBadgeText({ text: connected ? "" : "·" });
      await chrome.action.setBadgeBackgroundColor({ color: "#fb8c00" });
    }
  } catch {
    /* ignore badge failures */
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "pigeon-error") {
    const payload = msg.payload as PigeonError;
    // Enrich with tab context (only the SW can see sender.tab).
    let windowId: number | undefined;
    if (sender.tab) {
      if (typeof sender.tab.id === "number") payload.tabId = sender.tab.id;
      if (sender.tab.title) payload.tabTitle = sender.tab.title;
      windowId = sender.tab.windowId;
    }
    void handleError(payload, windowId);
    return false;
  }
  if (msg.type === "pigeon-status") {
    sendResponse({ connected, queued: queue.length, enabled, snapshots, allowControl });
    return true;
  }
  if (msg.type === "pigeon-set-enabled") {
    void setEnabled(!!msg.enabled).then(() =>
      sendResponse({ connected, queued: queue.length, enabled, snapshots, allowControl }),
    );
    return true; // async response
  }
  if (msg.type === "pigeon-set-snapshots") {
    void setSnapshots(!!msg.enabled).then(() =>
      sendResponse({ connected, queued: queue.length, enabled, snapshots, allowControl }),
    );
    return true; // async response
  }
  if (msg.type === "pigeon-set-control") {
    void setAllowControl(!!msg.enabled).then(() =>
      sendResponse({ connected, queued: queue.length, enabled, snapshots, allowControl }),
    );
    return true; // async response
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "pigeon-heartbeat") return;
  if (enabled && !connected) connect();
});

async function init(): Promise<void> {
  await loadState();
  chrome.alarms.create("pigeon-heartbeat", { periodInMinutes: HEARTBEAT_MINUTES });
  if (enabled) connect();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());

// Also run on cold start (SW spun up by an incoming message/alarm).
void init();
