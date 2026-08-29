// Regression tests for plate packing and orientation, from a real failing run:
// three laptop-stand parts that should share one plate but were split across
// two, with one part stood on end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packPlates, type PlatePart } from "../plates";

/** The real job: two stand halves plus a long thin connector bar. */
const STAND: PlatePart[] = [
  { path: "/stand-conect.stl", w: 254.6, d: 99 },
  { path: "/conect.stl", w: 24, d: 269.3 },
  { path: "/stand-drill.stl", w: 254.6, d: 99 },
];

test("parts that fit one bed are packed onto one plate", () => {
  // Shelf packing forced full-width rows, wasted a row on the 269mm bar, and
  // split this across two plates. They fit side by side.
  const { plates, oversized } = packPlates(STAND, { w: 325, d: 320 }, 6);
  assert.equal(oversized.length, 0);
  assert.equal(plates.length, 1, "these three fit one 325x320 bed");
  assert.equal(plates[0].parts.length, 3);
});

test("every placed part gets a position, and none overlaps another", () => {
  const { plates } = packPlates(STAND, { w: 325, d: 320 }, 6);
  const parts = plates[0].parts;
  for (const p of parts) {
    assert.ok(p.x !== undefined && p.y !== undefined, `${p.path} has no position`);
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      const apart =
        a.x! + a.w <= b.x! || b.x! + b.w <= a.x! || a.y! + a.d <= b.y! || b.y! + b.d <= a.y!;
      assert.ok(apart, `${a.path} overlaps ${b.path}`);
    }
  }
});

test("nothing is placed flush against the bed edge", () => {
  // PrusaSlicer draws the skirt and brim OUTSIDE the objects. Packing flush to
  // (0,0) pushed the real toolpath to X-7 Y-7 — off the bed.
  const { plates } = packPlates(STAND, { w: 325, d: 320 }, 6);
  for (const p of plates[0].parts) {
    assert.ok(p.x! >= 5, `${p.path} sits at x=${p.x}, too close to the edge`);
    assert.ok(p.y! >= 5, `${p.path} sits at y=${p.y}, too close to the edge`);
    assert.ok(p.x! + p.w <= 320, `${p.path} runs past the usable width`);
    assert.ok(p.y! + p.d <= 315, `${p.path} runs past the usable depth`);
  }
});

test("parts too big for the bed are reported, not placed", () => {
  const { plates, oversized } = packPlates(STAND, { w: 220, d: 220 }, 6);
  // On an Ender 3 all three exceed the bed in their given orientation.
  assert.equal(oversized.length, 3);
  assert.equal(plates.length, 0);
});

test("a job needing more room than one bed splits across plates", () => {
  const many: PlatePart[] = Array.from({ length: 6 }, (_, i) => ({
    path: `/big${i}.stl`,
    w: 150,
    d: 150,
  }));
  const { plates, oversized } = packPlates(many, { w: 325, d: 320 }, 6);
  assert.equal(oversized.length, 0);
  assert.ok(plates.length >= 2, "six 150mm squares cannot share one 325x320 bed");
  const placed = plates.reduce((n, p) => n + p.parts.length, 0);
  assert.equal(placed, 6, "every part must land on some plate");
});

test("packing never loses a part", () => {
  const mixed: PlatePart[] = [
    { path: "/a.stl", w: 200, d: 40 },
    { path: "/b.stl", w: 40, d: 200 },
    { path: "/c.stl", w: 90, d: 90 },
    { path: "/d.stl", w: 120, d: 60 },
    { path: "/e.stl", w: 60, d: 120 },
  ];
  const { plates, oversized } = packPlates(mixed, { w: 250, d: 210 }, 6);
  const placed = plates.reduce((n, p) => n + p.parts.length, 0);
  assert.equal(placed + oversized.length, mixed.length);
});

test("a part fits a space its own size — spacing is not demanded up front", () => {
  // Spacing is a gap BETWEEN parts, taken from the remainder when a rectangle
  // is split. Requiring part+spacing to fit rejected a 198.6mm part from a
  // 200mm space for a gap no neighbour was going to use, and reported a
  // scaled-down part as unplaceable.
  const usable: PlatePart[] = [{ path: "/tight.stl", w: 198.6, d: 77.2 }];
  const { plates, oversized } = packPlates(usable, { w: 220, d: 220 }, 6);
  assert.equal(oversized.length, 0);
  assert.equal(plates.length, 1, "198.6mm fits the 200mm usable width");
});

test("two parts on one plate still keep a gap between them", () => {
  const pair: PlatePart[] = [
    { path: "/a.stl", w: 90, d: 90 },
    { path: "/b.stl", w: 90, d: 90 },
  ];
  const { plates } = packPlates(pair, { w: 250, d: 210 }, 6);
  assert.equal(plates.length, 1);
  const [a, b] = plates[0].parts;
  const gapX = Math.max(a.x! - (b.x! + b.w), b.x! - (a.x! + a.w));
  const gapY = Math.max(a.y! - (b.y! + b.d), b.y! - (a.y! + a.d));
  assert.ok(
    Math.max(gapX, gapY) >= 5,
    `parts should be separated by roughly the spacing, got ${Math.max(gapX, gapY)}`,
  );
});
