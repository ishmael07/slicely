// ─────────────────────────────────────────────────────────────────────────────
// Building the project file that "open in PrusaSlicer" hands over.
//
// Why a project instead of the source STLs plus `--load config.ini`:
// PrusaSlicer defaults to `single_instance = 1`. When the app is ALREADY open,
// launching the binary again does not start a second instance — macOS hands the
// file paths to the running one and the new process exits. Everything else on
// that command line, `--load` included, is discarded silently. The model
// appears, the settings do not, and the user sees a plate that ignored the
// printer, the layer height and the colour they asked for.
//
// A project file survives that handoff, because the settings are inside the
// file rather than beside it. It also carries placement, so two parts don't
// land stacked on the origin the way loose STLs do.
// ─────────────────────────────────────────────────────────────────────────────
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { parseMesh } from "./mesh";
import { writeThreeMf, type ThreeMfPart } from "./threemf";
import { packPlates, type PlatePart } from "../plates";
import type { Triangle } from "./mesh";
import type { Vec3 } from "./vec3";

/** Where a part's footprint sits, and how big it is. */
interface Placed {
  triangles: Triangle[];
  /** Bed position of the footprint's centre, in mm. */
  centre: { x: number; y: number };
}

export interface EditorProjectInput {
  /** Model files to place, in the order the user thinks of them. */
  paths: string[];
  /** Usable bed, mm. */
  bed: { x: number; y: number; z: number };
  /** The effective settings, as a PrusaSlicer .ini path. Embedded verbatim. */
  configIni?: string;
  /** Destination .3mf. */
  destPath: string;
  /** Uniform scale factor, if the user asked for one. */
  scale?: number;
  /** Rotation about Z, degrees. */
  rotateDeg?: number;
}

/**
 * Apply the user's scale and Z rotation to a mesh.
 *
 * These used to ride on the command line as --scale/--rotate. Baking them into
 * the geometry is what makes them survive: a project carries only what is in
 * the file, and a plate that ignored a "make it twice as big" is as wrong as
 * one that ignored a colour. Packing then measures the transformed footprint,
 * so a scaled-up part is checked against the bed at the size it will print.
 */
function transformTriangles(
  triangles: Triangle[],
  scale: number,
  rotateDeg: number,
): Triangle[] {
  if (scale === 1 && rotateDeg === 0) return triangles;
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const apply = (v: Vec3): Vec3 => ({
    x: (v.x * cos - v.y * sin) * scale,
    y: (v.x * sin + v.y * cos) * scale,
    z: v.z * scale,
  });
  return triangles.map((t) => ({
    a: apply(t.a),
    b: apply(t.b),
    c: apply(t.c),
    // Rotation and uniform scale preserve the normal's direction; rotate it so
    // it still points out of the transformed face.
    normal: {
      x: t.normal.x * cos - t.normal.y * sin,
      y: t.normal.x * sin + t.normal.y * cos,
      z: t.normal.z,
    },
  }));
}

/**
 * Write a project holding every part, arranged on the bed, with the settings
 * embedded.
 *
 * Returns undefined when there is nothing usable to write — an unreadable mesh,
 * or parts too big for the bed. The caller falls back to opening the raw files,
 * which is worse but never worse than failing.
 */
export async function writeEditorProject(
  input: EditorProjectInput,
): Promise<string | undefined> {
  const scale = typeof input.scale === "number" && input.scale > 0 ? input.scale : 1;
  const rotateDeg = typeof input.rotateDeg === "number" ? input.rotateDeg : 0;

  const meshes: Array<{ path: string; triangles: Triangle[]; w: number; d: number }> = [];
  for (const path of input.paths) {
    try {
      const mesh = await parseMesh(path);
      const triangles = transformTriangles(mesh.triangles, scale, rotateDeg);
      // Measure the footprint AFTER transforming, so packing sees the size the
      // part will actually print at.
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const t of triangles) {
        for (const v of [t.a, t.b, t.c]) {
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
        }
      }
      meshes.push({
        path,
        triangles,
        w: maxX - minX,
        d: maxY - minY,
      });
    } catch {
      // One unreadable part shouldn't cost the user the whole handoff.
    }
  }
  if (meshes.length === 0) return undefined;

  // Lay the parts out with the same packer the job pipeline uses, so an editor
  // open and a sliced plate agree about what fits where.
  const toPack: PlatePart[] = meshes.map((m) => ({ path: m.path, w: m.w, d: m.d }));
  const packed = packPlates(toPack, { w: input.bed.x, d: input.bed.y });
  const first = packed.plates[0];
  if (!first) return undefined;

  const placed = new Map<string, Placed>();
  for (const part of first.parts) {
    const mesh = meshes.find((m) => m.path === part.path);
    if (!mesh || part.x === undefined || part.y === undefined) continue;
    // The 3MF writer centres geometry on the origin, so a lower-left footprint
    // corner becomes a centre by adding half the part's size.
    placed.set(part.path, {
      triangles: mesh.triangles,
      centre: { x: part.x + mesh.w / 2, y: part.y + mesh.d / 2 },
    });
  }
  if (placed.size === 0) return undefined;

  const parts: ThreeMfPart[] = [];
  for (const [path, p] of placed) {
    parts.push({
      path: basename(path),
      triangles: p.triangles,
      extruder: 1,
      offset: { x: p.centre.x, y: p.centre.y, z: 0 },
    });
  }

  let configText: string | undefined;
  if (input.configIni) {
    try {
      configText = readFileSync(input.configIni, "utf8");
    } catch {
      // A project without settings still opens; it just uses the user's own.
    }
  }

  writeThreeMf(input.destPath, parts, [], configText);
  return input.destPath;
}
