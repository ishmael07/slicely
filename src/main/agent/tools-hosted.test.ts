// ─────────────────────────────────────────────────────────────────────────────
// What "open it" means when Slicely is a website.
//
// Reported from production: a browser visitor asked to slice a model and then
// open it. `open_in_slicer` ran, and the model was handed DESKTOP prose —
// "Opened plate 1 … in PrusaSlicer", "press Slice to generate the toolpaths",
// "run PrusaSlicer's first-time setup once" — so it told a web user three times
// that PrusaSlicer was now open on their screen. Nothing had opened on their
// screen; the slicer runs on the server, under xvfb, where a launched GUI is a
// process nobody can see and nobody ever closes.
//
// So in hosted mode these two tools prepare the file and say so. These tests
// pin BOTH halves — the words the model reads, and the GUI launch that must not
// happen — because either one alone regresses silently: honest prose with a
// stray xvfb window leaks processes, and a skipped launch with the old prose is
// the shipped bug.
//
// Hermetic: temp workdir, temp session, a five-line shell script standing in for
// PrusaSlicer (the same trick tool-paths.test.ts uses), and the GUI openers
// replaced by spies so nothing is ever spawned, in either mode.
// ─────────────────────────────────────────────────────────────────────────────
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/types";
import { resetConfigForTests } from "../config";
import { runInSession, sessionContext } from "../session-context";
import { buildCubeTriangles, trianglesToBinaryStl } from "../jobs/testFixtures";
import { sessionState } from "./state";
import { executeTool } from "./tools";
// `import … = require(…)` rather than a namespace import: TS's namespace wrapper
// is getter-based and `t.mock.method` cannot replace a getter. See
// sourcing/net.test.ts, which learned this the same way.
import prusaslicer = require("../prusaslicer");

/** A PrusaSlicer that answers `--info` with plausible geometry and writes a
 *  G-code file carrying the summary comments `parseMetrics` reads. */
const FAKE_SLICER = `#!/bin/sh
out=""
info=0
prev=""
for a in "$@"; do
  [ "$a" = "--info" ] && info=1
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
if [ "$info" = "1" ]; then
  echo "size_x = 20.000000"
  echo "size_y = 20.000000"
  echo "size_z = 20.000000"
  echo "volume = 8000.000000"
  echo "number_of_facets = 12"
  echo "manifold = yes"
  echo "number_of_parts = 1"
  exit 0
fi
if [ -n "$out" ]; then
  {
    echo "; fake slicer"
    echo ";LAYER_CHANGE"
    echo "; estimated printing time (normal mode) = 12m"
    echo "; total filament used [g] = 4.2"
    echo "; total filament cost = 0.11"
  } > "$out"
fi
exit 0
`;

/** Wording that only means something on the reader's own machine. Every one of
 *  these was in a string the model was handed for a browser user. */
const DESKTOP_WORDING = [/Opened/, /press Slice/i, /first-time setup/i, /Finder/i];

interface Harness {
  sessionDir: string;
  inSession: <T>(fn: () => T) => T;
  cleanup: () => void;
}

function harness(mode: "hosted" | "desktop", id = "aaaa"): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slicely-hosted-open-")));
  const sessionDir = join(root, "sessions", id);
  for (const d of ["uploads", "downloads", "slices", "scratch"]) {
    mkdirSync(join(sessionDir, d), { recursive: true });
  }
  writeFileSync(join(sessionDir, "uploads", "cube.stl"), trianglesToBinaryStl(buildCubeTriangles(20)));

  const fake = join(root, "fake-prusaslicer");
  writeFileSync(fake, FAKE_SLICER);
  chmodSync(fake, 0o755);

  const prev = {
    workdir: process.env.SLICELY_WORKDIR,
    bin: process.env.PRUSASLICER_PATH,
    mode: process.env.SLICELY_MODE,
    configIni: process.env.PRUSASLICER_CONFIG_INI,
  };
  process.env.SLICELY_WORKDIR = root;
  process.env.PRUSASLICER_PATH = fake;
  process.env.SLICELY_MODE = mode;
  delete process.env.PRUSASLICER_CONFIG_INI;
  resetConfigForTests();

  return {
    sessionDir,
    inSession: (fn) => runInSession(sessionContext(id, sessionDir), fn),
    cleanup: () => {
      for (const [k, v] of [
        ["SLICELY_WORKDIR", prev.workdir],
        ["PRUSASLICER_PATH", prev.bin],
        ["SLICELY_MODE", prev.mode],
        ["PRUSASLICER_CONFIG_INI", prev.configIni],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetConfigForTests();
      sessionState.lastModelPath = "";
      sessionState.lastModelParts = [];
      sessionState.lastGcodePath = undefined;
      sessionState.lastJobId = undefined;
      sessionState.lastSliceParams = undefined;
      sessionState.lastConfigIni = undefined;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Replace both GUI launchers with counters. Nothing is spawned in either mode,
 *  so the test suite never leaves a slicer window (or an xvfb server) behind. */
function spyOnGuiLaunchers(t: TestContext): { editor: () => number; viewer: () => number } {
  const editor = t.mock.method(prusaslicer, "openModelInEditorSliced", async () => ({
    preSliced: true,
    alreadyOpen: false,
    noConfig: false,
  }));
  const viewer = t.mock.method(prusaslicer, "openGcodeInGui", async () => {});
  return { editor: () => editor.mock.callCount(), viewer: () => viewer.mock.callCount() };
}

test("hosted: open_in_slicer prepares a .3mf to download and launches no GUI", async (t) => {
  const gui = spyOnGuiLaunchers(t);
  const h = harness("hosted");
  try {
    await h.inSession(async () => {
      sessionState.lastModelPath = join(h.sessionDir, "uploads", "cube.stl");
      sessionState.lastModelParts = [sessionState.lastModelPath];
      const events: AgentEvent[] = [];
      const out = await executeTool("open_in_slicer", { path: "uploads/cube.stl" }, (e) => events.push(e));

      assert.equal(gui.editor(), 0, "nothing may be launched on a server nobody is sitting at");
      for (const re of DESKTOP_WORDING) {
        assert.ok(!re.test(out), `hosted open_in_slicer still says ${re}:\n${out}`);
      }
      // "No desktop wording" must not have been satisfied by saying nothing
      // useful: the action button is the whole outcome, so the prose has to
      // point at it.
      assert.match(out, /\.3mf/, "it must say what was prepared");
      assert.match(out, /Download/, "it must point at the button the user actually has");

      const action = events.find((e) => e.type === "action");
      assert.ok(action && action.type === "action", "the client needs the button");
      assert.equal(action.kind, "open-project");
      assert.ok(action.filePath, "the route turns filePath into the session's download URL");
      assert.ok(!out.includes(h.sessionDir), "and the model is never told a server path");
    });
  } finally {
    h.cleanup();
  }
});

test("hosted: slice_and_open slices here and offers the G-code, with no viewer to open", async (t) => {
  const gui = spyOnGuiLaunchers(t);
  const h = harness("hosted", "bbbb");
  try {
    await h.inSession(async () => {
      const out = await executeTool("slice_and_open", { path: "uploads/cube.stl", goal: "draft" }, () => {});
      assert.equal(gui.viewer(), 0, "the G-code viewer cannot be shown to a browser");
      for (const re of DESKTOP_WORDING) {
        assert.ok(!re.test(out), `hosted slice_and_open still says ${re}:\n${out}`);
      }
      assert.match(out, /Sliced/, "the slice itself still happened and is still reported");
      assert.match(out, /Download/, "and the G-code is offered as a download");
    });
  } finally {
    h.cleanup();
  }
});

test("desktop: open_in_slicer still opens the editor, and still says it did", async (t) => {
  const gui = spyOnGuiLaunchers(t);
  const h = harness("desktop", "cccc");
  try {
    await h.inSession(async () => {
      sessionState.lastModelPath = join(h.sessionDir, "uploads", "cube.stl");
      sessionState.lastModelParts = [sessionState.lastModelPath];
      const out = await executeTool("open_in_slicer", { path: "uploads/cube.stl" }, () => {});
      assert.equal(gui.editor(), 1, "on the user's own Mac the window is the point");
      assert.match(out, /Opened/, "and the desktop reply is unchanged");
    });
  } finally {
    h.cleanup();
  }
});
