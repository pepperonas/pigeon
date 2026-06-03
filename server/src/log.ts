import { appendFileSync } from "node:fs";

/**
 * Logging for a stdio MCP server.
 *
 * CRITICAL: stdout is reserved for the JSON-RPC protocol with Claude Code.
 * Writing anything other than protocol frames to stdout corrupts the stream.
 * Everything here goes to stderr (and, optionally, a log file via PIGEON_LOG_FILE).
 * Never use console.log anywhere in this server.
 */

const LOG_FILE = process.env.PIGEON_LOG_FILE;

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(...args: unknown[]): void {
  const line = `[pigeon ${new Date().toISOString()}] ${args.map(fmt).join(" ")}`;
  process.stderr.write(line + "\n");
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line + "\n");
    } catch {
      /* ignore log-file failures */
    }
  }
}
