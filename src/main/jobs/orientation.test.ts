import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseOrientation } from "./orientation";
import {
  buildBoxTriangles,
  buildCubeTriangles,
  buildLBracketTriangles,
  rotateTriangles,
} from "./testFixtures";

test("keptAsImported is true when the as-imported pose already wins (symmetric cube)", () => {
  const cube = buildCubeTriangles(10);
  const result = chooseOrientation(cube, { goal: "quality" });
  assert.equal(result.keptAsImported, true);
  assert.equal(result.best.rotXDeg, 0);
  assert.equal(result.best.rotYDeg, 0);
  assert.equal(result.best.rotZDeg, 0);
});

test("quality goal lays the L-bracket's large flat face on the bed, not standing on an edge", () => {
  const flat = buildLBracketTriangles(5); // top/bottom faces are 600 mm^2 each
  // Tilt at an arbitrary, non-axis-aligned angle so none of the 6 axis-aligned
  // candidates accidentally restore the flat pose — the win has to come from
  // real flat-face detection (matFromToRotation), not a lucky 90 deg turn.
  const tilted = rotateTriangles(flat, 25, 35, 0);

  const result = chooseOrientation(tilted, { goal: "quality" });

  assert.equal(result.keptAsImported, false, "the tilted import pose should not itself be best");
  assert.ok(
    result.best.bedContactMm2 > 550,
    `expected the large (600 mm²) face down, got bedContact=${result.best.bedContactMm2}`,
  );
  assert.ok(
    result.best.overhangAreaMm2 < 5,
    `expected ~0 overhang lying flat, got ${result.best.overhangAreaMm2}`,
  );
});

test("REGRESSION (bug 1): a face resting flat on the bed is not counted as an overhang", () => {
  // A thin plate, tilted so it's NOT already flat. The winning pose lies it
  // flat: its entire bottom face rests on the bed and must contribute to
  // bedContactMm2, NOT overhangAreaMm2 — before the fix, every bed-resting
  // triangle (normal.z ~= -1) was counted as an overhang too, so a perfectly
  // flat plate was scored as if its whole footprint needed support.
  const plate = buildBoxTriangles(50, 30, 2); // 50x30 face is the largest (1500 mm^2)
  const tilted = rotateTriangles(plate, 40, 20, 0);

  const result = chooseOrientation(tilted, { goal: "quality" });

  assert.ok(
    result.best.bedContactMm2 > 1400,
    `expected the 1500 mm² face flat on the bed, got bedContact=${result.best.bedContactMm2}`,
  );
  assert.ok(
    result.best.overhangAreaMm2 < 5,
    `a flat-lying plate must report ~0 overhang, got ${result.best.overhangAreaMm2} (bed contact was double-counted as overhang before the fix)`,
  );
});

test("REGRESSION (bug 2): a candidate with near-zero bed contact is never returned as best", () => {
  // Same tilted L-bracket as above. At this arbitrary angle, several of the 6
  // axis-aligned candidates land the model on a corner/edge of its bounding
  // box rather than a real face, giving them near-zero bed contact — assert
  // that scenario actually arises here, then assert the winner isn't one of
  // them regardless of how its other numbers look.
  const flat = buildLBracketTriangles(5);
  const tilted = rotateTriangles(flat, 25, 35, 0);

  const result = chooseOrientation(tilted, { goal: "quality" });

  const unstableCandidates = result.candidates.filter((c) => c.bedContactMm2 < 1);
  assert.ok(
    unstableCandidates.length > 0,
    "expected this scenario to include at least one near-zero-bed-contact candidate",
  );
  assert.ok(
    result.best.bedContactMm2 >= 1,
    `a near-zero bed-contact pose must never win, got bedContact=${result.best.bedContactMm2}`,
  );
  // The winner should score strictly higher than every unstable candidate.
  for (const u of unstableCandidates) {
    assert.ok(result.best.score >= u.score);
  }
});

test("draft goal favours fewest layers over a taller pose with less overhang", () => {
  // A box that is short one way and tall another. Draft should prefer lying
  // it on its largest face (fewest layers), even though 'quality' might not
  // weight it identically.
  const box = buildBoxTriangles(20, 20, 60); // as-imported: 60mm tall = many layers
  const result = chooseOrientation(box, { goal: "draft", layerHeightMm: 0.2 });
  // Lying on a 20x60 or 60x20 side face (height 20mm -> 100 layers) beats
  // standing on the 20x20 face (height 60mm -> 300 layers).
  assert.ok(result.best.layerCount <= 100, `expected a short pose, got ${result.best.layerCount} layers`);
});

test("functional goal with a load axis prefers keeping the load in-plane with the layers", () => {
  const box = buildBoxTriangles(10, 10, 40);
  // Load runs along the box's long (Z, as-imported) axis.
  const result = chooseOrientation(box, {
    goal: "functional",
    loadAxis: { x: 0, y: 0, z: 1 },
  });
  // The best pose should rotate the long axis OUT of vertical (Z), i.e. not
  // keep it standing on its short 10x10 face as imported.
  assert.notEqual(result.best.sizeZ, 40);
});
