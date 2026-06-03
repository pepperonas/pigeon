import { SourceMapConsumer } from "source-map-js";
import { log } from "./log.js";

/**
 * Resolve minified stack traces back to original source positions using the
 * dev server's source maps.
 *
 * Strategy: parse `http(s)://host/file.js:line:col` locations out of a stack,
 * fetch each referenced script, read its `//# sourceMappingURL=`, load the map
 * (inline data-URI or sibling .map file), and rewrite each frame to
 * `original/source.tsx:line:col`.
 *
 * Everything here is best-effort — any failure leaves the stack untouched.
 * Disable entirely with PIGEON_SOURCEMAPS=0.
 */

const ENABLED = process.env.PIGEON_SOURCEMAPS !== "0";
const CACHE_TTL_MS = 5000; // dev files change often — keep maps fresh
const FETCH_TIMEOUT_MS = 2000;

// `http://host/app.js:10:1234` — captures url, line, col (1-based, Chrome style).
const FRAME_RE = /(https?:\/\/[^\s)'"]+?):(\d+):(\d+)/g;

type CacheEntry = { at: number; consumer: SourceMapConsumer | null };
const cache = new Map<string, CacheEntry>();

async function fetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractSourceMappingURL(js: string): string | null {
  // Last occurrence wins (matches browser behaviour).
  const re = /[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(js)) !== null) last = match[1];
  return last;
}

function decodeInlineMap(mapUrl: string): string | null {
  // data:application/json;base64,XXXX  or  data:application/json,<urlencoded>
  const comma = mapUrl.indexOf(",");
  if (comma === -1) return null;
  const meta = mapUrl.slice(5, comma); // strip "data:"
  const payload = mapUrl.slice(comma + 1);
  try {
    if (meta.includes("base64")) return Buffer.from(payload, "base64").toString("utf8");
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

async function loadConsumer(scriptUrl: string): Promise<SourceMapConsumer | null> {
  const cached = cache.get(scriptUrl);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.consumer;

  let consumer: SourceMapConsumer | null = null;
  try {
    const js = await fetchText(scriptUrl);
    if (js) {
      const mapRef = extractSourceMappingURL(js);
      if (mapRef) {
        const rawMap = mapRef.startsWith("data:")
          ? decodeInlineMap(mapRef)
          : await fetchText(new URL(mapRef, scriptUrl).href);
        if (rawMap) consumer = new SourceMapConsumer(JSON.parse(rawMap));
      }
    }
  } catch (e) {
    log("sourcemap: failed for", scriptUrl, (e as Error).message);
    consumer = null;
  }

  cache.set(scriptUrl, { at: Date.now(), consumer });
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  return consumer;
}

function cleanSourcePath(src: string): string {
  // webpack://my-app/./src/App.tsx -> src/App.tsx ; keep others as-is.
  return src.replace(/^webpack:\/\/[^/]*\/(\.\/)?/, "").replace(/^\.\//, "");
}

/**
 * Returns a source-mapped copy of `stack`, or undefined if nothing could be
 * resolved (no maps, fetch failed, or feature disabled).
 */
export async function resolveStack(
  stack: string | undefined,
  _pageUrl?: string,
): Promise<string | undefined> {
  if (!ENABLED || !stack) return undefined;

  // Unique script URLs referenced in the stack.
  const urls = new Set<string>();
  for (const m of stack.matchAll(FRAME_RE)) urls.add(m[1]);
  if (urls.size === 0) return undefined;

  const consumers = new Map<string, SourceMapConsumer | null>();
  await Promise.all(
    [...urls].map(async (u) => consumers.set(u, await loadConsumer(u))),
  );
  if ([...consumers.values()].every((c) => c === null)) return undefined;

  let changed = false;
  const resolved = stack.replace(FRAME_RE, (whole, url: string, lineStr: string, colStr: string) => {
    const consumer = consumers.get(url);
    if (!consumer) return whole;
    const pos = consumer.originalPositionFor({
      line: Number(lineStr),
      column: Number(colStr) - 1, // stacks are 1-based, source maps 0-based
    });
    if (!pos.source || pos.line == null) return whole;
    changed = true;
    const name = pos.name ? ` (${pos.name})` : "";
    return `${cleanSourcePath(pos.source)}:${pos.line}:${(pos.column ?? 0) + 1}${name}`;
  });

  return changed ? resolved : undefined;
}
