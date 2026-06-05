/**
 * The Pigeon dashboard page, served by dashboard.ts. Self-contained (no build,
 * no external requests). The daemon injects the API token so the page's own
 * fetches authenticate; a remote page can't read the token, so it can't drive
 * the API. Polls /api/state every second.
 */
export function dashboardHtml(token: string): string {
  // token is hex from randomBytes — safe to inline as a JS string literal.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>🐦 Pigeon</title>
<script>/* tell the Pigeon extension not to capture its own dashboard (avoids a feedback loop) */ window.__PIGEON_DASHBOARD__ = true;</script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0e0f13; color: #e6e7ea; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; background: #16171d; border-bottom: 1px solid #24262e; position: sticky; top: 0; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
    background: #24262e; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
  .dot.on { background: #22c55e; } .dot.off { background: #ef4444; }
  .grow { flex: 1; }
  button { font: inherit; border: 1px solid #34373f; background: #24262e; color: #e6e7ea;
    padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  button:hover { background: #2c2f38; }
  button.danger { border-color: #5b2330; } button.danger:hover { background: #3a1a22; }
  main { padding: 20px; display: grid; gap: 20px; grid-template-columns: 1fr; max-width: 1100px; margin: 0 auto; }
  section { background: #16171d; border: 1px solid #24262e; border-radius: 12px; padding: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #9aa0ab; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1e2027; font-size: 13px; vertical-align: top; }
  th { color: #9aa0ab; font-weight: 600; }
  .muted { color: #777d88; }
  .pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .lvl-error { background: #3a1a22; color: #fda4af; }
  .lvl-warn  { background: #3a3119; color: #fcd34d; }
  .lvl-network { background: #1a2a3a; color: #93c5fd; }
  .feed { display: flex; flex-direction: column; gap: 8px; }
  .ev { border: 1px solid #1e2027; border-radius: 8px; padding: 8px 10px; }
  .ev summary { cursor: pointer; display: flex; gap: 10px; align-items: baseline; list-style: none; }
  .ev summary::-webkit-details-marker { display: none; }
  .ev .msg { flex: 1; word-break: break-word; }
  .ev pre { margin: 8px 0 0; padding: 8px; background: #0e0f13; border-radius: 6px; overflow: auto;
    font-size: 12px; color: #c7cad1; }
  .ev img { max-width: 100%; margin-top: 8px; border-radius: 6px; border: 1px solid #24262e; }
  .count { background: #24262e; border-radius: 999px; padding: 0 7px; font-size: 11px; }
  .src { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    background: #1b2733; color: #9fc6e8; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
  .ev .meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #9aa0ab; }
  .ev .meta b { color: #c7cad1; font-weight: 600; }
  .tabs { float: right; font-weight: 400; display: flex; gap: 4px; }
  .tab { padding: 3px 10px; font-size: 12px; border-radius: 7px; }
  .tab.on { background: #2c3550; border-color: #3b4a72; color: #cdd8ff; }
  .tab:disabled { opacity: .45; cursor: not-allowed; }
  .empty { color: #777d88; padding: 8px; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<header>
  <h1>🐦 Pigeon</h1>
  <span class="badge"><span id="d-daemon" class="dot off"></span><span id="t-daemon">daemon</span></span>
  <span class="badge"><span id="d-ext" class="dot off"></span><span id="t-ext">extension</span></span>
  <span class="badge" id="b-eval">eval —</span>
  <span class="badge" id="b-hist">history —</span>
  <span class="badge" id="b-ports">ports —</span>
  <span class="grow"></span>
  <button id="btn-clear">Clear buffer</button>
  <button id="btn-shutdown" class="danger">Stop daemon</button>
</header>
<main>
  <section>
    <h2>Sessions <span id="s-count" class="count">0</span></h2>
    <table>
      <thead><tr><th>Project</th><th>PID</th><th>Scope</th><th>Connected</th><th>Idle</th></tr></thead>
      <tbody id="sessions"></tbody>
    </table>
    <div id="sessions-empty" class="empty">No Claude Code sessions connected.</div>
  </section>
  <section>
    <h2>Errors <span id="e-count" class="count">0</span>
      <span class="tabs">
        <button id="tab-live" class="tab on">Live</button>
        <button id="tab-hist" class="tab" title="Persisted JSONL history (PIGEON_DB)">History</button>
      </span>
    </h2>
    <div id="feed" class="feed"></div>
    <div id="feed-empty" class="empty">Buffer is empty.</div>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const H = { "x-pigeon-token": TOKEN };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const ago = (t) => { if (!t) return "—"; const s = Math.max(0, Math.round((Date.now()-t)/1000));
  if (s < 60) return s+"s"; if (s < 3600) return Math.round(s/60)+"m"; return Math.round(s/3600)+"h"; };

async function post(path) {
  try { await fetch(path, { method: "POST", headers: H }); } catch {}
}
$("btn-clear").onclick = () => { if (confirm("Clear the error buffer?")) post("/api/clear").then(refresh); };
$("btn-shutdown").onclick = () => { if (confirm("Stop the Pigeon daemon? Sessions will reconnect/respawn it.")) post("/api/shutdown"); };

function setDot(id, on) { const d = $(id); d.className = "dot " + (on ? "on" : "off"); }

function renderSessions(sessions) {
  $("s-count").textContent = sessions.length;
  const tb = $("sessions");
  $("sessions-empty").style.display = sessions.length ? "none" : "";
  tb.innerHTML = sessions.map((s) =>
    "<tr><td>" + esc(s.projectName || "?") + "</td><td class=muted>" + esc(s.pid ?? "—") +
    "</td><td>" + (s.pageUrlHint ? esc(s.pageUrlHint) : "<span class=muted>—</span>") +
    "</td><td class=muted>" + ago(s.connectedAt) + " ago</td><td class=muted>" + ago(s.lastActivity) + "</td></tr>"
  ).join("");
}

// Remember which entries are expanded so a refresh doesn't collapse them.
const openIds = new Set();
let lastSig = "";
$("feed").addEventListener("toggle", (ev) => {
  const d = ev.target;
  if (!d || d.tagName !== "DETAILS") return;
  const id = d.getAttribute("data-id");
  if (id == null) return;
  if (d.open) openIds.add(id); else openIds.delete(id);
}, true);

function srcHost(url) { if (!url) return ""; try { return new URL(url).host; } catch { return url; } }

function renderFeed(errors) {
  $("e-count").textContent = errors.length;
  $("feed-empty").style.display = errors.length ? "none" : "";
  // Re-render only when the data (or a coarse 10 s time bucket, to refresh the
  // "ago" labels) changes — otherwise an entry you've opened collapses every second.
  const sig = mode + "|" + Math.floor(Date.now() / 10000) + "|" +
    errors.map((e) => e.id + ":" + e.count + ":" + e.lastSeen).join(",");
  if (sig === lastSig) return;
  lastSig = sig;
  $("feed").innerHTML = errors.map((e) => {
    const stack = e.resolvedStack || e.stack || "";
    const shot = e.hasScreenshot ? "<img loading=lazy src='/api/errors/" + e.id + "/screenshot?token=" + encodeURIComponent(TOKEN) + "'>" : "";
    const host = srcHost(e.pageUrl);
    const where = e.source ? e.source + (e.line != null ? ":" + e.line : "") : "";
    const meta = [
      e.pageUrl ? "<b>page</b> " + esc(e.pageUrl) : "",
      e.tabTitle ? "<b>tab</b> " + esc(e.tabTitle) : "",
      e.origin ? "<b>via</b> " + esc(e.origin) : "",
      e.status != null ? "<b>status</b> " + esc(e.status) : "",
      where ? "<b>at</b> " + esc(where) : "",
    ].filter(Boolean).map((x) => "<span>" + x + "</span>").join("");
    const openAttr = openIds.has(String(e.id)) ? " open" : "";
    return "<details class=ev data-id='" + e.id + "'" + openAttr + "><summary>" +
      "<span class='pill lvl-" + esc(e.level) + "'>" + esc(e.level) + "</span>" +
      (host ? "<span class=src>" + esc(host) + "</span>" : "") +
      "<span class=msg>" + esc(e.message) + "</span>" +
      (e.count > 1 ? "<span class=count>x" + e.count + "</span>" : "") +
      "<span class=muted>" + ago(e.lastSeen) + "</span></summary>" +
      "<div class=meta>" + meta + "</div>" +
      (stack ? "<pre>" + esc(stack) + "</pre>" : "") + shot + "</details>";
  }).join("");
}

let mode = "live";       // "live" = in-memory buffer, "hist" = persisted JSONL history
let hasStore = false;
function setMode(m) {
  if (m === "hist" && !hasStore) return;
  mode = m;
  openIds.clear(); lastSig = ""; // fresh view per tab
  $("tab-live").classList.toggle("on", m === "live");
  $("tab-hist").classList.toggle("on", m === "hist");
  refresh();
}
$("tab-live").onclick = () => setMode("live");
$("tab-hist").onclick = () => setMode("hist");

async function refresh() {
  let s;
  try {
    const r = await fetch("/api/state", { headers: H });
    if (!r.ok) throw new Error(r.status);
    s = await r.json();
  } catch {
    setDot("d-daemon", false); $("t-daemon").textContent = "daemon unreachable";
    return;
  }
  setDot("d-daemon", true); $("t-daemon").textContent = "daemon pid " + s.info.pid;
  setDot("d-ext", s.info.extensionConnections > 0);
  $("t-ext").textContent = s.info.extensionConnections > 0 ? "extension (" + s.info.extensionConnections + ")" : "no extension";
  $("b-eval").textContent = "eval " + (s.info.allowEval ? "ON" : "off");
  $("b-hist").textContent = "history " + (s.info.hasStore ? "ON" : "off");
  $("b-ports").textContent = "ws:" + s.info.wsPort + " · ctrl:" + s.info.controlPort + " · ui:" + s.info.dashboardPort;
  renderSessions(s.sessions || []);

  hasStore = !!s.info.hasStore;
  $("tab-hist").disabled = !hasStore;
  if (!hasStore && mode === "hist") setMode("live"); // can't show history without a store

  if (mode === "live") {
    $("feed-empty").textContent = "Buffer is empty.";
    renderFeed(s.errors || []);
  } else {
    try {
      const h = await (await fetch("/api/history?limit=200", { headers: H })).json();
      $("feed-empty").textContent = h.enabled ? "No persisted history yet." : "Persistence is off (set PIGEON_DB).";
      renderFeed(h.errors || []);
    } catch {
      $("feed-empty").textContent = "Could not load history.";
      renderFeed([]);
    }
  }
}
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;
}
