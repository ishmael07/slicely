// Post-build check: the browser client really did compile.
//
// This script used to copy the Electron renderer's HTML/CSS and its compiled
// ESM modules into dist/renderer/. There is no Electron renderer any more (Task
// E3) — the Mac app loads the web client over its own loopback server — and the
// web client needs no copying: the server serves `src/web/index.html` and
// `src/web/styles.css` straight from the source tree (they are inputs, not build
// outputs) and the compiled modules straight from `dist-web/web` (see
// src/server/static.ts's allow-list).
//
// So all that is left is the one thing worth failing the build over: if the
// second `tsc` pass didn't run or emitted nothing, `dist-web/web` is missing and
// the app would start, serve its HTML, and then 404 every script in it — a
// blank window with an error only the devtools console would show. Better to say
// so here.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "dist-web", "web");

if (!existsSync(webDir)) {
  console.error(
    "[copy-assets] dist-web/web is missing — the browser client did not compile.\n" +
      "             Run `tsc -p tsconfig.renderer.json` (i.e. `npm run build`).",
  );
  process.exit(1);
}

const modules = readdirSync(webDir).filter((f) => f.endsWith(".js"));
if (modules.length === 0) {
  console.error("[copy-assets] dist-web/web holds no compiled modules — the client did not compile.");
  process.exit(1);
}

console.log(`[copy-assets] dist-web/web ok — ${modules.length} client modules`);
