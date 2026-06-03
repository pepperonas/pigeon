/**
 * Generate the extension PNG icons (16/48/128) by rendering an emoji on a
 * rounded tile with Chrome for Testing (via playwright-core). No image
 * libraries needed. Re-run after changing the design:
 *
 *   node scripts/generate-icons.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "icons");
mkdirSync(OUT, { recursive: true });

const sizes = [16, 48, 128];
const tile = (n) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  .t{width:${n}px;height:${n}px;border-radius:${Math.round(n * 0.22)}px;
     background:linear-gradient(135deg,#7C3AED,#4F46E5);
     display:flex;align-items:center;justify-content:center;overflow:hidden}
  .e{font-size:${Math.round(n * 0.64)}px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}
</style>
<div class="t"><span class="e">🐦</span></div>`;

const browser = await chromium.launch({ headless: false, args: ["--headless=new"] });
try {
  for (const n of sizes) {
    const page = await browser.newPage({ viewport: { width: n, height: n }, deviceScaleFactor: 1 });
    await page.setContent(tile(n), { waitUntil: "load" });
    await page.locator(".t").screenshot({ path: join(OUT, `icon${n}.png`), omitBackground: true });
    await page.close();
    console.error(`wrote icon${n}.png`);
  }
} finally {
  await browser.close();
}
