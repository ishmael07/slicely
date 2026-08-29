// ─────────────────────────────────────────────────────────────────────────────
// A small, drawable version of a mesh, for showing the user what they are
// about to print.
//
// A real model is far too heavy to send to a browser: the Pikachu in testing is
// 386,000 triangles, which is ~14 MB of raw floats before any encoding. So this
// decimates by VERTEX CLUSTERING — snap every vertex to a coarse grid, then
// drop the triangles that collapse — which is the classic cheap decimation and
// happens to look good here: the result is faceted rather than smoothed, which
// reads as a deliberate low-poly style instead of a broken model.
//
// Geometry is normalised into a unit box centred on the origin so the viewer
// never has to know the model's real scale to frame it.
// ─────────────────────────────────────────────────────────────────────────────
import type { Triangle } from "./mesh";

/** Compact, transport-friendly mesh: shared vertices plus triangle indices. */
export interface PreviewMesh {
  /** Flat [x,y,z, x,y,z, …], normalised so the model fits a unit box. */
  positions: number[];
  /** Flat triangle indices into `positions`. */
  indices: number[];
  /** The model's real size in mm, so the viewer can label it. */
  sizeMm: { x: number; y: number; z: number };
  /** Triangles before and after decimation, for an honest "simplified" note. */
  sourceTriangles: number;
  triangles: number;
}

/** Target triangle count. High enough to read as the real object, low enough
 *  to send over the wire and redraw every frame without a GPU. */
const DEFAULT_TARGET = 4000;

/**
 * Build a drawable, normalised mesh.
 *
 * `target` is approximate: vertex clustering cannot hit an exact count, since
 * how many triangles survive depends on the shape. Overshooting slightly is
 * better than iterating to an exact number nobody can perceive.
 */
function decimateAt(triangles: Triangle[], cellsPerAxis: number): PreviewMesh {
  if (triangles.length === 0) {
    return {
      positions: [],
      indices: [],
      sizeMm: { x: 0, y: 0, z: 0 },
      sourceTriangles: 0,
      triangles: 0,
    };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }

  const sizeMm = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const extent = Math.max(sizeMm.x, sizeMm.y, sizeMm.z) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  const cell = extent / cellsPerAxis;

  const vertexIndex = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];

  /** Snap to the grid, normalise into a unit box, and share vertices. */
  const idFor = (x: number, y: number, z: number): number => {
    const gx = Math.round((x - cx) / cell);
    const gy = Math.round((y - cy) / cell);
    const gz = Math.round((z - cz) / cell);
    const key = `${gx},${gy},${gz}`;
    const hit = vertexIndex.get(key);
    if (hit !== undefined) return hit;
    const id = positions.length / 3;
    vertexIndex.set(key, id);
    // Grid centre, then scaled so the longest axis spans 1.
    positions.push((gx * cell) / extent, (gy * cell) / extent, (gz * cell) / extent);
    return id;
  };

  for (const t of triangles) {
    const a = idFor(t.a.x, t.a.y, t.a.z);
    const b = idFor(t.b.x, t.b.y, t.b.z);
    const c = idFor(t.c.x, t.c.y, t.c.z);
    // Collapsed by the snap: two or more corners landed in the same cell, so
    // the triangle has no area left and would only cost the viewer time.
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }

  return {
    // Two decimals is well under a pixel at any sane preview size, and roughly
    // halves the payload.
    positions: positions.map((v) => Math.round(v * 1000) / 1000),
    indices,
    sizeMm: {
      x: Math.round(sizeMm.x * 10) / 10,
      y: Math.round(sizeMm.y * 10) / 10,
      z: Math.round(sizeMm.z * 10) / 10,
    },
    sourceTriangles: triangles.length,
    triangles: indices.length / 3,
  };
}

/**
 * Decimate to roughly `target` triangles.
 *
 * How many triangles survive a given grid depends on the shape, not just the
 * grid, so a single formula misses badly — a first attempt sized by sqrt(target)
 * returned 17,936 triangles for a target of 4,000, and a 408 KB payload with
 * it. Rather than guess harder, measure and adjust: surface count scales with
 * about the square of the resolution, which converges in two or three tries.
 */
export function buildPreviewMesh(
  triangles: Triangle[],
  target = DEFAULT_TARGET,
): PreviewMesh {
  if (triangles.length === 0) return decimateAt(triangles, 8);
  // Already small enough to send whole.
  if (triangles.length <= target) return decimateAt(triangles, 160);

  let cells = Math.max(8, Math.min(160, Math.round(Math.sqrt(target) / 2)));
  let best = decimateAt(triangles, cells);

  for (let attempt = 0; attempt < 3; attempt++) {
    const ratio = best.triangles / target;
    // Close enough that another pass would only cost time.
    if (ratio >= 0.6 && ratio <= 1.4) break;
    const next = Math.max(6, Math.min(160, Math.round(cells / Math.sqrt(ratio))));
    if (next === cells) break;
    cells = next;
    best = decimateAt(triangles, cells);
  }
  return best;
}
