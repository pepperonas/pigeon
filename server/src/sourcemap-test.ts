/**
 * Focused test for sourcemap.ts: serve a minified file with an inline source
 * map over HTTP, then confirm resolveStack rewrites a frame to the original
 * source position. Standalone process — console.* is fine. Exits non-zero on fail.
 */
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { SourceMapGenerator } from "source-map-js";
import { resolveStack } from "./sourcemap.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

// Build a map: minified app.min.js (1:10) -> original src/app.ts (5:2), name "boom".
const gen = new SourceMapGenerator({ file: "app.min.js" });
gen.addMapping({
  generated: { line: 1, column: 10 },
  original: { line: 5, column: 2 },
  source: "webpack://demo/./src/app.ts",
  name: "boom",
});
const inlineMap =
  "data:application/json;base64," + Buffer.from(gen.toString(), "utf8").toString("base64");
const minified = `function n(){throw new Error("boom")}n();\n//# sourceMappingURL=${inlineMap}\n`;

const server = createServer((req, res) => {
  if (req.url === "/app.min.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(minified);
  } else {
    res.writeHead(404).end();
  }
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

// Frame column is 1-based in stacks; 11 -> source-map column 10.
const stack = `Error: boom\n    at n (${base}/app.min.js:1:11)`;

const resolved = await resolveStack(stack, `${base}/index.html`);
console.error("resolved:\n" + resolved);

assert(resolved !== undefined, "resolveStack returned a rewritten stack");
assert(resolved!.includes("src/app.ts:5:3"), "frame mapped to src/app.ts:5:3 (col 2 -> 3)");
assert(resolved!.includes("boom"), "original name 'boom' present");
assert(!resolved!.includes("webpack://"), "webpack:// prefix stripped");

// A stack with no resolvable frames returns undefined (leaves caller's stack as-is).
const none = await resolveStack(`Error: x\n    at ${base}/missing.js:1:1`);
assert(none === undefined, "unresolvable stack returns undefined");

server.close();
console.error("\nSOURCEMAP CHECKS PASSED");
process.exit(0);
