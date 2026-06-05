/**
 * Page-context script. Injected by the content script as an early <script> tag
 * so it runs BEFORE the app code and can wrap the console.
 *
 * Captures:
 *   - console.error / console.warn (wrapped, then passed through unchanged)
 *   - window 'error'  (uncaught exceptions)
 *   - window 'unhandledrejection' (rejected promises)
 *
 * Sends each event to the content script via window.postMessage. Runs in the
 * page's world — no access to `chrome.*` here.
 */
import { buildMessage, serializeArg } from "./serialize.js";

(() => {
  const MARK = "__pigeon__";

  type Payload = {
    level: "error" | "warn" | "network";
    origin: string;
    message: string;
    stack?: string;
    source?: string;
    line?: number;
    col?: number;
    status?: number;
    dom?: string;
    pageUrl: string;
    timestamp: number;
  };

  const DOM_CAP = 200_000;
  function captureDom(): string | undefined {
    try {
      const html = document.documentElement.outerHTML;
      return html.length > DOM_CAP ? html.slice(0, DOM_CAP) + "\n<!-- pigeon: truncated -->" : html;
    } catch {
      return undefined;
    }
  }

  function post(payload: Payload): void {
    // Never capture Pigeon's own dashboard: it runs on localhost too, so without
    // this guard the extension would log the dashboard's API traffic into the
    // very buffer/history it displays (a feedback loop — e.g. 403s after a token
    // rotation). The page sets this flag in an early inline script.
    if ((window as unknown as { __PIGEON_DASHBOARD__?: boolean }).__PIGEON_DASHBOARD__) return;
    try {
      window.postMessage({ [MARK]: true, payload }, window.location.origin);
    } catch {
      /* never let reporting break the page */
    }
  }

  function fromConsole(level: "error" | "warn", origin: string, args: unknown[]): Payload {
    const message = buildMessage(args);
    const errArg = args.find((a) => a instanceof Error) as Error | undefined;
    let stack = errArg?.stack;
    if (!stack) {
      // Synthesize a call site so console.error/warn entries are locatable.
      const synth = new Error().stack;
      stack = synth ? synth.split("\n").slice(3).join("\n") : undefined;
    }
    return {
      level,
      origin,
      message,
      stack,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    };
  }

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    post(fromConsole("error", "console.error", args));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    post(fromConsole("warn", "console.warn", args));
    origWarn(...args);
  };

  window.addEventListener(
    "error",
    (e: ErrorEvent) => {
      post({
        level: "error",
        origin: "onerror",
        message: e.message || (e.error ? String(e.error) : "Uncaught error"),
        stack: e.error?.stack,
        source: e.filename || undefined,
        line: typeof e.lineno === "number" ? e.lineno : undefined,
        col: typeof e.colno === "number" ? e.colno : undefined,
        dom: captureDom(),
        pageUrl: window.location.href,
        timestamp: Date.now(),
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : `Unhandled promise rejection: ${serializeArg(reason)}`;
    post({
      level: "error",
      origin: "unhandledrejection",
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
      dom: captureDom(),
      pageUrl: window.location.href,
      timestamp: Date.now(),
    });
  });

  // --- Network failures: fetch ---------------------------------------------
  function reportNetwork(origin: string, method: string, url: string, status: number, detail: string): void {
    post({
      level: "network",
      origin,
      message: `${method} ${url} → ${detail}`,
      source: url,
      status,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    });
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const url = input instanceof Request ? input.url : String(input);
      const method = (
        init?.method || (input instanceof Request ? input.method : "GET") || "GET"
      ).toUpperCase();
      return origFetch.apply(this, args).then(
        (res) => {
          if (!res.ok) reportNetwork("fetch", method, url, res.status, `${res.status} ${res.statusText}`.trim());
          return res;
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          reportNetwork("fetch", method, url, 0, `request failed: ${msg}`);
          throw err; // never swallow the rejection
        },
      );
    } as typeof fetch;
  }

  // --- Network failures: XMLHttpRequest ------------------------------------
  type XhrMeta = { method: string; url: string; aborted?: boolean };
  const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    xhrMeta.set(this, { method: String(method).toUpperCase(), url: String(url) });
    // Pass every original argument through (async, user, password) untouched.
    return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest) {
    this.addEventListener("abort", () => {
      const m = xhrMeta.get(this);
      if (m) m.aborted = true;
    });
    this.addEventListener("loadend", () => {
      const meta = xhrMeta.get(this);
      if (meta?.aborted) return; // intentional aborts aren't failures
      const status = this.status;
      if (status === 0 || status >= 400) {
        reportNetwork(
          "xhr",
          meta?.method ?? "GET",
          meta?.url ?? "?",
          status,
          status === 0 ? "request failed" : `${status} ${this.statusText}`.trim(),
        );
      }
    });
    return (origSend as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
  };
})();
