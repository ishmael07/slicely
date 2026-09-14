// ─────────────────────────────────────────────────────────────────────────────
// What the MODEL is told a file is called.
//
// The previous round closed every path leak on the WIRE: routes/chat.ts runs
// each agent frame through `toClientPaths`, so `ModelInfo.filePath` reaches the
// browser as `relPath: "uploads/cube.stl"`. It could not close the model's own
// prose, because that prose is written from the tool RESULTS — and those still
// said things like "Downloaded "cube.stl" to /data/sessions/ab12/downloads/
// cube.stl". The model read it, repeated it, and the deployment layout and the
// caller's session id went out inside a `text` frame that no field-level scrub
// can rewrite.
//
// So the tool results speak the workspace-relative form too, and this file
// pins two properties of that:
//
//   1. NOTHING a tool returns names a path on this machine. Asserted as a
//      blanket over the whole result string, not field by field — a per-string
//      assertion is how the last one shipped.
//   2. What a tool RETURNS is what a tool ACCEPTS. The model's whole workflow is
//      "download, then plan the thing you just downloaded", so a reference it is
//      handed has to resolve when it passes it back. Driven end to end here:
//      download → plan_job → run_job.
//
// Hermetic: a temp workdir, a temp session, and a five-line shell script
// standing in for PrusaSlicer (the same trick prusaslicer.test.ts uses). No
// network, no real slicer, nothing left behind.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { runInSession, sessionContext, workspaceRef } from "../session-context";
import { buildCubeTriangles, trianglesToBinaryStl } from "../jobs/testFixtures";
import { sessionState } from "./state";
import { executeTool } from "./tools";
import { executeV2Tool } from "./tools-v2";

/** A PrusaSlicer that answers `--info` with plausible geometry and writes a
 *  G-code file carrying the summary comments `parseMetrics` reads. Everything
 *  else it is asked to do, it succeeds at silently. */
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

interface Harness {
  root: string;
  sessionDir: string;
  /** Run `fn` inside the temp session, in hosted mode. */
  inSession: <T>(fn: () => T) => T;
  cleanup: () => void;
}

/** Everything in one place: a temp workdir, a session directory laid out the way
 *  the hosted store lays one out, a cube in `uploads/`, and the fake slicer on
 *  PRUSASLICER_PATH. */
function harness(id = "aaaa"): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slicely-toolpaths-")));
  const sessionDir = join(root, "sessions", id);
  for (const d of ["uploads", "downloads", "slices", "scratch"]) {
    mkdirSync(join(sessionDir, d), { recursive: true });
  }
  writeFileSync(join(sessionDir, "uploads", "cube.stl"), trianglesToBinaryStl(buildCubeTriangles(20)));
  // The encrypted key really does live here; naming it in a test is how the
  // "and it is still unreachable" assertions below stay honest.
  writeFileSync(join(sessionDir, "secrets.json"), '{"key":"nope"}');

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
  process.env.SLICELY_MODE = "hosted";
  // A developer's exported config on this machine must not decide what the
  // tests slice against.
  delete process.env.PRUSASLICER_CONFIG_INI;
  resetConfigForTests();

  return {
    root,
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
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Assert `text` names no path on this machine. The workdir and the session
 *  directory are checked by value as well as by prefix, because a deployment's
 *  root need not start with any of the generic ones. */
function namesNoServerPath(text: string, h: Harness, what: string): void {
  for (const needle of ["/Users", "/tmp", "/private", "/var/folders", h.root, h.sessionDir]) {
    assert.ok(!text.includes(needle), `${what} leaks ${needle}:\n${text}`);
  }
  // Belt and braces: anything that looks like an absolute POSIX path with at
  // least two segments. Catches a root this list has not thought of.
  const looksAbsolute = text.match(/(?:^|[\s"'`(])\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/);
  assert.equal(looksAbsolute, null, `${what} contains an absolute path ${looksAbsolute?.[0]}:\n${text}`);
}

test("workspaceRef speaks the form every tool accepts back, and nothing else", () => {
  const h = harness();
  try {
    h.inSession(() => {
      assert.equal(workspaceRef(join(h.sessionDir, "uploads", "cube.stl")), "uploads/cube.stl");
      assert.equal(workspaceRef(join(h.sessionDir, "downloads", "kit", "part1.stl")), "downloads/kit/part1.stl");
      assert.equal(workspaceRef(join(h.sessionDir, "slices", "plate-1.gcode")), "slices/plate-1.gcode");
      // Not a shape anything is handed out from: the basename, never the path.
      assert.equal(workspaceRef(join(h.sessionDir, "scratch", "upload_abc")), "upload_abc");
      assert.equal(workspaceRef(join(h.sessionDir, "secrets.json")), "secrets.json");
      assert.equal(workspaceRef("/etc/passwd"), "passwd");
    });
  } finally {
    h.cleanup();
  }
});

test("workspaceRef survives a session directory reached through a symlink", async () => {
  // `assertWorkspacePath` hands the tools the REAL path; `session.dir` is
  // whatever SLICELY_WORKDIR said. On macOS those are routinely two spellings of
  // one place (`/var` → `/private/var`), and a single `relative()` between them
  // yields `../../…` — which would have turned every reference into a bare
  // basename, i.e. a name no tool can resolve back.
  const real = realpathSync(mkdtempSync(join(tmpdir(), "slicely-symlinked-")));
  const link = join(real, "link");
  mkdirSync(join(real, "real", "uploads"), { recursive: true });
  symlinkSync(join(real, "real"), link);
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "hosted";
  try {
    // The session is configured through the LINK; the tool holds the REAL path.
    runInSession(sessionContext("aaaa", link), () => {
      assert.equal(workspaceRef(join(real, "real", "uploads", "cube.stl")), "uploads/cube.stl");
      assert.equal(workspaceRef(join(link, "uploads", "cube.stl")), "uploads/cube.stl");
    });
  } finally {
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
    rmSync(real, { recursive: true, force: true });
  }
});

test("desktop: a file of the user's own keeps its path; one of Slicely's never does", async () => {
  // The desktop is the one mode where a file the tools may open has no relative
  // spelling — `~/Desktop/bracket.stl` is outside the session directory, the
  // machine is the reader's own, and a basename would be a name no tool could
  // resolve again. That licence stops at Slicely's own directory: `secrets.json`
  // beside it is the encrypted Anthropic key, and it gets a basename in every
  // mode.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "slicely-ref-home-")));
  const sessionDir = join(home, "Library", "Application Support", "Slicely");
  mkdirSync(join(sessionDir, "uploads"), { recursive: true });
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  try {
    runInSession(sessionContext("__default__", sessionDir), () => {
      assert.equal(workspaceRef(join(home, "Desktop", "bracket.stl")), join(home, "Desktop", "bracket.stl"));
      assert.equal(workspaceRef(join(sessionDir, "uploads", "cube.stl")), "uploads/cube.stl");
      assert.equal(workspaceRef(join(sessionDir, "secrets.json")), "secrets.json");
      assert.equal(workspaceRef(join(sessionDir, "master.key")), "master.key");
    });
  } finally {
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the upload → inspect → recommend → slice results name no path on this machine", async () => {
  const h = harness();
  try {
    await h.inSession(async () => {
      const emit = (): void => {};
      const results: Record<string, string> = {};

      // An uploaded file reaches the agent exactly like this: the route sets
      // the session's active model, and the client's prompt names the relPath.
      sessionState.lastModelPath = join(h.sessionDir, "uploads", "cube.stl");
      sessionState.lastModelParts = [sessionState.lastModelPath];

      results.inspect = await executeTool("inspect_model", { path: "uploads/cube.stl" }, emit);
      results.recommend = await executeTool("recommend_settings", { path: "uploads/cube.stl" }, emit);
      results.slice = await executeTool("slice_model", { path: "uploads/cube.stl", goal: "draft" }, emit);
      results.status = await executeTool("get_slicer_status", {}, emit);

      for (const [name, text] of Object.entries(results)) {
        namesNoServerPath(text, h, `${name}'s tool result`);
      }
      // "No path" must not have been satisfied by saying nothing at all.
      assert.match(results.inspect, /uploads\/cube\.stl/, "inspect_model must still name the file");
      assert.match(results.slice, /Sliced successfully/);
    });
  } finally {
    h.cleanup();
  }
});

test("a reference a tool HANDS OUT is one the next tool ACCEPTS: download → plan_job → run_job", async () => {
  const h = harness();
  try {
    await h.inSession(async () => {
      const emit = (): void => {};

      // What a download leaves behind, and the reference the tool result quotes
      // for it (see tools-v2.ts's import_from_url, which formats exactly this).
      const downloaded = join(h.sessionDir, "downloads", "bracket.stl");
      writeFileSync(downloaded, trianglesToBinaryStl(buildCubeTriangles(20)));
      const relPath = workspaceRef(downloaded);
      assert.equal(relPath, "downloads/bracket.stl");

      // The model now passes that exact string on, with no absolute path ever
      // having been in its context.
      const planned = await executeV2Tool("plan_job", { parts: [{ path: relPath, copies: 1 }] }, emit);
      namesNoServerPath(planned, h, "plan_job's result");
      assert.match(planned, /Planned job/);

      const ran = await executeV2Tool("run_job", {}, emit);
      namesNoServerPath(ran, h, "run_job's result");
      assert.match(ran, /1\/1 plates sliced/);

      // And the G-code the run produced is addressable the same way.
      assert.ok(sessionState.lastGcodePath, "the run must remember a plate's G-code");
      assert.match(workspaceRef(sessionState.lastGcodePath!), /^slices\//);
    });
  } finally {
    h.cleanup();
  }
});

test("a tool refusal names the workspace reference, never the absolute path", async () => {
  const h = harness();
  try {
    await h.inSession(async () => {
      // A STEP file cannot be sliced headlessly, and the message quoted the
      // path it gave up on.
      const step = join(h.sessionDir, "uploads", "flange.step");
      writeFileSync(step, "ISO-10303-21;\n");
      await assert.rejects(
        () => executeTool("slice_model", { path: "uploads/flange.step" }, () => {}),
        (err: unknown) => {
          const msg = (err as Error).message;
          namesNoServerPath(msg, h, "the STEP refusal");
          assert.match(msg, /uploads\/flange\.step/);
          return true;
        },
      );
    });
  } finally {
    h.cleanup();
  }
});
