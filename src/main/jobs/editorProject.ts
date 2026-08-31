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
import { basename, extname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { parseMesh, parse3mfObjects } from "./mesh";
import { writeThreeMf, type ThreeMfPart } from "./threemf";
import { readThreeMfColours, type ImportedPaint } from "./threemfColour";
import { synthesizeMultiMaterialConfig } from "./multimaterial";
import { packPlates, type PlatePart } from "../plates";
import type { Triangle } from "./mesh";
import type { Vec3 } from "./vec3";

/** Where a part's footprint sits, and how big it is. */
interface Placed {
  triangles: Triangle[];
  /** Bed position of the footprint's centre, in mm. */
  centre: { x: number; y: number };
  extruder: number;
  paint?: ImportedPaint;
}

/** One printable object pulled out of an input file. A 3MF can hold several,
 *  each with its own colour — which is precisely what makes it a multi-colour
 *  model, and what rebuilding it as a single anonymous mesh threw away. */
interface SourceObject {
  /** Name for the object metadata; the source file's, when it has one. */
  name: string;
  triangles: Triangle[];
  /** 1-based extruder the source file assigned, or 1. */
  extruder: number;
  paint?: ImportedPaint;
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
  /** Filament swaps up the height of the print, so the plate opens showing
   *  them in Preview and the user can move them by hand. */
  colourChanges?: Array<{ atZ: number; colourHex: string }>;
  /**
   * Write the config this project ends up carrying to this path as well.
   *
   * A caller that goes on to SLICE the project needs it. PrusaSlicer's
   * precedence is overrides > --load > the project's own settings, so slicing
   * a painted project under a single-extruder --load silently overrides the
   * extruders the painting needs and prints it in one colour.
   */
  emitConfigTo?: string;
}

/**
 * Read one input file as its printable objects.
 *
 * A 3MF is read as the objects it actually contains, WITH the extruder each
 * one is assigned to and any painting on it. Everything else is one object on
 * extruder 1. This is the difference between opening a downloaded multi-colour
 * model in its own colours and opening it as a single grey lump.
 */
async function readSourceObjects(path: string): Promise<SourceObject[]> {
  const name = basename(path);
  if (extname(path).toLowerCase() !== ".3mf") {
    const mesh = await parseMesh(path);
    return [{ name, triangles: mesh.triangles, extruder: 1 }];
  }

  const [objects, colours] = await Promise.all([
    parse3mfObjects(path),
    readThreeMfColours(path),
  ]);
  const metaById = new Map(colours.objects.map((o) => [o.objectId, o]));
  return objects.map((object, i) => {
    const meta = metaById.get(object.objectId);
    return {
      name: meta?.name ?? (objects.length > 1 ? `${name} #${i + 1}` : name),
      triangles: object.triangles,
      extruder: meta?.extruder ?? 1,
      // Paint comes from the object that owns the triangles, not from the
      // colour metadata — its codes index that exact list.
      paint: object.paint,
    };
  });
}

/**
 * Merge PrusaSlicer .ini text, with `override` winning key by key.
 *
 * A model that arrives with two colours needs a config that HAS two extruders,
 * or PrusaSlicer clamps every object back to extruder 1 and the colours vanish
 * again. Replacing the user's config wholesale would throw away their printer
 * to gain the colours; merging keeps both.
 */
function mergeIni(base: string, override: string): string {
  const values = new Map<string, string>();
  const order: string[] = [];
  for (const text of [base, override]) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!values.has(key)) order.push(key);
      values.set(key, line.slice(eq + 1).trim());
    }
  }
  return order.map((key) => `${key} = ${values.get(key)}`).join("\n") + "\n";
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

  // Every printable object across every input file. A 3MF contributes one per
  // object it holds, so a two-colour download becomes two coloured parts
  // rather than one anonymous mesh. `key` is the packer's identity for the
  // object — a file path is not enough, because one file can supply several.
  const meshes: Array<{
    key: string;
    object: SourceObject;
    triangles: Triangle[];
    w: number;
    d: number;
  }> = [];
  for (const path of input.paths) {
    let objects: SourceObject[];
    try {
      objects = await readSourceObjects(path);
    } catch {
      // One unreadable part shouldn't cost the user the whole handoff.
      continue;
    }
    objects.forEach((object, i) => {
      const triangles = transformTriangles(object.triangles, scale, rotateDeg);
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
      if (!Number.isFinite(minX)) return; // no geometry
      meshes.push({
        key: `${path}#${i}`,
        object,
        triangles,
        w: maxX - minX,
        d: maxY - minY,
      });
    });
  }
  if (meshes.length === 0) return undefined;

  // Lay the parts out with the same packer the job pipeline uses, so an editor
  // open and a sliced plate agree about what fits where.
  const toPack: PlatePart[] = meshes.map((m) => ({ path: m.key, w: m.w, d: m.d }));
  const packed = packPlates(toPack, { w: input.bed.x, d: input.bed.y });
  const first = packed.plates[0];
  if (!first) return undefined;

  const placed = new Map<string, Placed>();
  for (const part of first.parts) {
    const mesh = meshes.find((m) => m.key === part.path);
    if (!mesh || part.x === undefined || part.y === undefined) continue;
    // The 3MF writer centres geometry on the origin, so a lower-left footprint
    // corner becomes a centre by adding half the part's size.
    placed.set(part.path, {
      triangles: mesh.triangles,
      centre: { x: part.x + mesh.w / 2, y: part.y + mesh.d / 2 },
      extruder: mesh.object.extruder,
      paint: mesh.object.paint,
    });
  }
  if (placed.size === 0) return undefined;

  const parts: ThreeMfPart[] = [];
  for (const [key, p] of placed) {
    const source = meshes.find((m) => m.key === key);
    parts.push({
      path: source?.object.name ?? basename(key),
      triangles: p.triangles,
      extruder: p.extruder,
      offset: { x: p.centre.x, y: p.centre.y, z: 0 },
      paint: p.paint,
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

  // A model that arrived with its own colours needs a config that HAS the
  // extruders those colours live on. Without it PrusaSlicer clamps every
  // object back to extruder 1 and the imported colours disappear on the way
  // in — which is the whole failure this path exists to fix.
  //
  // PAINTING counts here too, and is easy to miss: a painted model is ONE
  // object assigned to extruder 1, with its second colour living entirely in
  // the triangle codes. Counting only the object assignments gives 1, the
  // project opens as a single-extruder printer, and the painting has no second
  // filament to use. Verified against PrusaSlicer 2.9.5 on a real MakerWorld
  // model: the same painted mesh produces 22 tool changes with a two-extruder
  // config and none at all with one.
  const palette = await importedPalette(input.paths);
  const painted = parts.some((p) => p.paint);
  const extruders = Math.max(
    ...parts.map((p) => p.extruder),
    painted ? Math.max(palette.length, 2) : 1,
    1,
  );
  if (extruders > 1) {
    const multi = readFileSync(
      synthesizeMultiMaterialConfig({
        bed: input.bed,
        nozzleMm: 0.4,
        material: "PLA",
        colours: padPalette(palette, extruders),
      }),
      "utf8",
    );
    // The user's own settings stay; only the multi-extruder keys are imposed.
    configText = configText ? mergeIni(configText, multi) : multi;
  }

  if (input.emitConfigTo && configText) {
    writeFileSync(input.emitConfigTo, configText, "utf8");
  }

  writeThreeMf(
    input.destPath,
    parts,
    input.colourChanges ?? [],
    configText,
    extruders > 1 ? "MultiAsSingle" : "SingleExtruder",
  );
  return input.destPath;
}

/** Fill a palette out to one entry per extruder. A gap is a spool the model
 *  never referred to, not a colour we are choosing for it — but a per-extruder
 *  config has to state a value for every extruder it declares. */
function padPalette(palette: string[], extruders: number): string[] {
  return Array.from({ length: extruders }, (_, i) => palette[i] ?? "#FFFFFF");
}

/** The filament colours the imported files name, in extruder order. */
async function importedPalette(paths: string[]): Promise<string[]> {
  const palette: string[] = [];
  for (const path of paths) {
    if (extname(path).toLowerCase() !== ".3mf") continue;
    const found = await readThreeMfColours(path);
    found.palette.forEach((colour, i) => {
      palette[i] ??= colour;
    });
    for (const object of found.objects) {
      if (object.extruder && object.colourHex) palette[object.extruder - 1] ??= object.colourHex;
    }
  }
  return palette;
}
