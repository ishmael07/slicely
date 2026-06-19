// Copies static renderer assets (HTML/CSS) and the compiled renderer bundle
// into dist/renderer/ after the TypeScript compiles. The renderer is built
// separately as ESM into dist-web/ (see tsconfig.renderer.json) so its output
// never clobbers the CommonJS dist/shared used by the main process.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";

const assets = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
  // ESM renderer bundle compiled by tsconfig.renderer.json.
  ["dist-web/renderer/renderer.js", "dist/renderer/renderer.js"],
  ["dist-web/renderer/renderer.js.map", "dist/renderer/renderer.js.map"],
];

for (const [from, to] of assets) {
  const src = join(root, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skip (missing): ${from}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`[copy-assets] ${from} -> ${to}`);
}
