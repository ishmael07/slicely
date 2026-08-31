// Mesh loading + geometry extraction for the job planner. This is the layer
// underneath orientation.ts: it turns a file on disk into triangles-with-
// normals plus the aggregate facts (bbox, volume, surface area, centre of
// mass, large flat faces) that the orientation search and the planner reason
// about.
//
// Binary STL and ASCII STL are both first-class. Format is NOT guessed from
// the "solid" text prefix — plenty of real binary STLs (notably ones written
// by SolidWorks) start their 80-byte header with the literal bytes "solid ",
// which fools naive prefix-sniffing. We instead validate the binary-STL size
// invariant (header 84 bytes + 50 bytes/triangle == file size) and only fall
// back to ASCII parsing when that arithmetic doesn't check out.
//
// 3MF is a zip of XML model documents. `parse3mfObjects` reads every
// <object> as its own object, resolves <component> references (including
// into the SEPARATE part files the production extension allows — which is how
// Bambu Studio, and therefore every MakerWorld download, stores its geometry),
// and places each by its <build> item's transform. `parseMesh` then merges
// them, because measuring a model wants one mesh while colouring one needs the
// objects kept apart. A file we can't make sense of throws a clear Error
// rather than crashing the caller.
//
// Large files are read via a Node stream so the raw bytes are processed in
// bounded chunks rather than pulled into memory as one Buffer. The one cost
// we can't avoid: orientation.ts needs actual per-triangle data, so the
// *parsed* representation (one small object per triangle) is still held in
// memory for the lifetime of the call. For a 200 MB binary STL (~4M
// triangles) that's a few hundred MB of small objects — well short of
// Node's default heap ceiling, but callers slicing truly enormous meshes
// should still be aware this is O(triangles), not O(1).

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { extname } from "node:path";
import unzipper from "unzipper";
import * as cheerio from "cheerio";
import type { ImportedPaint } from "./threemfColour";
import {
  type Vec3,
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
} from "./vec3";

export type { Vec3 } from "./vec3";

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** Outward unit normal. Always RE-DERIVED from vertex winding (never
   *  trusted from the file) — many exporters leave the stored STL normal
   *  zeroed or stale, and volume-sign correction below depends on winding
   *  being the ground truth anyway. */
  normal: Vec3;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

/** A cluster of coplanar, co-aligned triangles big enough to plausibly be a
 *  pose a human would pick — "lay this face on the bed". */
export interface FlatFace {
  /** Outward unit normal shared by the cluster (mesh space, as imported). */
  normal: Vec3;
  areaMm2: number;
  /** Area-weighted centroid of the cluster, mesh space. */
  centroid: Vec3;
}

export interface MeshData {
  triangles: Triangle[];
  boundingBox: BoundingBox;
  /** Always >= 0. Computed via the divergence-theorem (signed tetrahedron
   *  sum) — exact for a closed, manifold mesh; an under/over-estimate for a
   *  mesh with holes, which we don't attempt to detect here. */
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** Exact for a closed manifold solid of uniform density; approximate
   *  otherwise (same caveat as volume). */
  centreOfMass: Vec3;
  /** Largest clusters first. Capped at 16 — plenty for the orientation
   *  search's `maxCandidates` budget. */
  largeFlatFaces: FlatFace[];
}

const STL_HEADER_BYTES = 84;
const STL_TRIANGLE_BYTES = 50;

/**
 * Decide binary vs ASCII STL from the file size invariant alone:
 * a binary STL is EXACTLY `84 + 50*triangleCount` bytes, where triangleCount
 * is the uint32 at byte offset 80. We deliberately never look at whether the
 * bytes spell "solid" — binary files are allowed to (and sometimes do) start
 * with that text, so a prefix check would silently mis-detect them as ASCII
 * and garble every vertex.
 *
 * `header` must contain at least the first 84 bytes of the file (fewer than
 * that can't be a binary STL with even zero triangles, so it's ASCII/other).
 */
export function detectStlKind(header: Buffer, fileSizeBytes: number): "binary" | "ascii" {
  if (header.length < STL_HEADER_BYTES) return "ascii";
  const triangleCount = header.readUInt32LE(80);
  const expected = STL_HEADER_BYTES + STL_TRIANGLE_BYTES * triangleCount;
  return expected === fileSizeBytes ? "binary" : "ascii";
}

/** Parse a mesh file into triangles + derived geometry. Dispatches on
 *  extension for 3MF/OBJ-style containers, and on the size-invariant for
 *  anything that looks like an STL (including files with no/odd extension —
 *  STL has no reliable magic number, so `.stl` is treated as the default). */
export async function parseMesh(filePath: string): Promise<MeshData> {
  const ext = extname(filePath).toLowerCase();
  const triangles = ext === ".3mf" ? await parse3mf(filePath) : await parseStl(filePath);
  return computeMeshData(triangles);
}

/** Pure geometry pass over an already-parsed triangle list. Exposed
 *  separately so tests (and orientation.ts, indirectly) can build tiny
 *  meshes in code without going through file I/O. */
export function computeMeshData(triangles: Triangle[]): MeshData {
  const boundingBox = computeBoundingBox(triangles);
  const surfaceAreaMm2 = triangles.reduce((s, t) => s + triangleArea(t), 0);

  // Signed-tetrahedron volume (divergence theorem, apex at the origin):
  // V = (1/6) * sum( a . (b x c) ). Also gives us the mesh's overall winding
  // sign for free — if it comes out negative, the file's vertex winding is
  // inward (clockwise from outside), and every stored/derived normal above
  // needs flipping to be genuinely outward.
  let signedVolume6 = 0;
  const tetCentroidWeighted: Vec3 = { x: 0, y: 0, z: 0 };
  let tetVolumeSum = 0;
  for (const t of triangles) {
    const v6 = dot(t.a, cross(t.b, t.c)); // 6x the signed tet volume
    signedVolume6 += v6;
    const tetVol = v6 / 6;
    const centroid = scale(add(add(t.a, t.b), t.c), 1 / 4); // (0+a+b+c)/4
    tetVolumeSum += tetVol;
    tetCentroidWeighted.x += tetVol * centroid.x;
    tetCentroidWeighted.y += tetVol * centroid.y;
    tetCentroidWeighted.z += tetVol * centroid.z;
  }
  const volumeMm3 = Math.abs(signedVolume6 / 6);
  const inverted = signedVolume6 < 0;
  const fixedTriangles = inverted
    ? triangles.map((t) => ({ ...t, normal: scale(t.normal, -1) }))
    : triangles;

  const centreOfMass =
    Math.abs(tetVolumeSum) > 1e-9
      ? scale(tetCentroidWeighted, 1 / tetVolumeSum)
      : averageVertex(triangles);

  const largeFlatFaces = clusterFlatFaces(fixedTriangles);

  return {
    triangles: fixedTriangles,
    boundingBox,
    volumeMm3,
    surfaceAreaMm2,
    centreOfMass,
    largeFlatFaces,
  };
}

function averageVertex(triangles: Triangle[]): Vec3 {
  if (triangles.length === 0) return { x: 0, y: 0, z: 0 };
  let x = 0, y = 0, z = 0, n = 0;
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      x += v.x; y += v.y; z += v.z; n++;
    }
  }
  return { x: x / n, y: y / n, z: z / n };
}

function triangleArea(t: Triangle): number {
  return 0.5 * length(cross(sub(t.b, t.a), sub(t.c, t.a)));
}

function computeBoundingBox(triangles: Triangle[]): BoundingBox {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      if (v.x < min.x) min.x = v.x;
      if (v.y < min.y) min.y = v.y;
      if (v.z < min.z) min.z = v.z;
      if (v.x > max.x) max.x = v.x;
      if (v.y > max.y) max.y = v.y;
      if (v.z > max.z) max.z = v.z;
    }
  }
  if (!Number.isFinite(min.x)) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return { min, max };
}

/**
 * Group triangles into planar clusters: same outward normal direction
 * (within ~0.5 deg) AND the same plane offset (within 0.05 mm). This is a
 * heuristic stand-in for a real coplanar-region / convex-hull-facet finder —
 * it's a single greedy pass, O(n * clusters), which is fine because most
 * meshes have a small number of large flat regions (the rest is curved
 * surface, which never accumulates into a "large flat face" anyway).
 */
function clusterFlatFaces(triangles: Triangle[]): FlatFace[] {
  const NORMAL_COS_EPS = 0.9999; // ~0.8 deg
  const PLANE_EPS_MM = 0.05;

  interface Cluster {
    normal: Vec3; // representative normal (first triangle's)
    planeD: number; // representative plane offset: dot(normal, point)
    areaMm2: number;
    weightedCentroid: Vec3;
  }

  // Bucket by a quantised (normal, plane-offset) key rather than scanning the
  // existing clusters for every triangle.
  //
  // The scan was quadratic: an organic model gives almost every triangle its
  // own normal, so the cluster list grows with the mesh and each new triangle
  // walks all of it. Measured at 7 SECONDS for 23,722 triangles, and a 471k
  // model never finished at all — which is what made large jobs hang.
  //
  // Bucketing makes the common case a single map lookup. Two triangles on one
  // plane can still land in adjacent buckets, so the pass below rejoins them.
  const NORMAL_STEP = 0.02; // finer than NORMAL_COS_EPS allows to matter
  const buckets = new Map<string, Cluster>();

  for (const t of triangles) {
    const n = t.normal;
    if (length(n) < 1e-9) continue; // degenerate triangle, skip
    const area = triangleArea(t);
    if (area < 1e-9) continue;
    const centroid = scale(add(add(t.a, t.b), t.c), 1 / 3);
    const d = dot(n, t.a);

    const key =
      `${Math.round(n.x / NORMAL_STEP)},${Math.round(n.y / NORMAL_STEP)},` +
      `${Math.round(n.z / NORMAL_STEP)},${Math.round(d / PLANE_EPS_MM)}`;

    let target = buckets.get(key);
    if (!target) {
      target = { normal: n, planeD: d, areaMm2: 0, weightedCentroid: { x: 0, y: 0, z: 0 } };
      buckets.set(key, target);
    }
    target.areaMm2 += area;
    target.weightedCentroid.x += centroid.x * area;
    target.weightedCentroid.y += centroid.y * area;
    target.weightedCentroid.z += centroid.z * area;
  }

  const ranked = [...buckets.values()]
    .filter((c) => c.areaMm2 > 1e-6)
    .sort((a, b) => b.areaMm2 - a.areaMm2);

  // Rejoin faces that quantisation split across neighbouring buckets. Only the
  // biggest faces matter — they are what orientation scoring picks a pose from
  // — so this is capped, keeping it trivial no matter how large the mesh is.
  const MERGE_CANDIDATES = 200;
  const head = ranked.slice(0, MERGE_CANDIDATES);
  const tail = ranked.slice(MERGE_CANDIDATES);
  const merged: Cluster[] = [];
  for (const c of head) {
    const into = merged.find(
      (m) =>
        dot(m.normal, c.normal) >= NORMAL_COS_EPS &&
        Math.abs(m.planeD - c.planeD) <= PLANE_EPS_MM,
    );
    if (into) {
      into.areaMm2 += c.areaMm2;
      into.weightedCentroid.x += c.weightedCentroid.x;
      into.weightedCentroid.y += c.weightedCentroid.y;
      into.weightedCentroid.z += c.weightedCentroid.z;
    } else {
      merged.push(c);
    }
  }

  return [...merged, ...tail]
    .map((c) => ({
      normal: c.normal,
      areaMm2: c.areaMm2,
      centroid: scale(c.weightedCentroid, 1 / c.areaMm2),
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2);
}

// ── STL parsing ──────────────────────────────────────────────────────────

async function parseStl(filePath: string): Promise<Triangle[]> {
  const st = await stat(filePath);
  const fd = await open(filePath, "r");
  let kind: "binary" | "ascii";
  let triangleCount = 0;
  try {
    const header = Buffer.alloc(STL_HEADER_BYTES);
    const { bytesRead } = await fd.read(header, 0, STL_HEADER_BYTES, 0);
    kind = detectStlKind(header.subarray(0, bytesRead), st.size);
    if (kind === "binary") triangleCount = header.readUInt32LE(80);
  } finally {
    await fd.close();
  }
  return kind === "binary"
    ? parseBinaryStlStream(filePath, triangleCount)
    : parseAsciiStl(filePath);
}

/** Stream the file in chunks, only ever holding the current chunk plus a
 *  small leftover remainder (< 50 bytes) in memory alongside the growing
 *  triangle array — never the whole raw file. */
function parseBinaryStlStream(filePath: string, triangleCount: number): Promise<Triangle[]> {
  return new Promise((resolve, reject) => {
    const triangles: Triangle[] = new Array(triangleCount);
    let idx = 0;
    let leftover: Buffer = Buffer.alloc(0);
    let skippedHeader = false;

    const stream = createReadStream(filePath, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk: Buffer | string) => {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = leftover.length ? Buffer.concat([leftover, buf]) : buf;
      let offset = 0;
      if (!skippedHeader) {
        if (buf.length < STL_HEADER_BYTES) {
          leftover = buf;
          return;
        }
        offset = STL_HEADER_BYTES;
        skippedHeader = true;
      }
      while (buf.length - offset >= STL_TRIANGLE_BYTES && idx < triangleCount) {
        // Layout: 3x float32 normal, 3x (3x float32 vertex), uint16 attr.
        const o = offset;
        const ax = buf.readFloatLE(o + 12);
        const ay = buf.readFloatLE(o + 16);
        const az = buf.readFloatLE(o + 20);
        const bx = buf.readFloatLE(o + 24);
        const by = buf.readFloatLE(o + 28);
        const bz = buf.readFloatLE(o + 32);
        const cx = buf.readFloatLE(o + 36);
        const cy = buf.readFloatLE(o + 40);
        const cz = buf.readFloatLE(o + 44);
        const a = { x: ax, y: ay, z: az };
        const b = { x: bx, y: by, z: bz };
        const c = { x: cx, y: cy, z: cz };
        triangles[idx++] = { a, b, c, normal: faceNormal(a, b, c) };
        offset += STL_TRIANGLE_BYTES;
      }
      leftover = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    });
    stream.on("end", () => resolve(triangles.slice(0, idx)));
    stream.on("error", reject);
  });
}

/** Line-oriented streaming parse for ASCII STL. Numbers are read with
 *  `parseFloat`, which happily accepts the scientific notation some
 *  exporters emit ("1.23e-04"). */
async function parseAsciiStl(filePath: string): Promise<Triangle[]> {
  const triangles: Triangle[] = [];
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }) });
  let pending: Vec3[] = [];

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.startsWith("vertex")) {
      const parts = line.split(/\s+/);
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        pending.push({ x, y, z });
      }
    } else if (line.startsWith("endfacet")) {
      if (pending.length >= 3) {
        const [a, b, c] = pending;
        triangles.push({ a, b, c, normal: faceNormal(a, b, c) });
      }
      pending = [];
    }
  }
  return triangles;
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

// ── 3MF (best-effort) ────────────────────────────────────────────────────

/**
 * Best-effort 3MF mesh extraction: unzip, read 3D/3dmodel.model, and pull
 * every <object><mesh> block's <vertices>/<triangles>. Multiple objects are
 * merged into one triangle soup at their AS-MODELED coordinates — we do NOT
 * apply the <build>/<component> transform graph, so an assembly of several
 * positioned parts will come back overlapping rather than laid out. That is
 * an accepted gap (the P3 brief only requires 3MF not crash callers); most
 * single-part 3MF exports (the common case for a downloaded print-ready
 * model) have exactly one object at the identity transform and round-trip
 * correctly.
 */
/** One object out of a 3MF, positioned by its build item. */
export interface ThreeMfObject {
  /** The object's id in the model document — the key every colour dialect
   *  uses to say which object it is talking about. */
  objectId: string;
  triangles: Triangle[];
  /**
   * Per-triangle painting, indexed into `triangles`.
   *
   * Read HERE rather than beside the rest of the colour metadata because paint
   * codes index the triangle list, and this is what builds that list. A second,
   * independent walk over the mesh would have to agree about ordering,
   * component flattening and dropped degenerate faces — and the first time it
   * did not, the wrong face would be painted with nothing to show for it.
   */
  paint?: ImportedPaint;
}

async function parse3mf(filePath: string): Promise<Triangle[]> {
  const objects = await parse3mfObjects(filePath);
  return objects.flatMap((o) => o.triangles);
}

/**
 * Read a 3MF as SEPARATE objects, each placed where its build item puts it.
 *
 * `parseMesh` merges these into one soup, which is what measuring a model
 * wants. Colour does not: every colour dialect in a 3MF says "object N is
 * filament 2", so merging the objects throws the assignments away along with
 * the boundaries they refer to. A downloaded multi-colour model arrives as one
 * uncoloured blob because of it.
 *
 * Build-item transforms ARE applied here, so an assembly of positioned parts
 * comes back laid out rather than every part overlapping at the origin. An
 * object referenced by several items comes back once per item, because each is
 * a real instance that has to be placed and printed.
 *
 * Still not handled: `<component>` references, where one object is built from
 * others. Those are rare in print-ready downloads and would need the full
 * transform graph; such an object comes back with its own mesh only.
 */
export async function parse3mfObjects(filePath: string): Promise<ThreeMfObject[]> {
  let documents: Map<string, string>;
  try {
    documents = await readModelDocuments(filePath);
  } catch (err) {
    throw new Error(
      `Couldn't read 3MF "${filePath}": ${err instanceof Error ? err.message : String(err)} (Slicely's 3MF support is best-effort).`,
    );
  }
  const root = documents.get(ROOT_MODEL);
  if (root === undefined) {
    throw new Error(
      `Couldn't read 3MF "${filePath}": no "3D/3dmodel.model" entry found in the archive (Slicely's 3MF support is best-effort).`,
    );
  }

  // Every object in every part file, keyed by document then id. Ids are only
  // unique WITHIN a document, so the document has to be part of the key.
  const parsed = new Map<string, Map<string, ParsedObject>>();
  for (const [path, xml] of documents) parsed.set(path, parseObjects(xml));

  const empty = (): ResolvedMesh => ({ triangles: [], codes: new Map() });
  const resolve = (path: string, id: string, depth: number): ResolvedMesh => {
    // A file that references itself, directly or round a longer loop, would
    // otherwise spin here forever.
    if (depth > 8) return empty();
    const object = parsed.get(path)?.get(id);
    if (!object) return empty();
    if (object.triangles.length > 0) {
      return {
        triangles: object.triangles,
        codes: object.paintCodes,
        attribute: object.paintAttribute,
      };
    }
    // Components are concatenated, so their paint indices shift by however
    // many triangles came before them.
    const out = empty();
    for (const component of object.components) {
      const target = component.path ? normalizeModelPath(component.path) : path;
      const part = resolve(target, component.objectid, depth + 1);
      const offset = out.triangles.length;
      out.triangles.push(...applyThreeMfTransform(part.triangles, component.transform));
      for (const [index, code] of part.codes) out.codes.set(offset + index, code);
      out.attribute ??= part.attribute;
    }
    return out;
  };

  // Place each build item. Its transform composes on top of whatever the
  // components already applied — Bambu puts the model's SCALE here, so
  // applying only one of the two gives a part of the wrong size.
  const placed: ThreeMfObject[] = [];
  const built = new Set<string>();
  const rootDoc = cheerio.load(root, { xmlMode: true });
  rootDoc("build > item").each((_i, itemEl) => {
    const attribs = (itemEl as { attribs?: Record<string, string> }).attribs ?? {};
    const objectId = attribs.objectid;
    if (!objectId) return;
    const resolved = resolve(ROOT_MODEL, objectId, 0);
    // A transform maps triangles one to one, so the paint indices still line
    // up with the list they were read against.
    const triangles = applyThreeMfTransform(resolved.triangles, attribs.transform);
    if (triangles.length === 0) return;
    built.add(objectId);
    placed.push({ objectId, triangles, paint: paintOf(resolved) });
  });

  // An object nobody built is still geometry the user downloaded. Include it
  // untransformed rather than silently dropping part of their model.
  for (const objectId of (parsed.get(ROOT_MODEL) ?? new Map()).keys()) {
    if (built.has(objectId)) continue;
    const resolved = resolve(ROOT_MODEL, objectId, 0);
    if (resolved.triangles.length > 0) {
      placed.push({ objectId, triangles: resolved.triangles, paint: paintOf(resolved) });
    }
  }

  if (placed.length === 0) {
    throw new Error(
      `Couldn't parse 3MF "${filePath}": no mesh triangles found in 3D/3dmodel.model (Slicely's 3MF support is best-effort).`,
    );
  }
  return placed;
}

/** The root model document's path, normalised. */
const ROOT_MODEL = "/3d/3dmodel.model";

/** One object as the file describes it: its own mesh, or references to others. */
interface ParsedObject {
  triangles: Triangle[];
  /** Codes on this object's OWN triangles, indexed into `triangles`. */
  paintCodes: Map<number, string>;
  paintAttribute?: string;
  components: Array<{ path?: string; objectid: string; transform?: string }>;
}

/** A resolved object: its flattened triangles and the painting on them. */
interface ResolvedMesh {
  triangles: Triangle[];
  codes: Map<number, string>;
  attribute?: string;
}

/** Attributes that carry per-triangle painting, most specific first. */
const PAINT_ATTRIBUTES = ["slic3rpe:mmu_segmentation", "mmu_segmentation", "paint_color"];

/** Lowercased, leading-slash form, so a reference and an archive entry compare
 *  equal however each spelled the path. */
function normalizeModelPath(path: string): string {
  const clean = path.replace(/\\/g, "/").toLowerCase();
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/**
 * Every model document in the archive.
 *
 * Not just 3D/3dmodel.model: the 3MF production extension lets an object live
 * in its own part file, referenced by `<component p:path=...>`. Bambu Studio
 * writes every file this way, so every MakerWorld download does too — and a
 * parser reading only the root document finds no triangles at all in exactly
 * the files multi-colour models come from.
 */
async function readModelDocuments(filePath: string): Promise<Map<string, string>> {
  const directory = await unzipper.Open.file(filePath);
  const out = new Map<string, string>();
  for (const file of directory.files) {
    if (!file.path.toLowerCase().endsWith(".model")) continue;
    out.set(normalizeModelPath(file.path), (await file.buffer()).toString("utf8"));
  }
  return out;
}

/** The published paint shape, or nothing when the object is unpainted. */
function paintOf(resolved: ResolvedMesh): ImportedPaint | undefined {
  if (!resolved.attribute || resolved.codes.size === 0) return undefined;
  return { attribute: resolved.attribute, codes: resolved.codes };
}

/** The objects one model document declares, by id. */
function parseObjects(xml: string): Map<string, ParsedObject> {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = new Map<string, ParsedObject>();

  $("object").each((i, objEl) => {
    const objectId = (objEl as { attribs?: Record<string, string> }).attribs?.id ?? String(i + 1);
    const vertices: Vec3[] = [];
    $(objEl)
      .find("mesh > vertices > vertex")
      .each((_j, vEl) => {
        const attribs = (vEl as { attribs?: Record<string, string> }).attribs ?? {};
        vertices.push({
          x: parseFloat(attribs.x ?? "0"),
          y: parseFloat(attribs.y ?? "0"),
          z: parseFloat(attribs.z ?? "0"),
        });
      });
    const triangles: Triangle[] = [];
    $(objEl)
      .find("mesh > triangles > triangle")
      .each((_j, tEl) => {
        const attribs = (tEl as { attribs?: Record<string, string> }).attribs ?? {};
        const a = vertices[Number(attribs.v1)];
        const b = vertices[Number(attribs.v2)];
        const c = vertices[Number(attribs.v3)];
        if (a && b && c) triangles.push({ a, b, c, normal: faceNormal(a, b, c) });
      });

    // Painting, read off the same triangles in the same order they were just
    // parsed in — which is what makes the indices mean anything.
    const paintCodes = new Map<number, string>();
    let paintAttribute: string | undefined;
    $(objEl)
      .find("mesh > triangles > triangle")
      .each((index, tEl) => {
        const attribs = (tEl as { attribs?: Record<string, string> }).attribs ?? {};
        for (const name of PAINT_ATTRIBUTES) {
          const code = attribs[name];
          if (code === undefined || code === "") continue;
          // The first dialect seen wins for the whole object. A file mixing
          // two would be malformed, and guessing per-triangle would produce a
          // paint set no slicer could read back.
          paintAttribute ??= name;
          if (name === paintAttribute) paintCodes.set(index, code);
          break;
        }
      });

    const components: ParsedObject["components"] = [];
    $(objEl)
      .find("components > component")
      .each((_j, cEl) => {
        const attribs = (cEl as { attribs?: Record<string, string> }).attribs ?? {};
        // The path attribute is namespaced (p:path) in real files; cheerio in
        // XML mode keeps the prefix, so both spellings are accepted.
        const objectid = attribs.objectid;
        if (!objectid) return;
        components.push({
          path: attribs["p:path"] ?? attribs.path,
          objectid,
          transform: attribs.transform,
        });
      });

    out.set(objectId, { triangles, paintCodes, paintAttribute, components });
  });

  return out;
}

/**
 * Apply a 3MF `transform` attribute to a mesh.
 *
 * The attribute is twelve numbers: a 4x3 matrix in ROW-MAJOR order, the first
 * nine being the 3x3 basis and the last three the translation. Points are row
 * vectors multiplied on the LEFT, so a column of the basis is a destination
 * axis:  x' = x*m0 + y*m3 + z*m6 + m9.
 *
 * Normals are re-derived from the transformed winding rather than rotated,
 * because a transform may mirror — and a mirrored face whose normal was merely
 * rotated would point into the solid.
 */
function applyThreeMfTransform(triangles: Triangle[], transform?: string): Triangle[] {
  if (!transform) return triangles;
  const m = transform.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) return triangles;
  // An identity transform is the common case; skip the whole pass.
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  if (identity.every((v, i) => m[i] === v)) return triangles;

  const at = (v: Vec3): Vec3 => ({
    x: v.x * m[0] + v.y * m[3] + v.z * m[6] + m[9],
    y: v.x * m[1] + v.y * m[4] + v.z * m[7] + m[10],
    z: v.x * m[2] + v.y * m[5] + v.z * m[8] + m[11],
  });
  return triangles.map((t) => {
    const a = at(t.a);
    const b = at(t.b);
    const c = at(t.c);
    return { a, b, c, normal: faceNormal(a, b, c) };
  });
}
