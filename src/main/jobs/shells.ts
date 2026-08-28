// ─────────────────────────────────────────────────────────────────────────────
// Splitting one mesh into its separate solid pieces ("shells").
//
// A great many models that LOOK like one object are several: a nameplate whose
// letters float above a backing plate, a logo with separate rings, a set of
// parts a designer exported into a single STL. STL has no concept of objects —
// it is a bag of triangles — so all of that arrives as one mesh, and every
// piece prints in one colour.
//
// Separating them turns the hard case (colouring one mesh, which otherwise
// needs painting) into the easy case Slicely already handles well: several
// parts, each assigned to its own filament.
//
// The split is exact rather than heuristic: two triangles belong to the same
// piece when they share a vertex, so pieces come out exactly where the geometry
// is genuinely disconnected.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import type { Triangle, Vec3 } from "./mesh";

/** One connected piece of a mesh. */
export interface Shell {
  triangles: Triangle[];
  /** Bounding box in mm. */
  size: { x: number; y: number; z: number };
  /** Lowest corner, used to keep pieces in their original relative positions. */
  min: Vec3;
  /** Rough volume in mm³, for ordering pieces biggest-first. */
  volumeMm3: number;
}

/** Round a coordinate to 1 µm so float noise doesn't split a welded seam. */
function key(v: Vec3): string {
  return `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;
}

/** Union-find over vertex keys — near-linear, and the mesh can be large. */
class DisjointSet {
  private parent = new Map<string, string>();

  find(a: string): string {
    let root = this.parent.get(a);
    if (root === undefined) {
      this.parent.set(a, a);
      return a;
    }
    // Path compression, iterative so a long chain can't blow the stack.
    const chain: string[] = [a];
    while (root !== chain[chain.length - 1]) {
      chain.push(root);
      root = this.parent.get(root) ?? root;
    }
    for (const node of chain) this.parent.set(node, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Signed volume of the tetrahedron from the origin to a triangle. */
function tetraVolume(t: Triangle): number {
  const { a, b, c } = t;
  return (
    (a.x * (b.y * c.z - b.z * c.y) -
      a.y * (b.x * c.z - b.z * c.x) +
      a.z * (b.x * c.y - b.y * c.x)) /
    6
  );
}

/**
 * Split a mesh into its disconnected pieces, largest first.
 *
 * A single connected mesh returns one shell, so callers can always use the
 * result without special-casing.
 */
export function splitShells(triangles: Triangle[]): Shell[] {
  if (triangles.length === 0) return [];

  const set = new DisjointSet();
  for (const t of triangles) {
    const ka = key(t.a);
    const kb = key(t.b);
    const kc = key(t.c);
    set.union(ka, kb);
    set.union(kb, kc);
  }

  const groups = new Map<string, Triangle[]>();
  for (const t of triangles) {
    const root = set.find(key(t.a));
    const list = groups.get(root);
    if (list) list.push(t);
    else groups.set(root, [t]);
  }

  const shells: Shell[] = [];
  for (const group of groups.values()) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let volume = 0;
    for (const t of group) {
      for (const v of [t.a, t.b, t.c]) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
      }
      volume += tetraVolume(t);
    }
    shells.push({
      triangles: group,
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      min: { x: minX, y: minY, z: minZ },
      volumeMm3: Math.abs(volume),
    });
  }

  // Biggest first: the main body is what a user names, and the offcuts follow.
  return shells.sort((a, b) => b.volumeMm3 - a.volumeMm3);
}

/**
 * Discard pieces too small to be real parts.
 *
 * A mesh with a few stray triangles (a modelling artifact, a loose facet) would
 * otherwise "split" into dozens of specks and bury the pieces that matter.
 * Anything under `minFraction` of the largest piece's volume is dropped.
 */
export function significantShells(shells: Shell[], minFraction = 0.001): Shell[] {
  if (shells.length === 0) return [];
  const largest = shells[0].volumeMm3;
  if (largest <= 0) return shells;
  return shells.filter((s) => s.volumeMm3 / largest >= minFraction);
}

/** Face normal, recomputed rather than trusted — STL normals are often wrong. */
function normalOf(t: Triangle): Vec3 {
  const ux = t.b.x - t.a.x, uy = t.b.y - t.a.y, uz = t.b.z - t.a.z;
  const vx = t.c.x - t.a.x, vy = t.c.y - t.a.y, vz = t.c.z - t.a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Write a shell out as a binary STL, so it can flow through the normal
 * import → orient → pack → colour pipeline as an ordinary part.
 *
 * Positions are preserved: the pieces of a split model are only meaningful
 * relative to each other, and re-centring each one would scatter them.
 */
export function writeShellStl(destPath: string, shell: Shell): string {
  const count = shell.triangles.length;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write("Slicely split shell", 0, 79, "ascii");
  buf.writeUInt32LE(count, 80);

  shell.triangles.forEach((t, i) => {
    const o = 84 + i * 50;
    const n = normalOf(t);
    buf.writeFloatLE(n.x, o);
    buf.writeFloatLE(n.y, o + 4);
    buf.writeFloatLE(n.z, o + 8);
    const vs = [t.a, t.b, t.c];
    vs.forEach((v, k) => {
      buf.writeFloatLE(v.x, o + 12 + k * 12);
      buf.writeFloatLE(v.y, o + 16 + k * 12);
      buf.writeFloatLE(v.z, o + 20 + k * 12);
    });
    buf.writeUInt16LE(0, o + 48);
  });

  writeFileSync(destPath, buf);
  return destPath;
}
