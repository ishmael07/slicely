// Tests for the drawable mesh sent to the 3D viewer.
//
// A real model is far too heavy to ship to a browser (386k triangles is ~14MB
// of raw floats), so this must reliably get a model down to something a canvas
// can redraw every frame — without mangling its proportions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewMesh } from "./preview";
import { buildCubeTriangles, buildBoxTriangles, translateTriangles } from "./testFixtures";

test("an already-small mesh survives with its shape intact", () => {
  const p = buildPreviewMesh(buildCubeTriangles(20), 4000);
  assert.ok(p.triangles > 0);
  assert.deepEqual(p.sizeMm, { x: 20, y: 20, z: 20 }, "real dimensions are reported in mm");
  assert.equal(p.indices.length, p.triangles * 3);
});

test("geometry is normalised into a unit box, so the viewer needs no scale", () => {
  // A large, off-origin model must arrive framed the same as a small one.
  const far = translateTriangles(buildCubeTriangles(200), { x: 900, y: -400, z: 50 });
  const p = buildPreviewMesh(far, 4000);
  const max = Math.max(...p.positions.map(Math.abs));
  assert.ok(max <= 0.75, `expected a unit box, got extent ${max}`);
  assert.deepEqual(p.sizeMm, { x: 200, y: 200, z: 200 });
});

test("proportions survive normalisation", () => {
  // A long flat bar must not come back looking like a cube.
  const p = buildPreviewMesh(buildBoxTriangles(80, 20, 5), 4000);
  assert.deepEqual(p.sizeMm, { x: 80, y: 20, z: 5 });
  const xs = p.positions.filter((_, i) => i % 3 === 0);
  const ys = p.positions.filter((_, i) => i % 3 === 1);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  assert.ok(spanX > spanY * 2.5, `aspect lost: x ${spanX} vs y ${spanY}`);
});

test("a dense mesh is decimated toward the target rather than sent whole", () => {
  // Many small cubes spread out: lots of triangles, plenty to collapse.
  const dense = [];
  for (let i = 0; i < 400; i++) {
    dense.push(...translateTriangles(buildCubeTriangles(2), { x: (i % 20) * 3, y: Math.floor(i / 20) * 3, z: 0 }));
  }
  const target = 500;
  const p = buildPreviewMesh(dense, target);
  assert.ok(p.sourceTriangles === dense.length);
  assert.ok(
    p.triangles < p.sourceTriangles,
    `expected decimation, got ${p.triangles} of ${p.sourceTriangles}`,
  );
  // The adaptive search should land near the target, not wildly past it —
  // a fixed formula previously overshot 4,000 by more than 4x.
  assert.ok(p.triangles <= target * 3, `overshot badly: ${p.triangles} for target ${target}`);
});

test("vertices are shared, not repeated per triangle", () => {
  const p = buildPreviewMesh(buildCubeTriangles(10), 4000);
  const vertexCount = p.positions.length / 3;
  assert.ok(
    vertexCount < p.triangles * 3,
    "indices exist so vertices can be shared; repeating them triples the payload",
  );
});

test("an empty mesh returns an empty preview rather than throwing", () => {
  const p = buildPreviewMesh([], 4000);
  assert.equal(p.triangles, 0);
  assert.deepEqual(p.positions, []);
});
