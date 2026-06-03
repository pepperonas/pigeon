/**
 * Compile and run the TypeScript unit tests with esbuild (already a dep) — no
 * ts-node / extra tooling. Bundles each *.test.ts to a temp ESM file and imports
 * it; an assertion failure throws and fails the process.
 */
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
for (const t of tests) {
  const out = join(tmpdir(), `pigeon-${t.replace(/\W+/g, "_")}.mjs`);
  await build({
    entryPoints: [join("test", t)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "warning",
  });
  console.error(`# ${t}`);
  await import(pathToFileURL(out).href);
}
console.error("\nUNIT TESTS PASSED");
