/**
 * Content script (isolated world, runs at document_start).
 *
 * injected.ts is loaded separately as a MAIN-world content script (also at
 * document_start, declared in the manifest), so it wraps the console and
 * installs error hooks before any page script runs. This isolated script just
 * relays the page's postMessage error events to the service worker.
 */
const MARK = "__pigeon__";
const MAX_ATTEMPTS = 10;

/**
 * Deliver an error to the service worker, retrying with backoff. Early errors
 * can fire before the lazy MV3 service worker is listening; without a retry the
 * very first events would be dropped ("receiving end does not exist").
 */
function send(payload: unknown, attempt = 0): void {
  try {
    chrome.runtime.sendMessage({ type: "pigeon-error", payload }, () => {
      if (chrome.runtime.lastError && attempt < MAX_ATTEMPTS) {
        setTimeout(() => send(payload, attempt + 1), 50 * (attempt + 1));
      }
    });
  } catch {
    // Extension context invalidated (e.g. reloaded) — retry a few times.
    if (attempt < MAX_ATTEMPTS) setTimeout(() => send(payload, attempt + 1), 50 * (attempt + 1));
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data[MARK] !== true || !data.payload) return;
  send(data.payload);
});
