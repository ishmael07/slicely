// The settings shared by a headless slice and the GUI the user actually looks
// at. Hermetic: pure argument construction, no PrusaSlicer, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "./config";
import {
  getModelInfo,
  settingArgs,
  setSliceTimeoutForTests,
  slice,
  sliceSemaphore,
  withSliceProgress,
  withSliceQueueLimit,
  REST_SLICE_QUEUE_MS,
} from "./prusaslicer";

test("a requested colour is part of the shared settings, not the slice-only args", () => {
  // This is the whole bug: writeEffectiveConfig builds the GUI's config from
  // settingArgs ALONE. While the colour lived further down, beside the
  // slice-only transforms, asking for a black print sliced black G-code and
  // opened PrusaSlicer showing the default teal.
  const args = settingArgs({ filamentColour: "#000000" });

  assert.ok(args.includes("--filament-colour"), "the spool swatch");
  assert.ok(args.includes("--extruder-colour"), "what the plater paints the object with");
  assert.equal(args[args.indexOf("--filament-colour") + 1], "#000000");
  assert.equal(args[args.indexOf("--extruder-colour") + 1], "#000000");
});

test("a colour is normalised, and nonsense is dropped rather than passed on", () => {
  const short = settingArgs({ filamentColour: "0f0" });
  assert.equal(short[short.indexOf("--filament-colour") + 1], "#00ff00");

  // PrusaSlicer rejects an unparseable colour outright, taking the whole slice
  // down with it — so a bad value must never reach the CLI.
  assert.deepEqual(settingArgs({ filamentColour: "black" }), []);
  assert.deepEqual(settingArgs({}), []);
});

// ── per-slice timeout ────────────────────────────────────────────────────────
// A slice that never finishes used to be a process that never died: run()'s
// timer killed the child, but the failure then fell into the auto-remediation
// loop and came back as a generic "Slicing failed", with no way for a caller to
// tell "your model is broken" from "we gave up waiting". Hermetic: PRUSASLICER_PATH
// points at a shell script that sleeps, so no real slicer is involved.

test("a slice that outruns the per-slice timeout is killed and surfaces as slice_timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-slicetimeout-"));
  const fakeSlicer = join(dir, "fake-prusaslicer");
  writeFileSync(fakeSlicer, "#!/bin/sh\nsleep 5\n");
  chmodSync(fakeSlicer, 0o755);
  const stlPath = join(dir, "part.stl");
  writeFileSync(stlPath, "solid x\nendsolid x\n");

  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.PRUSASLICER_PATH = fakeSlicer;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  setSliceTimeoutForTests(200);

  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => slice(stlPath),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "slice_timeout");
        assert.equal((err as { status?: number }).status, 504);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1000, `gave up after ${elapsed}ms — the retry loop must not re-run a timeout`);
  } finally {
    setSliceTimeoutForTests();
    if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
    else process.env.PRUSASLICER_PATH = prevBin;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slice that has to queue says so on the progress channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-queue-"));
  const fakeSlicer = join(dir, "fake-prusaslicer");
  writeFileSync(fakeSlicer, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeSlicer, 0o755);
  const stlPath = join(dir, "part.stl");
  writeFileSync(stlPath, "solid x\nendsolid x\n");

  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.PRUSASLICER_PATH = fakeSlicer;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();

  // Take every permit, so the next caller can only queue.
  const held: Array<() => void> = [];
  for (let i = 0; i < sliceSemaphore.size; i++) held.push(await sliceSemaphore.acquire());

  const labels: string[] = [];
  try {
    const pending = withSliceProgress(
      (label) => labels.push(label),
      () => getModelInfo(stlPath).catch(() => null),
    );
    // A silent wait is indistinguishable from a hang, which is the whole point
    // of the label — and the count is how many runs finish before ours starts.
    assert.deepEqual(labels, ["Waiting for a free slicer (1 ahead)…"]);
    assert.equal(sliceSemaphore.waiting, 1);

    held.forEach((release) => release());
    await pending;
    assert.equal(sliceSemaphore.waiting, 0);
  } finally {
    held.forEach((release) => release());
    if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
    else process.env.PRUSASLICER_PATH = prevBin;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the queue has a ceiling for HTTP callers ─────────────────────────────────
// The desktop app should wait for a free slicer; a web request should not. The
// browser and any proxy in front of it time out on their own, and the visitor is
// left holding a dead connection while the server still dutifully slices.

test("a REST slice that can't get a permit in time is told the slicer is busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-busy-"));
  const fakeSlicer = join(dir, "fake-prusaslicer");
  writeFileSync(fakeSlicer, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeSlicer, 0o755);
  const stlPath = join(dir, "part.stl");
  writeFileSync(stlPath, "solid x\nendsolid x\n");

  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.PRUSASLICER_PATH = fakeSlicer;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();

  // Every permit taken: the next caller can only queue.
  const held: Array<() => void> = [];
  for (let i = 0; i < sliceSemaphore.size; i++) held.push(await sliceSemaphore.acquire());

  try {
    await assert.rejects(
      () => withSliceQueueLimit(40, () => slice(stlPath)),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        assert.equal(e.status, 503, "a queue we gave up on is 'come back', not 'your model is bad'");
        assert.equal(e.code, "slicer_busy");
        assert.doesNotMatch(String(e.message), /\//, "no paths in a busy message");
        return true;
      },
    );
    assert.equal(sliceSemaphore.waiting, 0, "the abandoned wait must not linger in the queue");

    // The permits are intact: releasing them lets a normal slice through, which
    // is the regression a lost permit would cause (a server that reports busy
    // forever, with nothing running).
    held.forEach((release) => release());
    held.length = 0;
    const info = await getModelInfo(stlPath).catch(() => null);
    assert.ok(info === null || typeof info === "object");
  } finally {
    held.forEach((release) => release());
    if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
    else process.env.PRUSASLICER_PATH = prevBin;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the desktop path is unbounded: no queue limit means wait, not 503", async () => {
  const sem = sliceSemaphore;
  const held: Array<() => void> = [];
  for (let i = 0; i < sem.size; i++) held.push(await sem.acquire());
  try {
    // Outside withSliceQueueLimit there is no budget, so this stays queued
    // rather than being refused — the agent's spinner is the right UX there.
    let settled = false;
    const queued = sem.acquire().then((rel) => {
      settled = true;
      rel();
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(settled, false, "an unbounded wait must keep waiting");
    held.forEach((release) => release());
    held.length = 0;
    await queued;
  } finally {
    held.forEach((release) => release());
  }
});

test("the REST queue budget is a sane, documented number", () => {
  assert.ok(
    REST_SLICE_QUEUE_MS >= 10_000 && REST_SLICE_QUEUE_MS <= 60_000,
    "long enough to outlast a slice ahead of it, short enough to beat a proxy",
  );
});

// ── finished output beats the clock ──────────────────────────────────────────

test("a slice whose G-code landed just as the clock ran out is a success, not a timeout", async () => {
  // The kill and the final write race: PrusaSlicer can close a complete .gcode
  // and still be SIGKILLed before `close` fires. Checking `timedOut` first threw
  // slice_timeout away on a slice whose output was sitting on disk, finished —
  // the user re-ran a ten-minute slice for a file they already had.
  //
  // This used to run the fake slicer's writes against a 400 ms timeout — fine
  // on an idle machine, but under a full `npm test` run (many workers competing
  // for the CPU) the shell script isn't always scheduled in time to finish its
  // three printfs before the abort fires, and the assertion below fails on the
  // resulting slice_timeout instead of parsed metrics. The fix isn't a bigger
  // number for its own sake: it's a 10x wider real-time margin between "the
  // script got scheduled and wrote its output" and "the kill fired", so the
  // same contention that caused the flake has ten times the room to hide in.
  const dir = mkdtempSync(join(tmpdir(), "slicely-raced-"));
  const fakeSlicer = join(dir, "fake-prusaslicer");
  // Writes a plausible G-code summary to --output, THEN hangs past the timeout.
  writeFileSync(
    fakeSlicer,
    [
      "#!/bin/sh",
      'out=""',
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--output" ]; then out="$2"; fi',
      "  shift",
      "done",
      'printf "; estimated printing time (normal mode) = 1h 2m 3s\n" > "$out"',
      'printf "; filament used [mm] = 1000\n" >> "$out"',
      'printf ";LAYER_CHANGE\n" >> "$out"',
      "sleep 10",
      "",
    ].join("\n"),
  );
  chmodSync(fakeSlicer, 0o755);
  const stlPath = join(dir, "part.stl");
  writeFileSync(stlPath, "solid x\nendsolid x\n");

  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.PRUSASLICER_PATH = fakeSlicer;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  setSliceTimeoutForTests(4000);

  try {
    const metrics = await slice(stlPath);
    assert.equal(metrics.estimatedPrintTime, "1h 2m 3s", "the finished output is parsed and returned");
    assert.equal(metrics.filamentUsedMm, 1000);
  } finally {
    setSliceTimeoutForTests();
    if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
    else process.env.PRUSASLICER_PATH = prevBin;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── a failed slice is a coded refusal, with no server paths in it ────────────

test("a slice that fails surfaces as 422 slice_failed with the slicer's reason, paths stripped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-failed-"));
  const fakeSlicer = join(dir, "fake-prusaslicer");
  // Fails the way PrusaSlicer does: a reason on stderr, quoting the input path,
  // and no G-code written.
  writeFileSync(
    fakeSlicer,
    [
      "#!/bin/sh",
      'echo "Invalid value for --layer-height while processing /Users/someone/sessions/abc/uploads/part.stl" 1>&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeSlicer, 0o755);
  const stlPath = join(dir, "part.stl");
  writeFileSync(stlPath, "solid x\nendsolid x\n");

  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.PRUSASLICER_PATH = fakeSlicer;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();

  try {
    await assert.rejects(
      () => slice(stlPath),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        assert.equal(e.status, 422, "the model is the problem, so not a 500");
        assert.equal(e.code, "slice_failed");
        const msg = String(e.message);
        assert.match(msg, /layer-height/, "the actionable reason survives");
        assert.doesNotMatch(msg, /\/Users\/someone/, "the absolute path does not");
        assert.doesNotMatch(msg, /uploads/, "nor the directory layout around it");
        return true;
      },
    );
  } finally {
    if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
    else process.env.PRUSASLICER_PATH = prevBin;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing model file is a coded 404 that does not name the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-missing-"));
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  try {
    const gone = join(dir, "sessions", "abc", "uploads", "gone.stl");
    await assert.rejects(
      () => slice(gone),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        // 404 only if a slicer is installed to get that far; either way the
        // message must never quote the path.
        assert.doesNotMatch(String(e.message), /gone\.stl/);
        return true;
      },
    );
  } finally {
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
