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
(() => {
  const MARK = "__pigeon__";

  type Payload = {
    level: "error" | "warn";
    origin: string;
    message: string;
    stack?: string;
    source?: string;
    line?: number;
    col?: number;
    pageUrl: string;
    timestamp: number;
  };

  function post(payload: Payload): void {
    try {
      window.postMessage({ [MARK]: true, payload }, window.location.origin);
    } catch {
      /* never let reporting break the page */
    }
  }

  function serialize(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (arg === undefined) return "undefined";
    if (arg === null) return "null";
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  function fromConsole(level: "error" | "warn", origin: string, args: unknown[]): Payload {
    const message = args.map(serialize).join(" ");
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
        : `Unhandled promise rejection: ${serialize(reason)}`;
    post({
      level: "error",
      origin: "unhandledrejection",
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    });
  });
})();
