// Tiny synthetic meshes + STL encoders used ONLY by this directory's tests.
// Not a *.test.ts itself (so `node --test` never tries to run it), but kept
// beside the tests it feeds rather than inlined repeatedly in each of them.
//
// Every shape below has hand-verified outward-pointing winding (checked via
// the right-hand rule on paper before being encoded here) — see the comment
// on each builder for the derivation, since a flipped winding would make
// volume/overhang assertions silently wrong rather than fail loudly.

import type { Triangle } from "./mesh";
import { type Vec3, add, cross, eulerToMatrix, matVec, sub } from "./vec3";

function tri(a: Vec3, b: Vec3, c: Vec3): Triangle {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 1;
  return { a, b, c, normal: { x: n.x / len, y: n.y / len, z: n.z / len } };
}

/** Axis-aligned cube, corner at the origin, side `s`. Volume = s^3. */
export function buildCubeTriangles(s: number): Triangle[] {
  const v = (x: number, y: number, z: number): Vec3 => ({ x: x * s, y: y * s, z: z * s });
  const v000 = v(0, 0, 0), v100 = v(1, 0, 0), v110 = v(1, 1, 0), v010 = v(0, 1, 0);
  const v001 = v(0, 0, 1), v101 = v(1, 0, 1), v111 = v(1, 1, 1), v011 = v(0, 1, 1);
  return [
    // bottom z=0, normal -z
    tri(v000, v010, v110), tri(v000, v110, v100),
    // top z=s, normal +z
    tri(v001, v101, v111), tri(v001, v111, v011),
    // front y=0, normal -y
    tri(v000, v100, v101), tri(v000, v101, v001),
    // back y=s, normal +y
    tri(v010, v011, v111), tri(v010, v111, v110),
    // left x=0, normal -x
    tri(v000, v001, v011), tri(v000, v011, v010),
    // right x=s, normal +x
    tri(v100, v110, v111), tri(v100, v111, v101),
  ];
}

/** Axis-aligned rectangular box, corner at the origin, extents sx/sy/sz.
 *  Same winding pattern as buildCubeTriangles (a cube is just sx=sy=sz). */
export function buildBoxTriangles(sx: number, sy: number, sz: number): Triangle[] {
  const v = (x: number, y: number, z: number): Vec3 => ({ x: x * sx, y: y * sy, z: z * sz });
  const v000 = v(0, 0, 0), v100 = v(1, 0, 0), v110 = v(1, 1, 0), v010 = v(0, 1, 0);
  const v001 = v(0, 0, 1), v101 = v(1, 0, 1), v111 = v(1, 1, 1), v011 = v(0, 1, 1);
  return [
    tri(v000, v010, v110), tri(v000, v110, v100),
    tri(v001, v101, v111), tri(v001, v111, v011),
    tri(v000, v100, v101), tri(v000, v101, v001),
    tri(v010, v011, v111), tri(v010, v111, v110),
    tri(v000, v001, v011), tri(v000, v011, v010),
    tri(v100, v110, v111), tri(v100, v111, v101),
  ];
}

/** Right-angle tetrahedron: legs of length `s` along +X/+Y/+Z from the
 *  origin. Volume = s^3 / 6. */
export function buildTetrahedronTriangles(s: number): Triangle[] {
  const o: Vec3 = { x: 0, y: 0, z: 0 };
  const x: Vec3 = { x: s, y: 0, z: 0 };
  const y: Vec3 = { x: 0, y: s, z: 0 };
  const z: Vec3 = { x: 0, y: 0, z: s };
  return [
    tri(x, y, z), // hypotenuse face, outward ~(1,1,1)
    tri(o, y, x), // z=0 base, outward -z
    tri(o, z, y), // x=0 face, outward -x
    tri(o, x, z), // y=0 face, outward -y
  ];
}

/**
 * A flat L-shaped bracket: an L footprint (bounding box 40x30mm, 10mm-wide
 * arms) extruded upward by `thickness` mm. Footprint area is exactly 600
 * mm^2 (40*10 + 10*30 - 10*10 overlap), so volume = 600 * thickness and the
 * top/bottom faces (600 mm^2 each) are unambiguously the largest flat
 * regions in the mesh — every side wall is a thin strip of at most 200 mm^2
 * (the longest edge, 40mm, times `thickness`).
 *
 * Footprint vertices are wound CCW (verified by shoelace: signed area
 * +600), which is the convention every triangle below assumes.
 */
export function buildLBracketTriangles(thickness: number): Triangle[] {
  const pts: Array<[number, number]> = [
    [0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30],
  ];
  const bottom = (i: number): Vec3 => ({ x: pts[i][0], y: pts[i][1], z: 0 });
  const top = (i: number): Vec3 => ({ x: pts[i][0], y: pts[i][1], z: thickness });

  const triangles: Triangle[] = [];
  // Bottom (z=0, normal -z): fan from point 0, reversed winding relative to top.
  for (let i = 1; i < pts.length - 1; i++) {
    triangles.push(tri(bottom(0), bottom(i + 1), bottom(i)));
  }
  // Top (z=thickness, normal +z): fan from point 0, CCW order preserved.
  for (let i = 1; i < pts.length - 1; i++) {
    triangles.push(tri(top(0), top(i), top(i + 1)));
  }
  // Side walls: for each CCW footprint edge Pi->Pi+1, the quad
  // (bottom_i, bottom_i+1, top_i+1, top_i) has outward-pointing normal
  // (verified against the cube's front face above, which is the same
  // pattern applied to one edge of a CCW square).
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = bottom(i), b = bottom(j), c = top(j), d = top(i);
    triangles.push(tri(a, b, c));
    triangles.push(tri(a, c, d));
  }
  return triangles;
}

/** Apply a rotation (degrees, X then Y then Z) to every vertex AND normal of
 *  a triangle list — used to present a fixture "as imported" in some
 *  arbitrary, non-axis-aligned pose so an orientation test can't pass by
 *  accident via one of the 6 axis-aligned candidates alone. */
export function rotateTriangles(triangles: Triangle[], rxDeg: number, ryDeg: number, rzDeg: number): Triangle[] {
  const m = eulerToMatrix(rxDeg, ryDeg, rzDeg);
  return triangles.map((t) => ({
    a: matVec(m, t.a),
    b: matVec(m, t.b),
    c: matVec(m, t.c),
    normal: matVec(m, t.normal),
  }));
}

export function translateTriangles(triangles: Triangle[], offset: Vec3): Triangle[] {
  return triangles.map((t) => ({
    a: add(t.a, offset),
    b: add(t.b, offset),
    c: add(t.c, offset),
    normal: t.normal,
  }));
}

/** Signed tetrahedron-sum volume, exposed for tests that want to sanity
 *  check a fixture independent of mesh.ts's own computeMeshData. */
export function referenceVolume(triangles: Triangle[]): number {
  let acc = 0;
  for (const t of triangles) {
    const cr = cross(t.b, t.c);
    acc += t.a.x * cr.x + t.a.y * cr.y + t.a.z * cr.z;
  }
  return acc / 6;
}

// ── STL encoders ─────────────────────────────────────────────────────────

export function trianglesToBinaryStl(triangles: Triangle[]): Buffer {
  const buf = Buffer.alloc(84 + 50 * triangles.length);
  buf.write("Slicely test fixture", 0, "ascii");
  buf.writeUInt32LE(triangles.length, 80);
  let o = 84;
  for (const t of triangles) {
    buf.writeFloatLE(t.normal.x, o); buf.writeFloatLE(t.normal.y, o + 4); buf.writeFloatLE(t.normal.z, o + 8);
    buf.writeFloatLE(t.a.x, o + 12); buf.writeFloatLE(t.a.y, o + 16); buf.writeFloatLE(t.a.z, o + 20);
    buf.writeFloatLE(t.b.x, o + 24); buf.writeFloatLE(t.b.y, o + 28); buf.writeFloatLE(t.b.z, o + 32);
    buf.writeFloatLE(t.c.x, o + 36); buf.writeFloatLE(t.c.y, o + 40); buf.writeFloatLE(t.c.z, o + 44);
    buf.writeUInt16LE(0, o + 48);
    o += 50;
  }
  return buf;
}

export function trianglesToAsciiStl(triangles: Triangle[]): string {
  const lines: string[] = ["solid fixture"];
  for (const t of triangles) {
    lines.push(`facet normal ${t.normal.x} ${t.normal.y} ${t.normal.z}`);
    lines.push("outer loop");
    for (const v of [t.a, t.b, t.c]) lines.push(`vertex ${v.x} ${v.y} ${v.z}`);
    lines.push("endloop");
    lines.push("endfacet");
  }
  lines.push("endsolid fixture");
  return lines.join("\n") + "\n";
}

/** An ASCII-content STL whose bytes happen to start with "solid " AND whose
 *  size satisfies the binary-STL formula for the given triangle count —
 *  i.e. a file that would fool prefix-sniffing but must still be detected
 *  as binary by the size invariant. Used only to build the raw header bytes
 *  for detectStlKind unit tests; not a well-formed binary STL beyond byte 5. */
export function binaryHeaderStartingWithSolid(triangleCount: number): Buffer {
  const header = Buffer.alloc(84);
  header.write("solid ", 0, "ascii"); // deliberately binary-STL-hostile prefix
  header.writeUInt32LE(triangleCount, 80);
  return header;
}

