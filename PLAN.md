# Pigeon — UX-Plan: Start & Session-Management

> Status: **✅ umgesetzt** (alle drei Tiers). Entscheidungen: Projektname = Git-Repo-Root,
> Dashboard standardmäßig an. Neue Dateien: `cli.ts`, `discover.ts`, `dashboard.ts`,
> `dashboard-html.ts`, `version.ts`, `dashboard-test.ts`. Tests grün (e2e/multi/ports/
> dashboard/sourcemap/unit). Dieses Dokument bleibt als Design-Referenz.

## Ausgangslage (im Code verifiziert)
- **Sessions sind heute anonym.** `startControlServer` (`control.ts`) akzeptiert
  Verbindungen ohne Identität — kein `cwd`, keine PID, kein Projekt. Der Daemon kann
  nicht sagen, *wer* verbunden ist.
- **`info` liefert nur** `{ allowEval, hasStore }`. Keine Ports/Uptime/Buffer-Größe.
- **Extension-Verbindung** wird in `ws-server.ts` geloggt, aber nicht als Zustand
  gehalten (`CommandBus` kennt die Sockets, exponiert aber keinen Count).
- **Discovery** über `runtime.json` = `{ pid, wsPort, controlPort, startedAt }`.
- **Bins** heute: `pigeon-server`, `pigeon-bridge`. Kein Nutzer-CLI.

→ Ein „Sessions-Überblick" ist erst möglich, wenn Sessions eine Identität haben.
Deshalb ist **Tier 2 die Grundlage**, Tier 1 der schnelle Sofortnutzen, Tier 3 die Kür.

---

## Tier 1 — `pigeon` CLI (Start- & Diagnose-Komfort)

**Neu:** `server/src/cli.ts`, Bin `"pigeon": "dist/cli.js"`. Stdout ist hier frei
(kein MCP-Kanal) → normales `console.log`.

**Refactor zuerst:** `openControl` + `liveControlPort` + `connectOrSpawn` aus `index.ts`
in ein gemeinsames `server/src/discover.ts`. `index.ts` nutzt `connectOrSpawn` (spawnt),
CLI nutzt `connectOnly` (spawnt **nicht** — „läuft nicht" ist eine gültige Antwort).

| Befehl | Tut |
|--------|-----|
| `pigeon status` | `runtime.json` lesen; PID tot/fehlt → „not running". Sonst `info`+`stats`+`listSessions` → Tabelle: PID, Uptime, WS/Control(/Dashboard)-Port, eval/history-Flags, Buffer-Total + byLevel, Extension verbunden? (n), Session-Liste (Projekt · PID · seit · idle · pageUrl-Scope). |
| `pigeon doctor` | PASS/WARN/FAIL mit Handlungshinweis: Daemon up · `dist/` gebaut · Ports erreichbar · Extension je verbunden · eval-Gating · Node-Version. Deckt ~80 % der „warum geht's nicht"-Fälle ohne Browser ab. |
| `pigeon stop` | `shutdown`-RPC (existiert), Fallback `pkill -f dist/bridge.js`. |
| `pigeon dashboard` *(Tier 3)* | Öffnet die Dashboard-URL im Browser. |

**`info` erweitern** (additiv): `+ pid, wsPort, controlPort, startedAt, version,
bufferTotal, extensionConnections, sessionCount`. Dazu `CommandBus.count()`.

---

## Tier 2 — Session-Identität (Grundlage)

**Protokoll:** neue Control-Methode `register`, vom Proxy **nach jedem (Re-)Connect**
als erste Nachricht gesendet:
```
register({ pid, cwd, projectName, clientStartedAt, mcpVersion })
```
- `ControlClient` bekommt einen `onOpen?(client)`-Hook (im `ensure().then` nach `attach`),
  den `index.ts` setzt → überlebt Reconnects.
- `projectName` = Basename von `process.cwd()` (Default; Option: Git-Repo-Root).

**Daemon-seitig (`control.ts`):** pro Verbindung ein `Session`-Record:
```
{ id, pid, cwd, projectName, clientStartedAt, connectedAt, lastActivity, pageUrlHint? }
```
- `lastActivity` bei jedem Request aktualisieren.
- `pageUrlHint`: zuletzt in `getRecent({pageUrl})` gesehener Filter dieser Session →
  „Session X ⟶ `:3000`" geschenkt.
- Cleanup im `ws.on("close")`.
- Neue Methode `listSessions()` → Array (rohe Timestamps).

Damit ist Session-Management schon ohne Dashboard nutzbar (`pigeon status` listet Projekte).

---

## Tier 3 — Web-Dashboard (vom Daemon serviert)

**Neu:** `server/src/dashboard.ts`, `startDashboard(host, basePort, deps)`. Eigener
HTTP-Port (Base **8767**, first-free), **nur `127.0.0.1`**. Port wandert in `runtime.json`
(`dashboardPort`).

Eine self-contained `index.html` (kein Build) + schlanke API:

| Endpoint | Zweck |
|----------|-------|
| `GET /api/state` | `info` + `stats` + `listSessions` (one-shot) |
| `WS /live` | Buffer-`add`, Session-connect/disconnect, periodische Stats |
| `GET /api/errors/:id/screenshot` · `/dom` | Attachments (`buffer.getAttachment`) |
| `POST /api/clear` | `buffer.clear()` |
| `POST /api/shutdown` | sauberer Stop |

**UI:** Header (Health · Ports · Uptime · eval/history-Badges) · Sessions-Panel · Live-Error-Feed
(level-farbig, Klick → Detail mit resolved Stack + Screenshot/DOM) · per-`pageUrl`-Aufschlüsselung ·
Buffer leeren.

---

## ⚠️ Sicherheit (Dashboard)
Buffer enthält Error-Messages und DOM-Snapshots — potenziell sensibel. HTTP-Listener =
neue Angriffsfläche (der rohe Control-WS war nicht-Browser):
- **Nur `127.0.0.1` binden.**
- **`Host`-Header-Allowlist** (`127.0.0.1:<port>`/`localhost:<port>`) gegen DNS-Rebinding.
- **Token-Gate:** Daemon legt ein Secret in `runtime.json` (mode 600); die HTML bettet es
  ein, alle `/api/*` müssen es mitschicken. Fremde localhost-Seite kann `runtime.json` nicht
  lesen → kein Zugriff. Mutationen zusätzlich nur same-origin.
- **Eval-Gating unangetastet:** Dashboard zeigt eval-Status nur an, schaltet nicht um
  (sonst Double-Opt-in zur Laufzeit aushebelbar = Regression).

---

## Was wo angefasst wird
| Datei | Änderung | Tier |
|-------|----------|------|
| `discover.ts` *(neu)* | geteilte Connect-Helfer (Refactor aus `index.ts`) | 1 |
| `cli.ts` *(neu)* + `package.json` bin `pigeon` | status/doctor/stop/dashboard | 1 |
| `control.ts` | `info` erweitern, `register`+`listSessions`, Per-Connection-Tracking, `onOpen` | 1+2 |
| `commandbus.ts` | `count()` (Extension-Sockets) | 1 |
| `index.ts` | `register` nach Connect senden | 2 |
| `runtime.ts` | `dashboardPort` + `token` in `RuntimeInfo` | 3 |
| `dashboard.ts` *(neu)* + `index.html` | HTTP/WS-Dashboard | 3 |
| `bridge.ts` | `startDashboard(...)` verdrahten | 3 |
| Tests | `test:multi` um register/listSessions; Dashboard-`/api/state`-Smoke | 1–3 |
| `README.md` / `CLAUDE.md` | CLI + Dashboard dokumentieren | alle |

**Invarianten gewahrt:** stdout im Proxy sauber (CLI eigener Bin), Daemon Single-Source-of-Truth,
alle Listener `127.0.0.1`, `info`-Erweiterung additiv (alte Proxies brechen nicht).

---

## Offene Entscheidungen
1. **Projektname-Quelle:** `basename(cwd)` vs. Git-Repo-Root?
2. **Dashboard:** Port-Env `PIGEON_DASHBOARD_PORT` (Base 8767); standardmäßig an oder hinter
   `PIGEON_DASHBOARD=1`?
3. **Umfang:** nur Tier 1+2 zuerst, oder gleich bis Tier 3 durchziehen?
