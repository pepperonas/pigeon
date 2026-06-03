/**
 * Content script (isolated world, runs at document_start).
 *
 * 1. Injects injected.js into the page world as early as possible.
 * 2. Relays the page's postMessage error events to the service worker.
 */
const MARK = "__pigeon__";

(function injectPageScript() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.async = false; // preserve execution order — run before page scripts
    const parent = document.head || document.documentElement;
    parent.appendChild(script);
    script.onload = () => script.remove();
  } catch {
    /* injection best-effort */
  }
})();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data[MARK] !== true || !data.payload) return;
  try {
    chrome.runtime.sendMessage({ type: "pigeon-error", payload: data.payload }, () => {
      // Swallow "receiving end does not exist" while the SW is waking up.
      void chrome.runtime.lastError;
    });
  } catch {
    /* extension context may be invalidated on reload */
  }
});
