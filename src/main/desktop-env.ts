// The two environment values the rest of Slicely reads to decide where it is
// running and where its files live — set here, in a module of its own, so they
// are in place BEFORE anything that reads them is loaded.
//
// This is not ceremony. `import` statements are hoisted: every `require` in
// main.ts runs before main.ts's first line of code, so an assignment at the top
// of main.ts's body would happen AFTER config.ts had already been loaded. It
// happens to be safe today (config.ts caches lazily, mode.ts reads fresh on
// every call), but "safe as long as nobody ever reads config at import time" is
// not an invariant worth betting the workdir on. Importing this module first
// makes the ordering explicit and enforced by the module system.
import { app } from "electron";

/** The Electron app is the desktop mode, always. Not read from the
 *  environment: a stray `SLICELY_MODE=hosted` in a `.env` file must not turn
 *  the Mac app into a shared server. */
process.env.SLICELY_MODE = "desktop";

/** `~/Library/Application Support/Slicely` — the OS-sanctioned home for an
 *  app's data, and where an existing install already keeps its `settings.json`,
 *  `printers.json` and `master.key`. An explicit `SLICELY_WORKDIR` still wins,
 *  which is how a developer points a dev build at a scratch directory. */
if (!process.env.SLICELY_WORKDIR) {
  process.env.SLICELY_WORKDIR = app.getPath("userData");
}
