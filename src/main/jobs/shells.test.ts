// Tests for splitting one mesh into its separate solid pieces.
//
// This is what lets a single downloaded file get several colours: the pieces
// become ordinary parts, and each part already gets its own filament.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitShells, significantShells, writeShellStl } from "./shells";
import { parseMesh } from "./mesh";
import { buildCubeTriangles, translateTriangles } from "./testFixtures";

test("a single connected solid comes back as one shell", () => {
  const shells = splitShells(buildCubeTriangles(10));
  assert.equal(shells.length, 1);
  assert.equal(shells[0].triangles.length, 12);
});

test("two separated solids in one mesh split into two shells", () => {
  // The case that matters: one file, two objects, far enough apart to share no
  // vertices — exactly how a nameplate's letters sit above its backing plate.
  const mesh = [
    ...buildCubeTriangles(10),
    ...translateTriangles(buildCubeTriangles(10), { x: 50, y: 0, z: 0 }),
  ];
  const shells = splitShells(mesh);
  assert.equal(shells.length, 2);
  for (const s of shells) assert.equal(s.triangles.length, 12);
});

test("touching solids are ONE shell, because they print as one piece", () => {
  // Sharing vertices means the geometry is genuinely joined; splitting there
  // would hand the slicer two objects that overlap.
  const mesh = [
    ...buildCubeTriangles(10),
    ...translateTriangles(buildCubeTriangles(10), { x: 10, y: 0, z: 0 }),
  ];
  assert.equal(splitShells(mesh).length, 1);
});

test("shells come back largest first", () => {
  const mesh = [
    ...buildCubeTriangles(4),
    ...translateTriangles(buildCubeTriangles(20), { x: 100, y: 0, z: 0 }),
  ];
  const shells = splitShells(mesh);
  assert.equal(shells.length, 2);
  assert.ok(
    shells[0].volumeMm3 > shells[1].volumeMm3,
    "the main body should lead, with offcuts after it",
  );
  assert.equal(Math.round(shells[0].size.x), 20);
});

test("stray fragments are ignored rather than reported as parts", () => {
  const mesh = [
    ...buildCubeTriangles(40),
    // A speck a thousandth the size — a modelling artifact, not a part.
    ...translateTriangles(buildCubeTriangles(0.5), { x: 200, y: 0, z: 0 }),
  ];
  const all = splitShells(mesh);
  assert.equal(all.length, 2, "both are real connected components");
  assert.equal(
    significantShells(all).length,
    1,
    "but only one is a part worth printing",
  );
});

test("an empty mesh yields no shells rather than throwing", () => {
  assert.deepEqual(splitShells([]), []);
  assert.deepEqual(significantShells([]), []);
});

test("a written shell round-trips as a real STL with its position kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-shell-"));
  try {
    const offset = { x: 50, y: 20, z: 0 };
    const shells = splitShells(translateTriangles(buildCubeTriangles(10), offset));
    const dest = join(dir, "piece.stl");
    writeShellStl(dest, shells[0]);

    // 84-byte header + 50 bytes per triangle is the binary STL layout.
    assert.equal(statSync(dest).size, 84 + 12 * 50);

    const reparsed = await parseMesh(dest);
    assert.equal(reparsed.triangles.length, 12);
    const back = splitShells(reparsed.triangles)[0];
    // Position must survive: split pieces are only meaningful relative to
    // each other, so re-centring them would scatter the model.
    assert.ok(Math.abs(back.min.x - offset.x) < 0.01, `x moved: ${back.min.x}`);
    assert.ok(Math.abs(back.min.y - offset.y) < 0.01, `y moved: ${back.min.y}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
