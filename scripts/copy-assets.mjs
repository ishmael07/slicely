// Copies static renderer assets (HTML/CSS) and the compiled renderer ESM
// bundle into dist/renderer/ after the TypeScript compiles. The renderer is
// built separately as ESM into dist-web/ (see tsconfig.renderer.json) so its
// output never clobbers the CommonJS dist/shared used by the main process.
import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";

// Static assets.
const assets = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
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

// Copy every compiled renderer module (renderer.js, markdown.js, + maps). The
// renderer uses native browser ESM imports between these files, so they must
// all land in dist/renderer/ with their original names.
const webDir = join(root, "dist-web/renderer");
const outDir = join(root, "dist/renderer");
if (existsSync(webDir)) {
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(webDir)) {
    cpSync(join(webDir, file), join(outDir, file));
    console.log(`[copy-assets] dist-web/renderer/${file} -> dist/renderer/${file}`);
  }
} else {
  console.warn("[copy-assets] dist-web/renderer missing — did the renderer build run?");
}
