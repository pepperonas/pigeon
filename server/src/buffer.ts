import { EventEmitter } from "node:events";
import type { Attachment, BufferedError, ErrorEvent, ErrorStats } from "./types.js";

const MAX_ENTRIES = 200;
const DEDUP_WINDOW_MS = 2000;
/** How many recent entries to scan when looking for a dedup match. */
const DEDUP_SCAN = 50;
/** Cap on stored DOM snapshots (server-side safety net). */
const MAX_DOM = 1_000_000;
/** Keep at most this many error attachments (screenshots/DOM) to bound memory. */
const MAX_ATTACHMENTS = 20;

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
  private attachments = new Map<number, Attachment>();
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

    // Keep large blobs out of the ring buffer; reference them by id.
    const { dom, screenshot, ...rest } = ev;
    const entry: BufferedError = {
      ...rest,
      timestamp: now,
      id: this.nextId++,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };
    if (dom || screenshot) {
      this.attachments.set(entry.id, {
        dom: dom ? dom.slice(0, MAX_DOM) : undefined,
        screenshot,
      });
      entry.hasDom = !!dom;
      entry.hasScreenshot = !!screenshot;
      this.trimAttachments();
    }

    this.items.push(entry);
    if (this.items.length > MAX_ENTRIES) {
      const removed = this.items.shift();
      if (removed) this.attachments.delete(removed.id);
    }
    this.emit("add", entry); // any add/bump — wakes wait_for_next_error
    this.emit("new", entry); // brand-new entry only — used for persistence
    return entry;
  }

  /**
   * Seed the buffer from persisted history on startup. Attachments aren't
   * persisted, so the dangling has* flags are dropped. Does not emit events,
   * so re-loaded entries aren't re-persisted.
   */
  hydrate(entries: BufferedError[]): void {
    this.items = entries
      .slice(-MAX_ENTRIES)
      .map(({ hasDom, hasScreenshot, ...rest }) => rest);
    let maxId = 0;
    for (const e of this.items) if (e.id > maxId) maxId = e.id;
    this.nextId = maxId + 1;
  }

  getAttachment(id: number): Attachment | undefined {
    return this.attachments.get(id);
  }

  /** Ids that currently have an attachment of the given kind (oldest first). */
  attachmentIds(kind: "dom" | "screenshot"): number[] {
    const out: number[] = [];
    for (const [id, a] of this.attachments) {
      if (kind === "dom" && a.dom) out.push(id);
      if (kind === "screenshot" && a.screenshot) out.push(id);
    }
    return out;
  }

  private trimAttachments(): void {
    while (this.attachments.size > MAX_ATTACHMENTS) {
      const oldest = this.attachments.keys().next().value;
      if (oldest === undefined) break;
      this.attachments.delete(oldest);
      // Keep the entry truthful so it stops advertising a now-evicted blob.
      const entry = this.items.find((e) => e.id === oldest);
      if (entry) {
        entry.hasDom = undefined;
        entry.hasScreenshot = undefined;
      }
    }
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
    this.attachments.clear();
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
