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
const WS_URL = "ws://localhost:8765";
const MAX_QUEUE = 100;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 30000;
const HEARTBEAT_MINUTES = 0.5; // ~30s, matches the idle-eviction window

type PigeonError = Record<string, unknown>;

let socket: WebSocket | null = null;
let connected = false;
let backoff = INITIAL_BACKOFF;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let enabled = true;
let queue: PigeonError[] = [];

// ---------------------------------------------------------------------------
// Persistence (survives service-worker eviction)
// ---------------------------------------------------------------------------

async function loadState(): Promise<void> {
  const local = await chrome.storage.local.get("enabled");
  enabled = local.enabled !== false; // default ON
  const session = await chrome.storage.session.get("queue");
  if (Array.isArray(session.queue)) queue = session.queue as PigeonError[];
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
  const delay = backoff;
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
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
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    connected = true;
    backoff = INITIAL_BACKOFF;
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

async function handleError(payload: PigeonError): Promise<void> {
  if (!enabled) return;
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
    if (sender.tab) {
      if (typeof sender.tab.id === "number") payload.tabId = sender.tab.id;
      if (sender.tab.title) payload.tabTitle = sender.tab.title;
    }
    void handleError(payload);
    return false;
  }
  if (msg.type === "pigeon-status") {
    sendResponse({ connected, queued: queue.length, enabled });
    return true;
  }
  if (msg.type === "pigeon-set-enabled") {
    void setEnabled(!!msg.enabled).then(() =>
      sendResponse({ connected, queued: queue.length, enabled }),
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
