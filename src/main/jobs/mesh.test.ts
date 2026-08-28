import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMeshData, detectStlKind, parseMesh } from "./mesh";
import {
  binaryHeaderStartingWithSolid,
  buildCubeTriangles,
  buildTetrahedronTriangles,
  trianglesToAsciiStl,
  trianglesToBinaryStl,
} from "./testFixtures";

async function withTempFile(name: string, content: Buffer | string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "slicely-mesh-test-"));
  const path = join(dir, name);
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectStlKind: exact size match with triangle count is binary, even with a 'solid' prefix", () => {
  const n = 12;
  const header = binaryHeaderStartingWithSolid(n);
  assert.equal(header.subarray(0, 6).toString("ascii"), "solid ");
  const exactSize = 84 + 50 * n;
  assert.equal(detectStlKind(header, exactSize), "binary");
});

test("detectStlKind: size mismatch falls back to ascii", () => {
  const n = 12;
  const header = binaryHeaderStartingWithSolid(n);
  // One byte off from the binary-size formula — can't be this many binary triangles.
  assert.equal(detectStlKind(header, 84 + 50 * n + 1), "ascii");
});

test("detectStlKind: short header (can't even hold the triangle count) is ascii", () => {
  assert.equal(detectStlKind(Buffer.alloc(10), 10), "ascii");
});

test("cube volume equals side^3 within epsilon (computeMeshData, no file I/O)", () => {
  const side = 10;
  const mesh = computeMeshData(buildCubeTriangles(side));
  assert.ok(Math.abs(mesh.volumeMm3 - side ** 3) < 1e-6, `volume ${mesh.volumeMm3} != ${side ** 3}`);
  assert.ok(Math.abs(mesh.surfaceAreaMm2 - 6 * side ** 2) < 1e-6);
  assert.ok(Math.abs(mesh.centreOfMass.x - side / 2) < 1e-6);
  assert.ok(Math.abs(mesh.centreOfMass.y - side / 2) < 1e-6);
  assert.ok(Math.abs(mesh.centreOfMass.z - side / 2) < 1e-6);
  // A cube has exactly 6 large flat faces, each side^2 in area.
  assert.equal(mesh.largeFlatFaces.length, 6);
  for (const f of mesh.largeFlatFaces) {
    assert.ok(Math.abs(f.areaMm2 - side ** 2) < 1e-6);
  }
});

test("tetrahedron volume equals s^3/6", () => {
  const s = 6;
  const mesh = computeMeshData(buildTetrahedronTriangles(s));
  assert.ok(Math.abs(mesh.volumeMm3 - s ** 3 / 6) < 1e-6);
});

test("binary STL round-trip: triangle count, bbox, and volume survive a write+parse cycle", async () => {
  const side = 10;
  const triangles = buildCubeTriangles(side);
  const buf = trianglesToBinaryStl(triangles);
  await withTempFile("cube.stl", buf, async (path) => {
    const mesh = await parseMesh(path);
    assert.equal(mesh.triangles.length, 12);
    assert.ok(Math.abs(mesh.volumeMm3 - side ** 3) < 1e-4);
    assert.ok(Math.abs(mesh.boundingBox.max.x - side) < 1e-4);
    assert.ok(Math.abs(mesh.boundingBox.min.x - 0) < 1e-4);
  });
});

test("ASCII STL round-trip: triangle count, bbox, and volume survive a write+parse cycle", async () => {
  const side = 10;
  const triangles = buildCubeTriangles(side);
  const text = trianglesToAsciiStl(triangles);
  await withTempFile("cube.stl", text, async (path) => {
    const mesh = await parseMesh(path);
    assert.equal(mesh.triangles.length, 12);
    assert.ok(Math.abs(mesh.volumeMm3 - side ** 3) < 1e-4);
    assert.ok(Math.abs(mesh.boundingBox.max.z - side) < 1e-4);
  });
});

test("binary STL that begins with the ASCII text 'solid ' still parses as binary (real file, not just the header helper)", async () => {
  const side = 3;
  const triangles = buildCubeTriangles(side);
  const buf = trianglesToBinaryStl(triangles);
  buf.write("solid ", 0, "ascii"); // overwrite the header text, count/geometry untouched
  await withTempFile("tricky.stl", buf, async (path) => {
    const mesh = await parseMesh(path);
    assert.equal(mesh.triangles.length, 12);
    assert.ok(Math.abs(mesh.volumeMm3 - side ** 3) < 1e-4);
  });
});

test("volume sign is corrected when triangle winding is globally inverted", () => {
  // Flip every triangle's winding (swap b/c) so the stored/derived normals
  // all point INWARD; computeMeshData must still report a positive volume.
  const side = 4;
  const inward = buildCubeTriangles(side).map((t) => ({
    a: t.a, b: t.c, c: t.b,
    normal: { x: -t.normal.x, y: -t.normal.y, z: -t.normal.z },
  }));
  const mesh = computeMeshData(inward);
  assert.ok(Math.abs(mesh.volumeMm3 - side ** 3) < 1e-6);
  // And normals should have been flipped back to outward: the +Z-ish face
  // cluster should have a normal whose z component is positive.
  const upFacing = mesh.largeFlatFaces.find((f) => f.normal.z > 0.9);
  assert.ok(upFacing, "expected an upward-facing large flat face after normal correction");
});
