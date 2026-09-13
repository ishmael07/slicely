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
