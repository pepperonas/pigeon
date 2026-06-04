# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pigeon forwards browser console errors (and uncaught exceptions, unhandled rejections, failed
network requests) to Claude Code over MCP, and can drive the browser back. A Chrome MV3
extension captures errors and ships them over a WebSocket to a standalone **bridge daemon**;
each Claude Code session runs a thin **MCP proxy** that talks to the daemon over a control
channel — so many sessions/projects share one browser feed.

```
page → injected(MAIN) → content(ISOLATED) → service worker → WS(:8765) → bridge daemon
                                                                  │ control channel (:8766)
                                          MCP proxy (per session) ┴─ stdio ─→ Claude Code
```

## Commands

```bash
npm run install:all          # install server/ + extension/ deps
npm run build                # build both packages

# server/ (tsc, Node16 ESM)
npm --prefix server run build
npm --prefix server start            # run the bridge (also how Claude Code launches it)
npm --prefix server run test:e2e         # full MCP client/server E2E (spawns server, drives tools)
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
- `control.ts` `startControlServer` — control channel on `:8766`; binding it is the **singleton
  lock** (daemon exits if already bound). Serves RPC: `getRecent/clear/stats/history/getAttachment/
  waitForNext/sendCommand/info/shutdown`.

*Proxy* (`index.ts`, the per-session MCP server Claude Code launches):
- Connects to the daemon via `ControlClient` (`control.ts`), auto-spawning `bridge.js` **detached**
  if the control port is refused. Queries `info` for capability gating.
- `mcp-server.ts` — high-level `McpServer` over stdio; every tool/resource/prompt forwards to the
  daemon through the control client. Resources use `ResourceTemplate` for per-error screenshot/DOM.
- `log.ts` — **all logging goes to stderr** (or `PIGEON_LOG_FILE`). Shared by both.

**extension/** (MV3, bundled per-entry by `build.mjs`):
- `injected.ts` — runs in the **MAIN world as a content script at `document_start`** (declared in
  `manifest.json`, *not* injected via `<script>`), so it wraps `console`/`error`/`unhandledrejection`/
  `fetch`/`XHR` before any page script. Posts events via `window.postMessage`.
- `content.ts` — ISOLATED world; relays postMessage → `chrome.runtime.sendMessage` **with retry**
  (early events would otherwise be dropped before the lazy SW is listening).
- `background.ts` — service worker. WebSocket client (backoff reconnect, `alarms` heartbeat,
  session-persisted queue), screenshot capture, and `handleCommand` (reload / eval via
  `chrome.scripting.executeScript` in MAIN world).
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

## Gating (security)

`eval_in_page` runs arbitrary JS in the page — **double opt-in**: daemon env `PIGEON_ALLOW_EVAL=1`
(reported via `info`, else the tool isn't registered) **and** the extension popup's "Allow remote
eval" toggle (default off). `reload_tab` is always available. Browser-captured strings are
untrusted: the MCP prompts fence them as data (see `untrustedBlock` in `mcp-server.ts`) — keep
that when editing prompts.

## Env flags

`PIGEON_WS_PORT` (8765) · `PIGEON_CONTROL_PORT` (8766) · `PIGEON_SOURCEMAPS` (1) ·
`PIGEON_ALLOW_EVAL` · `PIGEON_DB` (JSONL path) · `PIGEON_LOG_FILE`. These configure the **daemon**
(the proxy forwards its env when auto-spawning it). Changing the WS port also requires updating
`WS_URL` in `extension/src/background.ts`.

## CI

`.github/workflows/ci.yml`: `build-test` (build both, typecheck, unit + sourcemap + E2E + multi) and
`browser-e2e` (installs Chrome for Testing, runs the real-browser smoke test).
