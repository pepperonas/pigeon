export type ErrorLevel = "error" | "warn" | "network";

/** An error event as it arrives over the WebSocket from the extension. */
export interface ErrorEvent {
  level: ErrorLevel;
  message: string;
  stack?: string;
  /**
   * Source-mapped version of `stack`, resolved server-side (original file:line:col).
   * Present only when a source map could be loaded.
   */
  resolvedStack?: string;
  /** Source file / request URL the error relates to (if known). */
  source?: string;
  line?: number;
  col?: number;
  /** URL of the page that produced the error. */
  pageUrl?: string;
  /** Tab the error came from (added by the service worker). */
  tabId?: number;
  tabTitle?: string;
  /** HTTP status for network-level events (0 = request failed/aborted). */
  status?: number;
  /** epoch milliseconds */
  timestamp: number;
  /**
   * How the event was captured:
   * console.error | console.warn | onerror | unhandledrejection | fetch | xhr
   */
  origin?: string;
}

/** An error after it has been stored in the ring buffer (with id + dedup counter). */
export interface BufferedError extends ErrorEvent {
  id: number;
  /** How many identical events were collapsed into this entry. */
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ErrorStats {
  total: number;
  byLevel: Record<string, number>;
  newest: number | null;
  oldest: number | null;
}
