# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pigeon forwards browser console errors (and uncaught exceptions, unhandled rejections, failed
network requests) to Claude Code over MCP, and can drive the browser back. A Chrome MV3
extension captures errors and ships them over a WebSocket to a standalone **bridge daemon**;
each Claude Code session runs a thin **MCP proxy** that talks to the daemon over a control
channel — so many sessions/projects share one browser feed. The daemon also serves a local
**web dashboard** and backs a `pigeon` **CLI** (`status`/`doctor`/`stop`/`dashboard`).

```
page → injected(MAIN) → content(ISOLATED) → service worker → WS(:8765) → bridge daemon
                                                                  │ control channel (:8766)
                                          MCP proxy (per session) ┤  dashboard http (:8767)
                                                       pigeon CLI ┴─ stdio ─→ Claude Code
```

## Commands

```bash
npm run install:all          # install server/ + extension/ deps
npm run build                # build both packages

# server/ (tsc, Node16 ESM)
npm --prefix server run build
npm --prefix server start            # MCP proxy (how Claude Code launches it; auto-spawns the daemon)
npm --prefix server run bridge       # run the daemon directly (debugging)
npm --prefix server run cli -- status    # pigeon CLI: status | doctor | stop | dashboard
npm --prefix server run test:e2e         # full proxy/daemon E2E (drives every tool over the control channel)
npm --prefix server run test:multi       # two proxies share one daemon + pageUrl scoping + session identity
npm --prefix server run test:ports       # daemon shifts ports when 8765/8766 are taken
npm --prefix server run test:dashboard   # daemon's dashboard HTTP API: token gating, /api/state, clear
npm --prefix server run test:sourcemap   # source-map resolution test

# extension/ (esbuild bundle + tsc typecheck)
npm --prefix extension run build
npm --prefix extension run typecheck
npm --prefix extension run test:unit     # pure serialization unit tests (esbuild + node:assert)
npm --prefix extension run test:browser  # loads the extension into Chrome for Testing (real E2E)
```

There is no per-test runner; each `test:*` is a standalone script. Run one directly with
`node server/dist/<name>.js` (after `build`) or `node extension/test/<name>.mjs`.

`test:browser` needs Chromium once: `cd extension && node node_modules/playwright-core/cli.js install chromium`
(uses the ms-playwright cache; system Google Chrome does **not** work — it blocks unpacked extensions).

## Architecture

**server/** — split into a **daemon** and a **proxy** so many sessions share one feed:

*Daemon* (`bridge.ts`, run via `pigeon-bridge` / auto-spawned): owns all state.
- `buffer.ts` `ErrorBuffer` — ring buffer (200) with 2 s dedup on `message`+`stack`. Large blobs
  (screenshot/DOM) are kept in a separate attachment store (cap 20) keyed by error id, never in
  the ring. Emits `add` (any add/bump → wakes `wait_for_next_error`) and `new` (brand-new only →
  persistence). `hydrate()` seeds from history without re-emitting.
- `ws-server.ts` — `ws` server on `127.0.0.1:8765` (extension). Validates/normalizes events,
  routes `command-result` to the CommandBus, kicks off async source-map resolution that mutates
  the stored entry's `resolvedStack`.
- `commandbus.ts` `CommandBus` — request/response daemon → extension over that WebSocket
  (`{kind:"command"}` out, `{kind:"command-result"}` back), correlated by id with timeouts.
- `sourcemap.ts` — fetches the dev server's JS + maps to rewrite minified stacks (cached 5 s).
- `store.ts` `ErrorStore` — append-only JSONL history when `PIGEON_DB` is set.
- `control.ts` `startControlServer` — control channel (RPC: `register/info/listSessions/getRecent/
  clear/stats/history/getAttachment/waitForNext/sendCommand/shutdown`). Binds the first free port
  from the base. **Tracks sessions**: each connection that `register`s (pid/cwd/projectName from the
  proxy) becomes a `SessionInfo`; `getRecent({pageUrl})` records the session's `pageUrlHint` (its
  inferred scope); `listSessions()` returns the registered ones. `info` reports daemon meta (ports,
  pid, version, uptime, buffer total, extension count, session count) read lazily from a mutable
  `DaemonMeta` the bridge fills after binding. `ControlClient` gained an `onOpen` hook (re-sends
  `register` on every reconnect) + `notify()` (fire-and-forget).
- `dashboard.ts` + `dashboard-html.ts` `startDashboard` — local web dashboard (HTTP, first-free
  port from 8767). **127.0.0.1 only**, `Host`-header allowlist (anti-rebinding), every `/api/*`
  gated on a per-daemon **token** (in the 600-mode runtime file + embedded in the served HTML);
  mutations also require same-origin. Read-mostly (`/api/state` polled 1 s, attachments, `clear`,
  `shutdown`). Eval state is shown **read-only** — never toggled here. On by default (`PIGEON_DASHBOARD=0` off).
- `runtime.ts` — out-of-the-box port handling: `bindWss` picks the first free port from a base
  (closing failed binds as it scans); `acquireLock` is the **singleton lock** (atomic `wx` lock
  file, stale-pid reclaim); the daemon writes its chosen ports + dashboard port + token to
  `~/.pigeon/runtime.json` **atomically** (temp + rename, mode 600 — it carries the token) and
  removes lock + file on exit. `PORT_SCAN_RANGE` must stay in sync with the extension's scan.

*Proxy* (`index.ts`, the per-session MCP server Claude Code launches):
- Discovers the daemon's control port via `~/.pigeon/runtime.json` (`readRuntime`), retrying a
  recorded-but-busy daemon a few times before auto-spawning `bridge.js` **detached** and polling
  the file (discovery/spawn helpers live in `discover.ts`, shared with the CLI). On connect it
  `register`s its identity (pid, cwd, **git-repo-root** projectName). Queries `info` for capability gating.
- `cli.ts` (`pigeon` bin) — terminal program (stdout is free here): `status` (health/ports/buffer/
  sessions), `doctor` (PASS/WARN/FAIL with hints), `stop` (graceful `shutdown` RPC), `dashboard`
  (opens the UI). Uses `discover.ts`'s `connectOnly` — never spawns a daemon.
- `mcp-server.ts` — high-level `McpServer` over stdio; every tool/resource/prompt forwards to the
  daemon through the control client. Resources use `ResourceTemplate` for per-error screenshot/DOM.
- `log.ts` — **all logging goes to stderr** (or `PIGEON_LOG_FILE`). Shared by both. `version.ts`
  `VERSION` is the single version constant (keep in sync with `package.json`).

**extension/** (MV3, bundled per-entry by `build.mjs`):
- `injected.ts` — runs in the **MAIN world as a content script at `document_start`** (declared in
  `manifest.json`, *not* injected via `<script>`), so it wraps `console`/`error`/`unhandledrejection`/
  `fetch`/`XHR` before any page script. Posts events via `window.postMessage`.
- `content.ts` — ISOLATED world; relays postMessage → `chrome.runtime.sendMessage` **with retry**
  (early events would otherwise be dropped before the lazy SW is listening).
- `background.ts` — service worker. WebSocket client that **scans `WS_BASE..+WS_PORT_SCAN`** to
  find the daemon (it can't read the runtime file): remembers the working port, retries the SAME
  port on a healthy drop and only advances on a connect failure (fast-sweep then back off).
  `alarms` heartbeat, throttled session-persisted queue, screenshot capture, and `handleCommand`
  (reload / eval via `chrome.scripting.executeScript` in MAIN world). Keep `WS_BASE`/`WS_PORT_SCAN`
  in sync with `runtime.ts`.
- `popup.*` / `serialize.ts` (pure, unit-tested).

## Invariants & gotchas (don't regress these)

- **stdout is sacred** in the MCP proxy (`index.ts`): it's the JSON-RPC channel. Never
  `console.log`; use `log()` from `log.ts`. The E2E test passing proves the protocol stays clean.
- **Daemon is the single source of truth.** The proxy holds no state — all tool handlers RPC to
  the daemon. The control port (`:8766`) is the singleton lock; the daemon survives session exit
  and is shared. Test with isolated ports + `shutdownDaemon()` so runs don't touch a real daemon.
- **injected.ts must stay a MAIN-world content script.** The old `<script src>` injection loaded
  async and missed synchronous early errors — that's a fixed bug; don't reintroduce it.
- **content→SW delivery must retry.** Same reason — early errors race the SW cold start.
- Server uses **Node16 module resolution**: relative imports must carry the `.js` extension.
- The buffer attachment cap (20) < ring size (200): when an attachment is evicted its entry's
  `hasDom`/`hasScreenshot` flags are cleared so it stops advertising a dead resource.
- **`info` is additive** — `allowEval`/`hasStore` stay; new fields are optional, so an old proxy
  against a new daemon (or vice-versa) still works. `register` is best-effort (CLI/old proxies skip
  it); `listSessions()` filters to registered connections, so CLI/dashboard connections never show
  up as phantom sessions.
- **Dashboard token lives in `runtime.json` (mode 600).** All `/api/*` require it; the served HTML
  embeds it so the page authenticates but a remote page can't read it. Keep the `Host` allowlist and
  127.0.0.1 bind — the buffer holds page data, so the HTTP listener is real attack surface.

## Gating (security)

`eval_in_page` runs arbitrary JS in the page — **double opt-in**: daemon env `PIGEON_ALLOW_EVAL=1`
(reported via `info`, else the tool isn't registered) **and** the extension popup's "Allow remote
eval" toggle (default off). `reload_tab` is always available. Browser-captured strings are
untrusted: the MCP prompts fence them as data (see `untrustedBlock` in `mcp-server.ts`) — keep
that when editing prompts. The **dashboard never toggles eval** (would defeat the double opt-in) —
it only displays the state. Dashboard HTML escapes all browser-captured strings (`esc()` in
`dashboard-html.ts`) — keep that; the feed renders untrusted error text.

## Env flags

`PIGEON_WS_PORT` (8765 base) · `PIGEON_CONTROL_PORT` (8766 base) · `PIGEON_DASHBOARD_PORT` (8767
base) · `PIGEON_DASHBOARD` (`0` disables the dashboard; on by default) · `PIGEON_SOURCEMAPS` (1) ·
`PIGEON_ALLOW_EVAL` · `PIGEON_DB` (JSONL path) · `PIGEON_LOG_FILE` · `PIGEON_RUNTIME_DIR`
(`~/.pigeon`, override for tests). Ports are *bases* — the daemon takes the first free one from
each. These configure the **daemon** (the proxy forwards its env when auto-spawning it). Changing
the WS base also means bumping `WS_BASE` in `extension/src/background.ts`.

## CI

`.github/workflows/ci.yml`: `build-test` (build both, typecheck, unit + sourcemap + E2E + multi +
ports + dashboard) and `browser-e2e` (installs Chrome for Testing, runs the real-browser smoke test).
