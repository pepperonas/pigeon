import type { WebSocket } from "ws";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1; // WebSocket.OPEN

/**
 * Request/response channel from the MCP server to the browser extension over
 * the same WebSocket the extension uses to push errors.
 *
 * The server sends `{ kind: "command", id, name, ... }`; the extension replies
 * with `{ kind: "command-result", id, ok, result|error }`. Each `send()`
 * returns a promise that resolves/rejects when the matching result arrives or
 * the timeout fires.
 */
export class CommandBus {
  private sockets: WebSocket[] = [];
  private pending = new Map<string, Pending>();
  private seq = 0;

  addSocket(ws: WebSocket): void {
    this.sockets.push(ws);
  }

  removeSocket(ws: WebSocket): void {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }

  hasClient(): boolean {
    return this.sockets.some((s) => s.readyState === OPEN);
  }

  /** Resolve/reject the pending command a `command-result` message refers to. */
  handleResult(msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): void {
    if (typeof msg.id !== "string") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(typeof msg.error === "string" ? msg.error : "command failed"));
  }

  /** Send a command to the most recently connected extension and await its result. */
  send(name: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    const socket = [...this.sockets].reverse().find((s) => s.readyState === OPEN);
    if (!socket) return Promise.reject(new Error("no browser extension connected"));
    const id = `cmd_${++this.seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command '${name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ kind: "command", id, name, ...params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
}
