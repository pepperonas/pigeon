import { appendFile, readFile } from "node:fs/promises";
import type { BufferedError } from "./types.js";
import { log } from "./log.js";

/**
 * Append-only JSONL history of errors, enabled via PIGEON_DB.
 *
 * Survives server restarts and holds more than the in-memory ring buffer, so
 * Claude can look at errors across sessions. Large blobs (screenshots/DOM) are
 * never written — only the buffered error metadata (which already excludes
 * them). The file grows unbounded; rotate/delete it yourself when desired.
 */
export class ErrorStore {
  constructor(private readonly filePath: string) {}

  async append(entry: BufferedError): Promise<void> {
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + "\n");
    } catch (e) {
      log("store: append failed:", (e as Error).message);
    }
  }

  private async readAll(): Promise<BufferedError[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return []; // no file yet
    }
    const out: BufferedError[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as BufferedError);
      } catch {
        /* skip a partially written / corrupt line */
      }
    }
    return out;
  }

  /** The last `n` persisted entries, in file order (oldest → newest). */
  async loadRecent(n: number): Promise<BufferedError[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }

  /** Filtered history, newest first. */
  async query(opts: { limit?: number; level?: string; since?: number } = {}): Promise<BufferedError[]> {
    let all = await this.readAll();
    if (opts.level) all = all.filter((e) => e.level === opts.level);
    if (typeof opts.since === "number") {
      all = all.filter((e) => (e.lastSeen ?? e.timestamp) >= opts.since!);
    }
    all.reverse();
    if (typeof opts.limit === "number" && opts.limit >= 0) all = all.slice(0, opts.limit);
    return all;
  }
}
