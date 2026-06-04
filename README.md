# 🐦 Pigeon

<p align="center">
  <img src="https://img.shields.io/badge/Pigeon-console%20errors%20%E2%86%92%20Claude%20Code-7C3AED?style=for-the-badge&logo=anthropic&logoColor=white" alt="Pigeon" />
</p>

<p align="center">
  <a href="https://github.com/pepperonas/pigeon/actions/workflows/ci.yml"><img src="https://github.com/pepperonas/pigeon/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/version-0.2.0-blue.svg?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/status-v1%20minimal-orange.svg?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs welcome" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 18+" />
  <img src="https://img.shields.io/badge/MCP-stdio-000000?style=flat-square&logo=anthropic&logoColor=white" alt="Model Context Protocol" />
  <img src="https://img.shields.io/badge/WebSocket-ws-010101?style=flat-square&logo=socketdotio&logoColor=white" alt="WebSocket" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/bundler-esbuild-FFCF00?style=flat-square&logo=esbuild&logoColor=black" alt="esbuild" />
  <img src="https://img.shields.io/badge/Claude%20Code-ready-D97757?style=flat-square&logo=claude&logoColor=white" alt="Claude Code" />
  <img src="https://img.shields.io/badge/platform-localhost-lightgrey?style=flat-square" alt="localhost" />
</p>

Forward **browser console errors** straight to **Claude Code** — no more copy‑pasting
stack traces. Pigeon captures `console.error`/`console.warn`, uncaught exceptions,
unhandled promise rejections, **and failed network requests** (`fetch`/XHR) from your dev
pages and exposes them to Claude Code over the **Model Context Protocol (MCP)**. Minified
stack traces are **resolved back to original source** via your dev server's source maps.

```
Browser → Extension → WebSocket ┐
                                 ▼
                         Bridge daemon  ──control channel──►  MCP proxy (per session) → Claude Code
                         (one, shared)                        MCP proxy (per session) → Claude Code
```

A browser extension can't talk to a CLI process directly, hence the chain. A single
**bridge daemon** owns the WebSocket the extension connects to plus the error buffer; it's
started automatically and shared by every session. Each Claude Code session runs a thin
**MCP proxy** that forwards tool calls to the daemon over a local control channel — so
**multiple sessions and projects can use Pigeon at once** (scope each to its dev server
with `get_recent_errors({ pageUrl })`).

## Layout

```
pigeon/
  extension/   # Chrome Manifest V3 extension (TypeScript, esbuild)
  server/      # Bridge daemon (WebSocket + buffer) + per-session MCP proxy (TypeScript)
  README.md
```

## What Claude gets

**Tools**

| Tool | Purpose |
|------|---------|
| `get_recent_errors({ limit?, level?, pageUrl?, since? })` | Buffered errors, newest first; filter by `level` (`error`/`warn`/`network`), `pageUrl` substring, or `since` timestamp. |
| `wait_for_next_error({ timeout_ms? })` | Block until the next error arrives — *“reproduce in the browser, then check.”* |
| `get_error_stats()` | Counts per level + newest/oldest timestamps. |
| `clear_errors()` | Empty the buffer. |
| `get_error_history({ limit?, level?, since? })` | **When `PIGEON_DB` is set.** Query the on-disk history — spans restarts, beyond the 200-entry buffer. |
| `reload_tab({ tabId? })` | Reload a dev tab (active localhost tab by default) — re-trigger an error after a fix. |
| `eval_in_page({ expression, tabId?, timeout_ms? })` | **Gated.** Run JS in the page's MAIN world and return the result. Off unless explicitly enabled (see below). |

**Prompts** (appear as slash-commands in Claude Code's `/` menu)

| Prompt | Purpose |
|--------|---------|
| `analyze_browser_errors({ limit?, level?, pageUrl? })` | Embeds the recent errors and asks for root‑cause analysis + concrete fixes. |
| `fix_latest_error()` | Focuses on the single newest error (with its resolved stack) and proposes a fix. |

**Resources**

| Resource | Contents |
|----------|----------|
| `pigeon://errors` | Live JSON snapshot of the buffer. |
| `pigeon://errors/{id}/screenshot` | JPEG of the page when an uncaught error fired. |
| `pigeon://errors/{id}/dom` | `outerHTML` of the page at error time. |

On **uncaught errors / unhandled rejections**, Pigeon also captures a screenshot
(rate-limited, best-effort — the error's tab must be the visible one) and a DOM snapshot.
Entries gain `hasScreenshot`/`hasDom` flags plus `screenshotUri`/`domUri`. Toggle this off
in the popup ("Snapshots on errors"); console/network events never carry snapshots.

Each captured error carries `level`, `message`, `stack`, `source`, `line`, `col`,
`pageUrl`, `origin`, `timestamp`, plus `tabId`/`tabTitle` (which tab it came from) and,
for network events, `status`. When a source map is available, a `resolvedStack` field is
added with the original `file:line:col` frames.

The server keeps a **ring buffer** of the latest 200 errors and **deduplicates**
identical `message`+`stack` pairs seen within 2 seconds (collapsed into one entry with a
`count`).

---

## Setup

### 1. Build & start the bridge server

```bash
cd pigeon
npm run install:all      # installs server/ and extension/ deps
npm run build            # builds both
```

Start the bridge. Normally Claude Code launches it for you (see step 3) — but you can run
it standalone for testing:

```bash
npm start                # = node server/dist/index.js
```

> The bridge listens on `ws://127.0.0.1:8765` for the extension and speaks MCP over
> **stdio**. All logs go to **stderr** (or `$PIGEON_LOG_FILE`) — never stdout, which is
> reserved for the MCP JSON‑RPC protocol.

Smoke‑test without the extension:

```bash
npm test                 # spawns the server, pushes a fake error, asserts the MCP tools
# or, against an already-running server:
npm --prefix server run test:client
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select **`pigeon/extension/dist`**.
4. The 🐦 icon appears. Click it: the popup shows connection status, the number of
   buffered errors, and three toggles — **forwarding** on/off, **Snapshots on errors**,
   and **Allow remote eval ⚠️** (for `eval_in_page`, off by default).

The extension only activates on `http://localhost/*` and `http://127.0.0.1/*` (your dev
servers). It connects to the bridge automatically; if the bridge isn't running yet, it
reconnects with exponential backoff and buffers errors in the meantime.

> Rebuild after changes with `npm run dev:extension` (watch) or `npm --prefix extension
> run build`, then hit **Reload** on the extension card.

### 3. Register the MCP server with Claude Code

Use the absolute path to the built entry point. From the `pigeon/` directory:

```bash
claude mcp add pigeon -- node "$(pwd)/server/dist/index.js"
```

Add `-s user` to register it **globally** (available in every project, not just this one) —
recommended if you do web dev across several repos:

```bash
claude mcp add -s user pigeon -- node "$(pwd)/server/dist/index.js"
```

Or add it to a `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "pigeon": {
      "command": "node",
      "args": ["/Users/martin/claude/pigeon/server/dist/index.js"]
    }
  }
}
```

To enable the optional features, pass the env vars at registration. With the CLI:

```bash
claude mcp add pigeon \
  --env PIGEON_DB="$HOME/.pigeon/history.jsonl" \
  --env PIGEON_ALLOW_EVAL=1 \
  -- node "$(pwd)/server/dist/index.js"
```

…or in `.mcp.json`, add an `"env"` block alongside `command`/`args`:

```json
"env": { "PIGEON_DB": "/abs/path/history.jsonl", "PIGEON_ALLOW_EVAL": "1" }
```

Then, inside Claude Code, verify with `/mcp` — you should see `pigeon` connected with its
four tools and the `pigeon://errors` resource.

---

## Using Pigeon in your Claude Code workflow

Once registered (ideally `-s user`, so it's there in every project) and the extension shows
**Connected**, run your dev server on `localhost` and work as usual. Verify with `/mcp`
(pigeon connected) and the popup's green dot.

### Recipes

- **Reactive — “what's broken?”** → *“What errors are in the browser right now?”* Claude calls
  `get_recent_errors` and reads the message + **source-mapped** stack (original file, not minified).
- **Repro-driven — the core loop.** *“I'll reproduce it, wait for the error.”* Claude calls
  `wait_for_next_error`; you trigger it in the browser; it streams in and Claude fixes it. After the
  fix: *“reload the tab”* → `reload_tab` → wait again. That's **edit → reload → verify** without
  leaving the CLI.
- **Slash-commands.** The prompts appear in the `/` menu: `/analyze_browser_errors` (group all
  current errors by root cause) and `/fix_latest_error` (focus the newest one).
- **Visual / state bugs.** Uncaught errors carry a screenshot + DOM snapshot —
  *“look at the screenshot from the last error”* (`pigeon://errors/{id}/screenshot` and `/dom`).
- **Inspect live (opt-in).** With eval enabled (see Browser control below): *“evaluate
  `window.__store.getState()` in the page”* → `eval_in_page`.
- **Recurring errors.** With `PIGEON_DB` set: *“has this error happened before?”* → `get_error_history`
  (spans restarts).

### Make it smoother

**Let Claude reach for Pigeon on its own** — add to a project's `CLAUDE.md`:

```markdown
## Debugging
For runtime errors in the browser, use the `pigeon` MCP tools
(`get_recent_errors`, `wait_for_next_error`) instead of asking me to paste console output.
```

**Skip permission prompts** for the read-only tools — in `settings.json`:

```json
{ "permissions": { "allow": [
  "mcp__pigeon__get_recent_errors",
  "mcp__pigeon__get_error_stats",
  "mcp__pigeon__wait_for_next_error",
  "mcp__pigeon__get_error_history"
] } }
```

Leave `reload_tab`, `eval_in_page`, and `clear_errors` to prompt.

### Multiple sessions & projects

This works out of the box. A single **bridge daemon** is auto-started on first use and shared
by every Claude Code session — open as many as you like across different projects. All
localhost tabs feed the same buffer; scope each session to its own dev server with the
`pageUrl` filter, e.g. *“errors from `:3000`”* → `get_recent_errors({ pageUrl: "3000" })`.

The daemon keeps running in the background after sessions close (it owns the browser feed) —
normally just leave it. To stop it: `pkill -f dist/bridge.js`. The **first** session's env
(`PIGEON_DB`, `PIGEON_ALLOW_EVAL`) configures the daemon, so set those consistently in your
user-scope registration; later sessions reuse the already-running daemon as-is.

## Browser control & security

Pigeon can also drive the browser, so Claude can *reproduce* a bug rather than only read it:

- **`reload_tab`** — always available; reloads the target tab.
- **`eval_in_page`** — runs **arbitrary JavaScript** in the page. This is powerful and
  dangerous, so it is **off by default** behind a **double opt-in** — both must be true:
  1. Start the server with `PIGEON_ALLOW_EVAL=1` (otherwise the tool isn't even exposed).
  2. Turn on **"Allow remote eval ⚠️"** in the extension popup (otherwise the extension
     refuses every eval command).

  It only targets `localhost`/`127.0.0.1` tabs. Leave both off unless you actively want
  Claude to execute code in your dev page.

## Configuration

| Env var | Default | Where | Meaning |
|---------|---------|-------|---------|
| `PIGEON_WS_PORT` | `8765` | daemon | Extension WebSocket port (must match the extension's `WS_URL`). |
| `PIGEON_CONTROL_PORT` | `8766` | both | Control-channel port between the daemon and MCP proxies. |
| `PIGEON_LOG_FILE` | — | both | If set, mirror stderr logs to this file (handy to see daemon logs). |
| `PIGEON_SOURCEMAPS` | `1` | server | Set to `0` to disable source-map resolution of stacks. |
| `PIGEON_ALLOW_EVAL` | — | server | Set to `1` to expose the `eval_in_page` tool (also needs the popup toggle). |
| `PIGEON_DB` | — | server | Path to a JSONL file; enables persistent history + the `get_error_history` tool. |

Changing the port? Update `WS_URL` in `extension/src/background.ts` and rebuild.

## What's captured

- **Console:** `console.error` / `console.warn` (wrapped, then passed through unchanged).
  The hooks are installed by a `MAIN`-world content script at `document_start`, so they run
  before any page script and catch even synchronous errors during initial load.
- **Uncaught exceptions** (`window` `error`) and **unhandled promise rejections**.
- **Failed network requests:** `fetch` and `XMLHttpRequest` responses with status ≥ 400 or
  a transport failure (status `0`). Intentional `abort`s are ignored. Original semantics
  are preserved — Pigeon never swallows a response or rejection.

## Notes & limits

- **Source maps** are fetched from the dev server on demand and cached briefly (5 s, so
  hot-reloads stay accurate). Resolution is best-effort: no map → the raw stack is kept.
- Only `localhost` / `127.0.0.1` are matched, by design (your dev servers).
- The MV3 service worker sleeps after ~30s idle; Pigeon reconnects on wake (incoming
  messages and a 30s `alarms` heartbeat) and persists the pending queue in
  `chrome.storage.session`, so errors aren't lost across an eviction.
- One browser, one bridge: the buffer is shared across all matched tabs (filter with
  `get_recent_errors({ pageUrl })`).
- **History:** with `PIGEON_DB=/path/to/history.jsonl`, new errors are appended as JSONL and
  reloaded on startup. The file is append-only and excludes screenshots/DOM (those stay
  in-memory only) — rotate or delete it yourself.
- Lighthouse / performance metrics remain out of scope for now.

## Development

```bash
# server
npm --prefix server run dev             # tsc --watch
npm --prefix server run test:e2e        # full MCP proxy/daemon smoke test
npm --prefix server run test:multi      # two sessions sharing one daemon + pageUrl scoping
npm --prefix server run test:sourcemap  # source-map resolution test

# extension
npm --prefix extension run dev           # esbuild --watch
npm --prefix extension run typecheck     # tsc --noEmit
npm --prefix extension run test:unit     # pure serialization unit tests
npm --prefix extension run test:browser  # real-browser smoke test (loads the extension)
```

`test:browser` loads the built extension into **Chrome for Testing** (system Google Chrome
blocks unpacked extensions). Install it once:

```bash
cd extension && node node_modules/playwright-core/cli.js install chromium
```

CI (`.github/workflows/ci.yml`) runs everything on each push: a `build-test` job (build,
typecheck, unit + source-map + MCP E2E) and a `browser-e2e` job (real-browser smoke test).
See [`CLAUDE.md`](CLAUDE.md) for the architecture and the invariants worth not regressing.
