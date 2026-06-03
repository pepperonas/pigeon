import { EventEmitter } from "node:events";
import type { BufferedError, ErrorEvent, ErrorStats } from "./types.js";

const MAX_ENTRIES = 200;
const DEDUP_WINDOW_MS = 2000;
/** How many recent entries to scan when looking for a dedup match. */
const DEDUP_SCAN = 50;

export interface GetRecentOptions {
  limit?: number;
  level?: string;
  /** epoch ms; only entries last seen at/after this time */
  since?: number;
  /** case-insensitive substring match against pageUrl */
  pageUrl?: string;
}

/**
 * Fixed-size ring buffer of browser errors with light deduplication.
 *
 * Emits an "add" event whenever an error is stored or an existing one is
 * deduplicated — `waitForNext` resolves on that signal.
 */
export class ErrorBuffer extends EventEmitter {
  private items: BufferedError[] = [];
  private nextId = 1;

  add(ev: ErrorEvent): BufferedError {
    const now = Number.isFinite(ev.timestamp) ? ev.timestamp : Date.now();

    // Dedup: identical message+stack seen within the window → bump counter.
    const scanFrom = Math.max(0, this.items.length - DEDUP_SCAN);
    for (let i = this.items.length - 1; i >= scanFrom; i--) {
      const it = this.items[i];
      if (now - it.lastSeen > DEDUP_WINDOW_MS) continue;
      if (it.message === ev.message && (it.stack ?? "") === (ev.stack ?? "")) {
        it.count += 1;
        it.lastSeen = now;
        this.emit("add", it);
        return it;
      }
    }

    const entry: BufferedError = {
      ...ev,
      timestamp: now,
      id: this.nextId++,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };
    this.items.push(entry);
    if (this.items.length > MAX_ENTRIES) this.items.shift();
    this.emit("add", entry);
    return entry;
  }

  /** Newest first, optionally filtered. */
  getRecent(opts: GetRecentOptions = {}): BufferedError[] {
    let out = this.items.slice();
    if (opts.level) out = out.filter((e) => e.level === opts.level);
    if (typeof opts.since === "number") out = out.filter((e) => e.lastSeen >= opts.since!);
    if (opts.pageUrl) {
      const needle = opts.pageUrl.toLowerCase();
      out = out.filter((e) => (e.pageUrl ?? "").toLowerCase().includes(needle));
    }
    out.reverse();
    if (typeof opts.limit === "number" && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out;
  }

  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  stats(): ErrorStats {
    const byLevel: Record<string, number> = {};
    let newest: number | null = null;
    let oldest: number | null = null;
    for (const e of this.items) {
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      if (newest === null || e.lastSeen > newest) newest = e.lastSeen;
      if (oldest === null || e.firstSeen < oldest) oldest = e.firstSeen;
    }
    return { total: this.items.length, byLevel, newest, oldest };
  }

  /** Resolve with the next stored/deduped error, or null on timeout. */
  waitForNext(timeoutMs = 30000): Promise<BufferedError | null> {
    return new Promise((resolve) => {
      const onAdd = (e: BufferedError) => {
        cleanup();
        resolve(e);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        this.off("add", onAdd);
        clearTimeout(timer);
      };
      this.once("add", onAdd);
    });
  }
}
