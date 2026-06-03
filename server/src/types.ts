export type ErrorLevel = "error" | "warn";

/** An error event as it arrives over the WebSocket from the extension. */
export interface ErrorEvent {
  level: ErrorLevel;
  message: string;
  stack?: string;
  /** Source file URL where the error originated (if known). */
  source?: string;
  line?: number;
  col?: number;
  /** URL of the page that produced the error. */
  pageUrl?: string;
  /** epoch milliseconds */
  timestamp: number;
  /** How the event was captured: console.error | console.warn | onerror | unhandledrejection */
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
