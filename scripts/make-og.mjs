// Renders site/og.html to site/og.png at 1200x630 — the share card every link
// preview shows. The PNG is committed, so a deploy never needs this script; run
// it only after editing og.html.
//
//   node scripts/make-og.mjs [--out <path>] [--check]
//
//   --check   render to a temp file and compare against the committed PNG
//             instead of overwriting it. Exits 1 if they differ, which is what
//             CI would use to notice an og.html edit with no regenerated PNG.
//
// It drives the same headless Chromium the browser-automation skill uses, and
// resolves it the same way (a CodeGPT extension's bundled patchright, then a
// plain playwright install). There is no new dependency in package.json for
// this: nothing in the product needs a browser, and a 300 MB devDependency to
// regenerate one image occasionally is a bad trade.
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";

const WIDTH = 1200;
const HEIGHT = 630;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "site/og.html");

const args = process.argv.slice(2);
const check = args.includes("--check");
const outFlag = args.indexOf("--out");
const committed = join(root, "site/og.png");
const out = check
  ? join(tmpdir(), `slicely-og-check-${process.pid}.png`)
  : outFlag === -1
    ? committed
    : args[outFlag + 1];

/**
 * Find a Playwright-compatible chromium launcher without adding a dependency.
 * Mirrors the browser-automation skill's own resolution order so the PNG is
 * produced by the same browser that verifies the site.
 */
function resolveChromium() {
  const roots = [];
  for (const base of [
    join(homedir(), ".vscode-server/extensions"),
    join(homedir(), ".vscode/extensions"),
  ]) {
    if (!existsSync(base)) continue;
    const newest = readdirSync(base)
      .filter((d) => d.startsWith("danielsanmedium.dscodegpt-"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      .pop();
    if (newest) roots.push(join(base, newest, "standalone") + "/");
  }
  roots.push(root + "/", process.cwd() + "/");

  for (const from of roots) {
    for (const pkg of ["patchright", "playwright", "playwright-core"]) {
      try {
        const mod = createRequire(from)(pkg);
        const chromium = mod?.chromium ?? mod?.default?.chromium;
        if (chromium) return { chromium, from, pkg };
      } catch {}
    }
  }
  throw new Error(
    "No headless browser found. Looked for patchright/playwright under:\n  " +
      roots.join("\n  ") +
      "\nInstall one (npx playwright install chromium) and re-run.",
  );
}

if (!existsSync(source)) throw new Error(`missing ${source}`);

const { chromium, pkg } = resolveChromium();
console.log(`[make-og] browser: ${pkg}`);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    // Render at 1x: the card is consumed at 1200x630 and a 2x file is four
    // times the bytes for no visible gain in any preview that shows it.
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const failed = [];
  page.on("requestfailed", (r) => failed.push(r.url()));

  await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
  // The self-hosted Inter faces must actually be in before the capture, or the
  // card silently ships in the fallback stack with different metrics.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);

  if (failed.length) {
    throw new Error(`og.html could not load: ${failed.join(", ")}`);
  }

  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
} finally {
  await browser.close();
}

if (check) {
  const fresh = readFileSync(out);
  rmSync(out, { force: true });
  if (!existsSync(committed)) {
    console.error("[make-og] site/og.png is missing — run without --check.");
    process.exit(1);
  }
  if (!fresh.equals(readFileSync(committed))) {
    console.error("[make-og] site/og.png is stale — re-run `node scripts/make-og.mjs`.");
    process.exit(1);
  }
  console.log("[make-og] site/og.png is up to date.");
} else {
  console.log(`[make-og] ${out} — ${WIDTH}x${HEIGHT}, ${statSync(out).size} bytes`);
}
