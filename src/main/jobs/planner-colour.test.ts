// Regression tests for three bugs found by dogfooding real multi-part jobs.
//
// All three came from the same mistake in different places: treating a FILE
// PATH as a part's identity. The same STL requested in two colours is two
// different parts, and collapsing them silently lost a colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planColours } from "./colour";
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
