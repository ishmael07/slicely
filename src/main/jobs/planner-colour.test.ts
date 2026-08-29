// Regression tests for three bugs found by dogfooding real multi-part jobs.
//
// All three came from the same mistake in different places: treating a FILE
// PATH as a part's identity. The same STL requested in two colours is two
// different parts, and collapsing them silently lost a colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planColours } from "./colour";
import { tinyPartsNote } from "./planner";
import type { JobPart } from "../../shared/jobs";
import type { FilamentSlot } from "../../shared/printers";

function part(path: string, colourHex?: string): JobPart {
  return { path, name: path.split("/").pop() ?? path, copies: 1, sizeX: 20, sizeY: 20, sizeZ: 20, colourHex };
}

const slot = (index: number, colourHex: string): FilamentSlot => ({
  index,
  colourHex,
  material: "PLA",
  loaded: true,
});

test("the same STL requested in two colours keeps BOTH colours", () => {
  const parts = [part("/m/cube.stl", "#c81e1e"), part("/m/cube.stl", "#1e6fc8")];
  const plan = planColours(parts, [slot(0, "#c81e1e"), slot(1, "#1e6fc8")]);

  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.assignments[0].colourHex, "#c81e1e");
  assert.equal(plan.assignments[1].colourHex, "#1e6fc8");
  assert.notEqual(
    plan.assignments[0].extruder,
    plan.assignments[1].extruder,
    "same file, different colours must resolve to different extruders",
  );
});

test("an exactly-loaded colour is matched, not approximated", () => {
  const plan = planColours(
    [part("/m/a.stl", "#c81e1e")],
    [slot(0, "#c81e1e"), slot(1, "#ffffff")],
  );
  assert.equal(plan.assignments[0].reason, "matched-slot");
  assert.equal(plan.assignments[0].colourHex, "#c81e1e");
});

test("substituting an unloaded colour warns, naming both colours", () => {
  const plan = planColours(
    [part("/m/a.stl", "#f0c040")],
    [slot(0, "#c81e1e"), slot(1, "#ffffff")],
  );
  assert.equal(plan.assignments[0].reason, "nearest-colour");
  assert.equal(
    plan.warnings.length,
    1,
    "a silent colour substitution is a bug: the user cannot fix what they aren't told",
  );
  assert.match(plan.warnings[0], /#f0c040/, "must name the colour that was asked for");
  assert.match(plan.warnings[0], /#ffffff/, "must name the colour they will actually get");
});

test("repeated substitutions of one colour produce a single warning", () => {
  const plan = planColours(
    [part("/m/a.stl", "#f0c040"), part("/m/b.stl", "#f0c040"), part("/m/c.stl", "#f0c040")],
    [slot(0, "#c81e1e"), slot(1, "#ffffff")],
  );
  assert.equal(plan.warnings.length, 1, "one swap, one warning — not one per part");
});

test("a single loaded slot reports preview-only colour", () => {
  const plan = planColours([part("/m/a.stl", "#00b3a4")], [slot(0, "#c81e1e")]);
  assert.equal(plan.singleExtruder, true);
  assert.ok(plan.warnings.some((w) => /preview-only/i.test(w)));
});

test("an implausibly small part is flagged as a likely units error", () => {
  // A 2mm part is what a centimetre-authored file looks like imported as mm.
  const note = tinyPartsNote([
    { path: "/m/speck.stl", name: "speck.stl", copies: 1, sizeX: 2, sizeY: 2, sizeZ: 1.4 },
  ]);
  assert.ok(note, "a 2mm part must be flagged");
  assert.match(note!, /units/, "must say the units are the likely cause");
  assert.match(note!, /speck\.stl/, "must name the offending file");
});

test("normal-sized parts produce no units warning", () => {
  assert.equal(
    tinyPartsNote([
      { path: "/m/a.stl", name: "a.stl", copies: 1, sizeX: 40, sizeY: 30, sizeZ: 12 },
      { path: "/m/b.stl", name: "b.stl", copies: 1, sizeX: 6, sizeY: 6, sizeZ: 6 },
    ]),
    undefined,
  );
});

// ── Colour-splitting across plates ──────────────────────────────────────────
// Two opposite needs, and the right default depends on the printer:
//   • "put the black parts on one plate and the blue on another" → one colour
//     per plate, so a single-extruder user swaps spools BETWEEN plates.
//   • "I have an AMS, print them together" → colours share a plate, because
//     the printer changes filament itself mid-print.
// The default must follow the hardware, but an explicit request always wins.

import { shouldGroupByColour } from "./planner";

test("with 2+ loaded slots, colours share a plate by default", () => {
  assert.equal(
    shouldGroupByColour({ distinctColours: 2, usableSlots: 4, explicit: undefined }),
    false,
    "an AMS exists precisely so several colours can print on one plate",
  );
});

test("with one slot, each colour gets its own plate by default", () => {
  assert.equal(
    shouldGroupByColour({ distinctColours: 2, usableSlots: 1, explicit: undefined }),
    true,
    "a single-extruder user swaps spools between plates, so plates must be single-colour",
  );
});

test("an explicit request to split by colour wins, even with an AMS", () => {
  assert.equal(
    shouldGroupByColour({ distinctColours: 3, usableSlots: 4, explicit: true }),
    true,
  );
});

test("an explicit request to combine wins, even on a single extruder", () => {
  assert.equal(
    shouldGroupByColour({ distinctColours: 3, usableSlots: 1, explicit: false }),
    false,
  );
});

test("a single-colour job is never split, whatever the setting", () => {
  assert.equal(shouldGroupByColour({ distinctColours: 1, usableSlots: 1, explicit: true }), false);
  assert.equal(shouldGroupByColour({ distinctColours: 1, usableSlots: 4, explicit: undefined }), false);
});

// ── Planning progress ───────────────────────────────────────────────────────
// Planning a detailed multi-part job takes many seconds. Without progress the
// UI shows a spinner that never changes, which is indistinguishable from a
// hang — which is exactly how it was reported.

test("planning reports each stage, and each part as it is worked on", async () => {
  const { planJob } = await import("./index");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildCubeTriangles, trianglesToBinaryStl } = await import("./testFixtures");
  const dir = mkdtempSync(join(tmpdir(), "slicely-progress-"));
  const paths = ["a.stl", "b.stl"].map((n) => {
    const p = join(dir, n);
    writeFileSync(p, trianglesToBinaryStl(buildCubeTriangles(10)));
    return p;
  });

  const seen: string[] = [];
  try {
    await planJob(
      paths.map((p) => ({ path: p, copies: 1 })),
      {
        bed: { x: 220, y: 220, z: 250 },
        maxHeightMm: 250,
        goal: "quality",
        autoOrient: true,
        onProgress: (p) =>
          seen.push(`${p.stage}${p.partName ? `:${p.partName}` : ""}${p.index ? `:${p.index}/${p.total}` : ""}`),
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(seen.some((s) => s.startsWith("inspecting")), "must report inspecting");
  // One per part, numbered, so the user can see it advance.
  assert.ok(seen.includes("orienting:a.stl:1/2"), `missing part 1: ${seen.join(", ")}`);
  assert.ok(seen.includes("orienting:b.stl:2/2"), `missing part 2: ${seen.join(", ")}`);
  assert.ok(seen.some((s) => s.startsWith("colouring")));
  assert.ok(seen.some((s) => s.startsWith("packing")));
  // Stages arrive in the order the work happens.
  const orderOf = (prefix: string): number => seen.findIndex((s) => s.startsWith(prefix));
  assert.ok(orderOf("inspecting") < orderOf("orienting"));
  assert.ok(orderOf("orienting") < orderOf("colouring"));
  assert.ok(orderOf("colouring") < orderOf("packing"));
});
