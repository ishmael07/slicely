import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMeshData, detectStlKind, parse3mfObjects, parseMesh } from "./mesh";
import {
  binaryHeaderStartingWithSolid,
  buildCubeTriangles,
  buildTetrahedronTriangles,
  trianglesToAsciiStl,
  trianglesToBinaryStl,
  writeThreeMfFixture,
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

// ── 3MF objects, kept apart ────────────────────────────────────────────────
// parseMesh merges a 3MF into one triangle soup, which is right for measuring
// a model but destroys the thing that makes a multi-colour download
// multi-colour: its objects. Each one carries its own extruder assignment, so
// they have to survive as separate parts, positioned where the file put them.

/** A 3MF holding two unit tetrahedra, each placed by its build item. */
function twoObjectModel(transforms: [string, string]): string {
  const mesh =
    `<mesh><vertices>` +
    `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>` +
    `<vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>` +
    `</vertices><triangles>` +
    `<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>` +
    `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
    `</triangles></mesh>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>` +
    `<object id="10" type="model">${mesh}</object>` +
    `<object id="20" type="model">${mesh}</object>` +
    `</resources><build>` +
    `<item objectid="10" transform="${transforms[0]}"/>` +
    `<item objectid="20" transform="${transforms[1]}"/>` +
    `</build></model>`
  );
}

test("parse3mfObjects keeps each object separate, in document order", async () => {
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model": twoObjectModel([
      "1 0 0 0 1 0 0 0 1 0 0 0",
      "1 0 0 0 1 0 0 0 1 0 0 0",
    ]),
  });
  try {
    const objects = await parse3mfObjects(fixture.path);
    assert.equal(objects.length, 2, "two objects must not be merged into one");
    assert.deepEqual(objects.map((o: { objectId: string }) => o.objectId), ["10", "20"]);
    assert.equal(objects[0].triangles.length, 4);
  } finally {
    fixture.cleanup();
  }
});

test("build-item transforms are applied, so an assembly is laid out and not stacked", async () => {
  // Without this, a 3MF assembled from several positioned parts comes back
  // with every part overlapping at the origin — which looks like one object
  // and slices like a collision.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model": twoObjectModel([
      "1 0 0 0 1 0 0 0 1 0 0 0",
      "1 0 0 0 1 0 0 0 1 50 20 0", // translated 50mm in X, 20mm in Y
    ]),
  });
  try {
    const objects = await parse3mfObjects(fixture.path);
    const second = objects[1].triangles.flatMap((t) => [t.a, t.b, t.c] as const);
    assert.ok(
      second.every((v) => v.x >= 50 && v.y >= 20),
      "the second object must sit where its build item put it",
    );
    const first = objects[0].triangles.flatMap((t) => [t.a, t.b, t.c]);
    assert.ok(first.some((v) => v.x === 0 && v.y === 0), "the first object stays at the origin");
  } finally {
    fixture.cleanup();
  }
});

test("a rotating transform rotates the geometry, not just its position", async () => {
  // 90 degrees about Z: (1,0,0) -> (0,1,0). Row-major 4x3, translation last.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model": twoObjectModel([
      "0 1 0 -1 0 0 0 0 1 0 0 0",
      "1 0 0 0 1 0 0 0 1 0 0 0",
    ]),
  });
  try {
    const objects = await parse3mfObjects(fixture.path);
    const verts = objects[0].triangles.flatMap((t) => [t.a, t.b, t.c]);
    assert.ok(
      verts.some((v) => Math.abs(v.x) < 1e-9 && Math.abs(v.y - 1) < 1e-9),
      "the vertex at (1,0,0) must have rotated to (0,1,0)",
    );
  } finally {
    fixture.cleanup();
  }
});

test("parseMesh still returns ONE merged mesh, so measuring a model is unchanged", async () => {
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model": twoObjectModel([
      "1 0 0 0 1 0 0 0 1 0 0 0",
      "1 0 0 0 1 0 0 0 1 50 20 0",
    ]),
  });
  try {
    const mesh = await parseMesh(fixture.path);
    assert.equal(mesh.triangles.length, 8, "both objects, merged, as before");
  } finally {
    fixture.cleanup();
  }
});

// ── The production extension ───────────────────────────────────────────────
// Bambu Studio (and so every MakerWorld download) writes its geometry into
// SEPARATE part files: 3D/3dmodel.model holds objects made of <component>
// references into 3D/Objects/object_N.model, and the build item scales and
// places the wrapper. A parser that reads only 3dmodel.model finds no
// triangles at all in the exact files multi-colour models come from.

/** A 3MF in Bambu's layout: a wrapper object referencing an external mesh. */
function productionModel(componentTransform: string, itemTransform: string) {
  return writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ` +
      `xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">` +
      `<resources><object id="2" type="model"><components>` +
      `<component p:path="/3D/Objects/object_1.model" objectid="1" transform="${componentTransform}"/>` +
      `</components></object></resources>` +
      `<build><item objectid="2" transform="${itemTransform}"/></build></model>`,
    "3D/_rels/3dmodel.model.rels":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Target="/3D/Objects/object_1.model" Id="rel-1" ` +
      `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    "3D/Objects/object_1.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model"><mesh><vertices>` +
      `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>` +
      `<vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>` +
      `</vertices><triangles>` +
      `<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>` +
      `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
      `</triangles></mesh></object></resources></model>`,
  });
}

const IDENTITY = "1 0 0 0 1 0 0 0 1 0 0 0";

test("geometry in a separate part file is found, not reported as an empty model", async () => {
  const fixture = productionModel(IDENTITY, IDENTITY);
  try {
    const objects = await parse3mfObjects(fixture.path);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].triangles.length, 4, "the component's mesh must be resolved");
    assert.equal(
      objects[0].objectId,
      "2",
      "the id must be the one the colour metadata uses — the root object's",
    );
  } finally {
    fixture.cleanup();
  }
});

test("the component's transform and the build item's are BOTH applied", async () => {
  // Bambu puts the model's scale on the build item. Applying only one of the
  // two transforms gives a part of the wrong size in the wrong place, which
  // then fails to pack or silently prints at the wrong scale.
  const fixture = productionModel(
    "1 0 0 0 1 0 0 0 1 0 0 5", // component: lift 5mm
    "2 0 0 0 2 0 0 0 2 10 0 0", // item: double, then shift 10mm in X
  );
  try {
    const objects = await parse3mfObjects(fixture.path);
    const verts = objects[0].triangles.flatMap((t) => [t.a, t.b, t.c]);
    // (0,0,0) -> component +5z -> (0,0,5) -> item x2 (0,0,10) -> +10x (10,0,10)
    assert.ok(
      verts.some((v) => Math.abs(v.x - 10) < 1e-6 && Math.abs(v.z - 10) < 1e-6),
      `both transforms must compose; got ${JSON.stringify(verts.slice(0, 4))}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("parseMesh reads a production-extension 3MF instead of throwing", async () => {
  const fixture = productionModel(IDENTITY, IDENTITY);
  try {
    const mesh = await parseMesh(fixture.path);
    assert.equal(mesh.triangles.length, 4);
  } finally {
    fixture.cleanup();
  }
});

test("a component cycle terminates instead of hanging", async () => {
  // A malformed or hostile file must not be able to spin the parser forever.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources>` +
      `<object id="1" type="model"><components><component objectid="2"/></components></object>` +
      `<object id="2" type="model"><components><component objectid="1"/></components></object>` +
      `</resources><build><item objectid="1"/></build></model>`,
  });
  try {
    await assert.rejects(() => parse3mfObjects(fixture.path), /no mesh triangles/);
  } finally {
    fixture.cleanup();
  }
});
