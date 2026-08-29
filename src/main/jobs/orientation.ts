// Orientation search: the highest-leverage decision Slicely was previously
// not making at all. plates.ts deliberately never rotates a part (it mirrors
// PrusaSlicer's un-rotated CLI arranger — see its header). This module is
// the other half: BEFORE packing, decide which way UP each part should sit,
// then hand plates.ts the resulting footprint.
//
// HONESTY UP FRONT: this is a heuristic over face normals and the bounding
// box, not a physics simulation. It does not compute real support VOLUME
// (which needs the full overhang geometry cross-referenced against
// everything below it), doesn't model bridging, and doesn't know about
// PrusaSlicer's snug/organic support generators. What it does compute
// honestly, from the actual mesh:
//   - overhangAreaMm2: the projected (XY) area of downward-facing triangles
//     steeper than the support threshold. This tracks support volume well
//     (more downward-facing area ~= more material printed into thin air ~=
//     more support), but is an area proxy, not a volume integral.
//   - bedContactMm2: real area of triangles flush with the bed, downward
//     facing. Exact, not a proxy.
//   - layerCount: exact, given a layer height.
// Everything scored beyond that (which pose is "best") is a weighted
// combination of these signals, tuned by the caller's goal.

import type {
  OrientationCandidate,
  OrientationOptions,
  OrientationResult,
} from "../../shared/jobs";
import type { PrintGoal } from "../../shared/types";
import type { Triangle } from "./mesh";
import { computeMeshData, type FlatFace, type MeshData } from "./mesh";
import {
  type Mat3,
  type Vec3,
  dot,
  eulerToMatrix,
  eulerXYZFromMatrix,
  matFromToRotation,
  matVec,
  normalize,
} from "./vec3";

const DOWN: Vec3 = { x: 0, y: 0, z: -1 };
const DEFAULT_SUPPORT_THRESHOLD_DEG = 45;
const DEFAULT_LAYER_HEIGHT_MM = 0.2;
const DEFAULT_MAX_CANDIDATES = 24;
/** Candidates whose "down direction" (in mesh space) is within this angle of
 *  one already generated are considered duplicates and skipped — this is
 *  what keeps a box-like part (whose 6 largest flat faces are exactly its 6
 *  axis-aligned faces) from listing the same pose twice. */
const DEDUPE_ANGLE_DEG = 5;
/** Below this, a pose is treated as "doesn't actually rest on the bed" —
 *  a knife-edge or point contact that won't adhere or stay put. This is an
 *  absolute floor (mm²), not relative to the part's size: even a small part
 *  needs some real contact patch, and a large part balanced on a sliver is
 *  worse, not better. */
const MIN_BED_CONTACT_MM2 = 1;

interface CandidateSpec {
  matrix: Mat3;
  source: "axis" | "flat-face";
  faceAreaMm2?: number;
}

interface CandidateMetrics extends CandidateSpec {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  overhangAreaMm2: number;
  bedContactMm2: number;
  layerCount: number;
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
}

export function chooseOrientation(
  tris: Triangle[],
  opts: OrientationOptions = {},
): OrientationResult {
  const goal: PrintGoal = opts.goal ?? "quality";
  const supportThresholdDeg = opts.supportThresholdDeg ?? DEFAULT_SUPPORT_THRESHOLD_DEG;
  const layerHeightMm = opts.layerHeightMm && opts.layerHeightMm > 0
    ? opts.layerHeightMm
    : DEFAULT_LAYER_HEIGHT_MM;
  const maxCandidates = opts.maxCandidates && opts.maxCandidates > 0
    ? Math.floor(opts.maxCandidates)
    : DEFAULT_MAX_CANDIDATES;
  const loadAxis = opts.loadAxis ? normalize(opts.loadAxis) : undefined;

  if (tris.length === 0) {
    const empty: OrientationCandidate = {
      rotXDeg: 0, rotYDeg: 0, rotZDeg: 0,
      sizeX: 0, sizeY: 0, sizeZ: 0,
      overhangAreaMm2: 0, bedContactMm2: 0, layerCount: 0,
      score: 0,
      rationale: ["No geometry to evaluate."],
    };
    return { best: empty, candidates: [empty], keptAsImported: true };
  }

  // planner.ts already parsed the file, and parseMesh computes this same
  // structure — recomputing it here doubled the per-part cost for nothing.
  const mesh = (opts.mesh as MeshData | undefined) ?? computeMeshData(tris);
  const specs = generateCandidateSpecs(mesh.largeFlatFaces, maxCandidates);

  // Score against a sample of the mesh when it is very large.
  //
  // Every candidate pose is evaluated against every triangle, so cost is
  // poses x triangles: a 400k-triangle model spent seconds here, and a job full
  // of them felt like a hang. The scores are a heuristic used only to RANK
  // poses against each other, and every pose is measured on the same sample, so
  // the ranking is preserved. Areas are scaled back up by the sampling ratio,
  // keeping the reported mm² figures honest.
  const scoringTris = sampleForScoring(mesh.triangles);
  const areaScale = mesh.triangles.length / scoringTris.length;

  const thresholdRad = (supportThresholdDeg * Math.PI) / 180;
  const evaluated: CandidateMetrics[] = specs.map((spec) => {
    const sampled = evaluateCandidate(scoringTris, spec.matrix, thresholdRad, layerHeightMm);
    // Bounding box and layer count come from extents, which sampling barely
    // moves; the two AREA sums are what need rescaling.
    const raw = {
      ...sampled,
      overhangAreaMm2: sampled.overhangAreaMm2 * areaScale,
      bedContactMm2: sampled.bedContactMm2 * areaScale,
    };
    const euler = eulerXYZFromMatrix(spec.matrix);
    return {
      ...spec,
      ...raw,
      rotXDeg: round1(euler.x),
      rotYDeg: round1(euler.y),
      rotZDeg: round1(euler.z),
    };
  });

  const maxOverhang = Math.max(1e-9, ...evaluated.map((c) => c.overhangAreaMm2));
  const maxBedContact = Math.max(1e-9, ...evaluated.map((c) => c.bedContactMm2));
  const maxLayers = Math.max(1, ...evaluated.map((c) => c.layerCount));
  const maxHeight = Math.max(1e-9, ...evaluated.map((c) => c.sizeZ));

  const scored: OrientationCandidate[] = evaluated.map((c) => {
    const overhangScore = 100 * (1 - c.overhangAreaMm2 / maxOverhang);
    const layersScore = 100 * (1 - c.layerCount / maxLayers);
    const bedContactScore = 100 * (c.bedContactMm2 / maxBedContact);
    const heightScore = 100 * (1 - c.sizeZ / maxHeight);

    let strengthScore: number | undefined;
    if (loadAxis) {
      // "Layer lines perpendicular to the load axis" is interpreted as: keep
      // the load direction WITHIN the horizontal layer plane (perpendicular
      // to the vertical build/Z axis, which is the layer plane's normal).
      // That's the standard FDM strength rule — the weak point is the bond
      // BETWEEN layers, so a load that runs across layers (parallel to Z)
      // pulls directly on that weak interface, while a load that runs
      // within a layer is resisted by continuous, unbroken plastic.
      const rotated = matVec(c.matrix, loadAxis);
      strengthScore = 100 * (1 - Math.abs(rotated.z));
    }

    let score: number;
    switch (goal) {
      case "draft":
        score = 0.8 * layersScore + 0.2 * overhangScore;
        break;
      case "functional":
        score = strengthScore !== undefined
          ? 0.75 * strengthScore + 0.25 * overhangScore
          : 0.5 * overhangScore + 0.5 * heightScore;
        break;
      case "quality":
      default:
        score = 0.6 * overhangScore + 0.4 * bedContactScore;
        break;
    }
    score = clamp(score, 0, 100);

    // PRINTABILITY GATE — applies to every goal, not just quality's own
    // bedContactScore term. A pose that only grazes the bed on a sliver
    // (or not at all) isn't printable regardless of how good its overhang
    // or layer-count numbers look: nothing holds it down, so the nozzle
    // knocks it loose almost immediately. Below the threshold the score is
    // capped hard and then scaled toward 0 as contact shrinks toward
    // nothing, so (a) any candidate with real contact always outranks one
    // without, and (b) IF every candidate is unstable (a genuinely
    // needle-like part), the least-precarious one is still preferred over
    // an arbitrary tie.
    const unstable = c.bedContactMm2 < MIN_BED_CONTACT_MM2;
    if (unstable) {
      score = Math.min(score, 10) * (c.bedContactMm2 / MIN_BED_CONTACT_MM2);
    }
    score = Math.round(score);

    return {
      rotXDeg: c.rotXDeg,
      rotYDeg: c.rotYDeg,
      rotZDeg: c.rotZDeg,
      sizeX: round2(c.sizeX),
      sizeY: round2(c.sizeY),
      sizeZ: round2(c.sizeZ),
      overhangAreaMm2: round2(c.overhangAreaMm2),
      bedContactMm2: round2(c.bedContactMm2),
      layerCount: c.layerCount,
      score,
      rationale: buildRationale(c, goal, {
        supportThresholdDeg,
        layerHeightMm,
        loadAxis,
        strengthScore,
        isFewestLayers: c.layerCount === Math.min(...evaluated.map((e) => e.layerCount)),
        isLeastOverhang: c.overhangAreaMm2 <= maxOverhang * 0.001,
        isBiggestContact: c.bedContactMm2 >= maxBedContact * 0.999,
        unstable,
      }),
    };
  });

  // Stable sort (guaranteed by spec since ES2019) — ties keep generation
  // order, and the identity pose is always generated first, so a part with
  // no clearly-better alternative naturally keeps its as-imported pose.
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const keptAsImported =
    Math.abs(best.rotXDeg) < 0.01 && Math.abs(best.rotYDeg) < 0.01 && Math.abs(best.rotZDeg) < 0.01;

  return {
    best,
    candidates: scored.slice(0, Math.min(12, maxCandidates)),
    keptAsImported,
  };
}

/** The 6 axis-aligned "which face is down" poses, plus up to
 *  (maxCandidates - 6) poses that lay a large flat face on the bed —
 *  deduplicated against poses already covered. */
/** Above this, scoring samples rather than reading every triangle. 60k is far
 *  more than enough to characterise a shape's overhangs and footprint, and
 *  keeps the pass well under a second even on a very detailed model. */
const SCORING_TRIANGLE_LIMIT = 60_000;

/**
 * Evenly-spaced sample of a mesh, for pose scoring only.
 *
 * Even spacing (rather than a random draw) matters: it keeps the sample
 * spread across the whole model instead of clumping, which is what makes the
 * sampled areas track the real ones. The full mesh is still used for the
 * bounding box and flat-face detection, so the chosen pose is exact.
 */
function sampleForScoring(triangles: Triangle[]): Triangle[] {
  if (triangles.length <= SCORING_TRIANGLE_LIMIT) return triangles;
  const stride = triangles.length / SCORING_TRIANGLE_LIMIT;
  const out: Triangle[] = new Array(SCORING_TRIANGLE_LIMIT);
  for (let i = 0; i < SCORING_TRIANGLE_LIMIT; i++) {
    out[i] = triangles[Math.floor(i * stride)];
  }
  return out;
}

function generateCandidateSpecs(flatFaces: FlatFace[], maxCandidates: number): CandidateSpec[] {
  const AXIS_EULERS: Array<[number, number, number]> = [
    [0, 0, 0],
    [180, 0, 0],
    [90, 0, 0],
    [-90, 0, 0],
    [0, 90, 0],
    [0, -90, 0],
  ];
  const specs: CandidateSpec[] = AXIS_EULERS.map(([rx, ry, rz]) => ({
    matrix: eulerToMatrix(rx, ry, rz),
    source: "axis",
  }));

  const dedupeCos = Math.cos((DEDUPE_ANGLE_DEG * Math.PI) / 180);
  const usedDownDirs: Vec3[] = specs.map((s) => downDirectionOf(s.matrix));

  for (const face of flatFaces) {
    if (specs.length >= maxCandidates) break;
    const matrix = matFromToRotation(face.normal, DOWN);
    const downDir = downDirectionOf(matrix);
    if (usedDownDirs.some((d) => dot(d, downDir) > dedupeCos)) continue;
    usedDownDirs.push(downDir);
    specs.push({ matrix, source: "flat-face", faceAreaMm2: face.areaMm2 });
  }

  return specs.slice(0, maxCandidates);
}

/** The mesh-space direction that ends up pointing straight down once
 *  `matrix` is applied — i.e. M^-1 * DOWN, which for an orthonormal
 *  rotation is just M^T * DOWN. Used only to de-duplicate candidates that
 *  would produce the same physical pose. */
function downDirectionOf(matrix: Mat3): Vec3 {
  const mt: Mat3 = [
    matrix[0], matrix[3], matrix[6],
    matrix[1], matrix[4], matrix[7],
    matrix[2], matrix[5], matrix[8],
  ];
  return matVec(mt, DOWN);
}

interface RawCandidateMetrics {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  overhangAreaMm2: number;
  bedContactMm2: number;
  layerCount: number;
}

/**
 * Rotate every triangle by `matrix` and compute the four ground facts a pose
 * is scored on. Two passes over the triangle list (bbox, then areas) rather
 * than materializing a transformed copy of the mesh, so evaluating many
 * candidates against a large mesh stays O(1) extra memory per candidate.
 */
function evaluateCandidate(
  triangles: Triangle[],
  matrix: Mat3,
  thresholdRad: number,
  layerHeightMm: number,
): RawCandidateMetrics {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      const p = matVec(matrix, v);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (!Number.isFinite(minX)) {
    return { sizeX: 0, sizeY: 0, sizeZ: 0, overhangAreaMm2: 0, bedContactMm2: 0, layerCount: 0 };
  }

  // Overhang test: a downward-facing triangle needs support once its
  // steepness from vertical exceeds the threshold. Deriving the condition:
  // let the "overhang angle from vertical" of a surface be 90 - angle(normal,
  // vertical axis) (a vertical WALL has a horizontal normal -> 0 deg
  // overhang; a horizontal CEILING has a vertical normal -> 90 deg overhang,
  // the worst case). That inequality simplifies to -normal.z > sin(threshold)
  // — verified against the existing threshold convention in prusaslicer.ts
  // (threshold 0 = flag anything downward-facing / most aggressive
  // "automatic" support; threshold 90 = sin(90)=1, an impossible bar, i.e.
  // "no supports", matching that file's own "90 = none" comment exactly).
  //
  // BED-CONTACT FACES ARE NOT OVERHANGS. A triangle flush with the bed has
  // normal.z = -1, which trivially exceeds any support threshold — but it is
  // resting ON the build plate, not hanging in mid-air over nothing. Support
  // material is generated for downward faces with a GAP underneath, never
  // for the bed-facing skin itself. So bed contact is decided FIRST, and a
  // triangle counted there is explicitly excluded from the overhang sum
  // (previously both sums used the same `n.z < 0` triangles independently,
  // which double-counted every bed-resting face as "will need support" —
  // e.g. a part lying perfectly flat was scored as if its entire footprint
  // overhung, which is backwards).
  const overhangSin = Math.sin(thresholdRad);
  // How close to the lowest point still counts as touching the bed.
  //
  // This was 0.001mm, which no real mesh satisfies: a model's bottom is rarely
  // planar to a micron, and any small feature slightly lower sets minZ for the
  // whole part. On a real 269mm laptop-stand bar, a 5,697mm² flat bottom was
  // counted as OVERHANG rather than bed contact, giving the correct flat pose a
  // score of 0 — so Slicely stood the bar on end, 224mm tall, on 4.8mm² of
  // contact. A face within roughly one first layer of the bed is touching it,
  // and that is the physical question being asked here.
  const BED_EPS_MM = 0.25;
  let overhangAreaMm2 = 0;
  let bedContactMm2 = 0;
  for (const t of triangles) {
    const a = matVec(matrix, t.a);
    const b = matVec(matrix, t.b);
    const c = matVec(matrix, t.c);
    const n = matVec(matrix, t.normal);
    if (n.z >= -1e-9) continue; // upward/vertical faces never overhang or touch the bed from below
    const projArea = xyProjectedArea(a, b, c);
    const restsOnBed =
      n.z < -0.5 && a.z - minZ <= BED_EPS_MM && b.z - minZ <= BED_EPS_MM && c.z - minZ <= BED_EPS_MM;
    if (restsOnBed) {
      bedContactMm2 += projArea;
    } else if (-n.z > overhangSin + 1e-9) {
      overhangAreaMm2 += projArea;
    }
  }

  const sizeZ = maxZ - minZ;
  // Tiny epsilon guards against a pathological case: the axis-aligned
  // candidates rotate through Math.cos(90deg-in-radians), which isn't
  // exactly 0 in floating point (~6e-17) — for a height that lands EXACTLY
  // on a layer-height multiple, that noise can push sizeZ a few ULPs past
  // the boundary and silently add one extra layer to the count.
  const layerCount = layerHeightMm > 0 ? Math.max(1, Math.ceil(sizeZ / layerHeightMm - 1e-9)) : 1;
  return { sizeX: maxX - minX, sizeY: maxY - minY, sizeZ, overhangAreaMm2, bedContactMm2, layerCount };
}

/** Area of a triangle projected onto the XY plane (the shoelace formula via
 *  the z-component of the cross product). Used for both overhang and
 *  bed-contact area since both are "how much horizontal area does this
 *  downward face cover", not the 3D face area. */
function xyProjectedArea(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
}

interface RationaleCtx {
  supportThresholdDeg: number;
  layerHeightMm: number;
  loadAxis?: Vec3;
  strengthScore?: number;
  isFewestLayers: boolean;
  isLeastOverhang: boolean;
  isBiggestContact: boolean;
  unstable: boolean;
}

function buildRationale(c: CandidateMetrics, goal: PrintGoal, ctx: RationaleCtx): string[] {
  const out: string[] = [];

  if (ctx.unstable) {
    out.push(
      c.bedContactMm2 < 1e-6
        ? "Doesn't touch the bed at all in this pose — not printable."
        : `Only ~${fmt(c.bedContactMm2)} mm² touches the bed — a knife-edge contact that won't adhere or stay put; not recommended even though other metrics look good.`,
    );
  }

  // Lead with WHAT THE POSE ACHIEVES, not the angles used to get there. This
  // line is what the job summary shows, and "Rotated X 90°, Y 0° from the
  // imported pose" tells the reader nothing they can judge — the footprint it
  // puts on the bed and the height it prints at are the decision.
  const footprint = `${fmt(c.sizeX)} x ${fmt(c.sizeY)} mm`;
  const height = `${fmt(c.sizeZ)} mm tall`;
  if (c.rotXDeg === 0 && c.rotYDeg === 0 && c.rotZDeg === 0) {
    out.push(`Kept as modelled — ${footprint} footprint, ${height}.`);
  } else if (c.source === "flat-face" && c.faceAreaMm2) {
    out.push(`Laid a flat face down — ${footprint} footprint, ${height}.`);
  } else {
    out.push(`Turned to sit ${footprint} on the bed, ${height}.`);
  }

  if (c.overhangAreaMm2 < 1) {
    out.push(`No overhangs beyond ${ctx.supportThresholdDeg}° from vertical — should print without supports.`);
  } else if (ctx.isLeastOverhang) {
    out.push(`Least overhang of the candidates evaluated (~${fmt(c.overhangAreaMm2)} mm²) — minimal support needed.`);
  } else {
    out.push(`~${fmt(c.overhangAreaMm2)} mm² of downward-facing area will need support.`);
  }

  if (ctx.isBiggestContact && c.bedContactMm2 > 0) {
    out.push(`${fmt(c.bedContactMm2)} mm² touching the bed — the largest, most stable footprint of the candidates.`);
  }

  if (goal === "draft") {
    out.push(
      ctx.isFewestLayers
        ? `${c.layerCount} layers at ${ctx.layerHeightMm} mm — fewest of the candidates, so the fastest print.`
        : `${c.layerCount} layers at ${ctx.layerHeightMm} mm.`,
    );
  }

  if (goal === "functional" && ctx.loadAxis && ctx.strengthScore !== undefined) {
    out.push(
      ctx.strengthScore > 70
        ? "Keeps the load direction within the layers, not across them — the strongest arrangement against layer-bond failure."
        : "The load direction runs partly across the layer stack — some risk of splitting along layer lines under load.",
    );
  }

  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// The `+ 0` normalizes a -0 result (e.g. Math.round(-0 * 10) / 10 === -0) to
// +0 — IEEE754 addition defines -0 + 0 === +0, which JSON/assert.equal treat
// as plain "0" instead of the surprising "-0". Real negative angles/sizes
// are untouched (adding 0 to -90 is still -90).
function round1(n: number): number {
  return Math.round(n * 10) / 10 + 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100 + 0;
}

function fmt(n: number): string {
  return n.toFixed(0);
}
