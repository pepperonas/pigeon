import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/injected.ts",
    "src/popup.ts",
  ],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome110",
  logLevel: "info",
};

function copyStatic() {
  cpSync("manifest.json", "dist/manifest.json");
  cpSync("popup.html", "dist/popup.html");
  for (const n of [16, 48, 128]) cpSync(`icons/icon${n}.png`, `dist/icon${n}.png`);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  copyStatic();
  console.log("pigeon-extension: watching for changes…");
} else {
  await esbuild.build(options);
  copyStatic();
  console.log("pigeon-extension: built → dist/");
}
