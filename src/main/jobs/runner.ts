// Slice a planned job's plates in order, streaming progress as JobEvents.
// The one rule that matters most here: A SINGLE FAILED PLATE MUST NOT ABORT
// THE JOB. Plates already packed by planner.ts are independent PrusaSlicer
// invocations — one bad STL (non-manifold enough to trip a fatal validation
// error even after prusaslicer.ts's own auto-remediation) shouldn't cost the
// user every other plate that would have sliced fine.
//
// NOTE on how a plate is actually sliced: planner.ts already did the
// packing (via plates.ts), so each JobPlate is one bed's worth of parts with
// known copy counts. We call prusaslicer.ts's low-level `slice()` directly
// (primary + `extraInputs` + `merge`) rather than its `slicePlates()`
// convenience wrapper, because slicePlates() re-packs from scratch AND (read
// closely: it builds `extraInputs` from the DEDUPED set of other parts, so a
// plate with 3 copies of a non-primary part would only place 1). Since we
// already have the exact per-plate copy counts, we expand them ourselves
// into a flat, correctly-repeated input list.

import type { JobEvent, JobPart, JobPlate, PrintJob } from "../../shared/jobs";
import type { SliceMetrics, SliceParams, PrintMaterial } from "../../shared/types";
import { slice } from "../prusaslicer";
import { sessionSlicesDir } from "../session-context";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseMesh, type Triangle } from "./mesh";
import { eulerToMatrix, matVec } from "./vec3";
import { writeThreeMf, type ThreeMfPart } from "./threemf";
import { synthesizeMultiMaterialConfig, distinctExtruders } from "./multimaterial";
import { synthesizeConfigForGeometry } from "../profiles";
import { insertColourChanges, bandsToChanges } from "./colourchange";

/** Job ids with a cancellation request in flight. Checked between plates
 *  (never mid-slice — PrusaSlicer's CLI has no cooperative cancellation
 *  hook, so the soonest we can honestly stop is the next plate boundary). */
const cancelledJobs = new Set<string>();

export function requestCancel(jobId: string): void {
  cancelledJobs.add(jobId);
}

function isCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

/** Injectable for tests: the default slices for real via PrusaSlicer.
 *  Swapping this out is the only way to exercise runJob's control flow
 *  (retry/continue-on-failure, cancellation, totals) without a PrusaSlicer
 *  install or a network — the brief for this module requires hermetic
 *  tests, and Node's test runner has no built-in module-mocking we can rely
 *  on across versions. */
export type SliceFn = (
  stlPath: string,
  params?: SliceParams,
  configIni?: string,
  outName?: string,
) => Promise<SliceMetrics>;

export interface RunJobDeps {
  sliceFn?: SliceFn;
}

export async function runJob(
  job: PrintJob,
  onEvent?: (e: JobEvent) => void,
  deps: RunJobDeps = {},
): Promise<PrintJob> {
  const doSlice = deps.sliceFn ?? slice;
  const emit = (e: JobEvent) => onEvent?.(e);
  const touch = () => {
    job.updatedAt = new Date().toISOString();
  };

  let anyFailed = false;
  let cancelled = false;

  for (const plate of job.plates) {
    if (isCancelled(job.id)) {
      cancelled = true;
      break;
    }
    if (plate.status === "done" || plate.status === "ready") continue; // resume support

    plate.status = "slicing";
    touch();
    emit({ type: "plate_start", jobId: job.id, plateIndex: plate.index });

    try {
      const metrics = await sliceOnePlate(plate, job, doSlice);
      applyColourBands(plate, job, metrics);
      plate.status = "ready";
      plate.metrics = metrics;
      plate.gcodePath = metrics.gcodePath;
      plate.error = undefined;
      touch();
      emit({ type: "plate_done", jobId: job.id, plateIndex: plate.index, metrics });
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      plate.status = "failed";
      plate.error = message;
      touch();
      emit({ type: "plate_failed", jobId: job.id, plateIndex: plate.index, error: message });
      // Deliberately no `break`/`throw` — continue to the next plate.
    }
  }

  cancelledJobs.delete(job.id);
  applyTotals(job);
  touch();

  if (cancelled) {
    job.status = "cancelled";
    // JobEvent has no dedicated "cancelled" variant; job_failed is the
    // closest terminal signal a listener can rely on to stop waiting.
    emit({ type: "job_failed", jobId: job.id, error: "Cancelled by user." });
  } else if (job.plates.length === 0) {
    // Nothing was ever placed — every part was too big for the bed. Reporting
    // "ready" here was actively misleading: it claimed success for a job that
    // produced no G-code at all.
    job.status = "failed";
    const names = (job.oversized ?? []).map((p) => p.name).join(", ");
    emit({
      type: "job_failed",
      jobId: job.id,
      error: names
        ? `Nothing could be placed: ${names} ${
            (job.oversized ?? []).length === 1 ? "is" : "are"
          } too large for this printer's bed. Scale down, split the model, or pick a bigger printer.`
        : "Nothing could be placed on a plate.",
    });
  } else if (anyFailed) {
    const failedCount = job.plates.filter((p) => p.status === "failed").length;
    job.status = "failed";
    emit({
      type: "job_failed",
      jobId: job.id,
      error: `${failedCount} of ${job.plates.length} plate(s) failed to slice.`,
    });
  } else {
    job.status = "ready";
    emit({ type: "job_done", job });
  }

  return job;
}

async function sliceOnePlate(
  plate: JobPlate,
  job: PrintJob,
  doSlice: SliceFn,
): Promise<SliceMetrics> {
  if (plate.parts.length === 0) {
    throw new Error(`Plate ${plate.index} has no parts.`);
  }
  const primary = plate.parts[0];
  // File-existence is validated by the slicer function itself (the real
  // prusaslicer.ts `slice()` already throws a clear "Model file not found"
  // before spawning anything) — checking it again here would just duplicate
  // that, and would fight the `sliceFn` injection tests rely on.

  // Flatten every part's copies into one path per physical instance, then
  // pull out exactly ONE instance of the primary — the rest (including any
  // extra copies of the primary itself) become `extraInputs`.
  const flat: string[] = [];
  for (const p of plate.parts) {
    for (let i = 0; i < p.copies; i++) flat.push(p.path);
  }
  const primaryIdx = flat.indexOf(primary.path);
  if (primaryIdx >= 0) flat.splice(primaryIdx, 1);
  const extraInputs = flat;

  // ANY plate with more than one physical instance goes through a 3MF project.
  //
  // Passing several STLs to the CLI cannot work, in either mode:
  //   • Without --merge, PrusaSlicer loads each file as its own Model and
  //     re-exports them all to the SAME --output, so only the LAST part
  //     survives. Verified: slicing A+B produced byte-identical G-code to
  //     slicing B alone — part A vanished with no error at all.
  //   • With --merge it fuses everything into one object, which fails outright
  //     (exit -1) on real plates and destroys the per-part identity that
  //     colour assignment needs.
  // A 3MF holds many objects in ONE file, so the whole plate slices together,
  // every part survives, and each keeps its own extruder.
  const instances = plate.parts.reduce((n, p) => n + p.copies, 0);
  if (instances > 1) {
    return sliceMultiMaterialPlate(plate, job, doSlice);
  }

  const params: SliceParams = {
    ...job.params,
    ...primary.overrides,
    extraInputs,
    // Do NOT merge. --merge fuses every input into a single object, and
    // PrusaSlicer then fails the slice outright (exit -1) for these plates, so
    // multi-part jobs produced no G-code at all. It is also wrong in principle:
    // merging destroys the per-part identity that per-extruder colour
    // assignment depends on. Parts stay separate objects and the arranger
    // places them, which is what a plate is. `merge` remains available as an
    // explicit user request through jobParams.
    merge: job.params.merge,
  };

  // Slice against the JOB's printer, not PrusaSlicer's built-in default.
  //
  // This passed `undefined` for the config, so a single-part plate was sliced
  // against the stock 250x210 bed no matter which printer the user picked. A
  // 255mm part on a chosen 325x320 H2D bed was rejected with "nothing landed
  // on the bed" — the part fit the real printer perfectly.
  const configIni = job.bed
    ? synthesizeConfigForGeometry(
        "Slicely job printer",
        job.bed,
        job.params.nozzleDiameterMm ?? 0.4,
        job.material ?? "PLA",
        // One colour on this plate — show it, so opening the project in
        // PrusaSlicer looks like what the user asked for.
        plate.colours.length === 1 ? plate.colours[0] : undefined,
      ).path
    : undefined;
  const metrics = await doSlice(primary.path, params, configIni, outNameFor(plate, job));
  // Leave a project behind for this plate too, so opening it in PrusaSlicer is
  // the same action regardless of how many parts it holds — and so the colour
  // travels with it.
  try {
    const mesh = await parseMesh(primary.path);
    const projectPath = join(sessionSlicesDir(), `${outNameFor(plate, job)}.3mf`);
    writeThreeMf(
      projectPath,
      [
        {
          path: primary.path,
          triangles: orientedTriangles(mesh.triangles, primary, job.params.scale),
          extruder: 1,
          offset: { x: (job.bed?.x ?? 250) / 2, y: (job.bed?.y ?? 210) / 2, z: 0 },
        },
      ],
      [],
      readConfigText(configIni),
    );
    plate.projectPath = projectPath;
  } catch {
    // A missing project only costs the "open in PrusaSlicer" convenience.
  }
  return metrics;
}

/**
 * Insert filament swaps up the height of a plate, so a single part can print in
 * several colours without being painted.
 *
 * Runs after slicing because it rewrites the finished G-code: PrusaSlicer's CLI
 * ignores a project's custom_gcode_per_print_z entirely (see colourchange.ts).
 * Notes go on the plate so the user sees the heights the swaps actually landed
 * on, which are quantised to layer boundaries.
 */
function applyColourBands(plate: JobPlate, job: PrintJob, metrics: SliceMetrics): void {
  const bands = job.colourBands;
  if (!bands || bands.length < 2 || !metrics.gcodePath) return;

  const height = Math.max(...plate.parts.map((p) => p.sizeZ), 0);
  const changes = bandsToChanges(height, bands);
  if (changes.length === 0) return;

  try {
    const res = insertColourChanges(metrics.gcodePath, changes);
    const notes: string[] = [];
    if (res.inserted > 0) {
      notes.push(
        `${res.inserted} filament change${res.inserted === 1 ? "" : "s"} at ` +
          `${res.atZ.map((z) => `${z} mm`).join(", ")}. The printer pauses there — ` +
          `load the next colour and resume.`,
      );
    }
    if (plate.parts.length > 1) {
      notes.push(
        `Note: a filament change affects the whole plate, so all ` +
          `${plate.parts.length} parts on it change colour at those heights.`,
      );
    }
    if (res.skipped.length > 0) {
      notes.push(`${res.skipped.length} change(s) were above the model and skipped.`);
    }
    metrics.fixes = [...(metrics.fixes ?? []), ...notes];
  } catch {
    // A failed rewrite must not lose an otherwise good slice.
    metrics.fixes = [
      ...(metrics.fixes ?? []),
      "Could not add the filament changes to this plate's G-code.",
    ];
  }
}

/**
 * Apply a part's chosen orientation to its geometry.
 *
 * The planner picks a pose, reports it, and packs the plate using the rotated
 * footprint — so the geometry handed to the slicer has to match, or the layout
 * describes a plate that was never built.
 *
 * Normals are rotated too rather than recomputed: the rotation is rigid, so
 * they stay correct, and recomputing risks flipping any that were already
 * inward-facing in the source file.
 */
function orientedTriangles(
  triangles: Triangle[],
  part: JobPart,
  scale?: number,
): Triangle[] {
  const o = part.orientation;
  const m =
    o && (o.rotXDeg !== 0 || o.rotYDeg !== 0 || o.rotZDeg !== 0)
      ? eulerToMatrix(o.rotXDeg, o.rotYDeg, o.rotZDeg)
      : undefined;

  // Scale is applied to the GEOMETRY as well as to the sizes the planner packs
  // with. Scaling only the numbers would lay out a plate for a part the slicer
  // never receives.
  const k = scale && scale > 0 ? scale : 1;
  const put = (v: { x: number; y: number; z: number }) =>
    m ? matVec(m, { x: v.x * k, y: v.y * k, z: v.z * k }) : { x: v.x * k, y: v.y * k, z: v.z * k };

  const placed =
    m || k !== 1
      ? triangles.map((t) => ({
          a: put(t.a),
          b: put(t.b),
          c: put(t.c),
          // Scaling uniformly leaves directions unchanged; only rotation matters.
          normal: m ? matVec(m, t.normal) : t.normal,
        }))
      : triangles;

  // Move the result to a known origin: centred in XY, sitting ON the bed.
  //
  // A model's own coordinates are arbitrary — this part's bounding box starts
  // at x=-54, y=-24 — and rotating moves them somewhere else again. The plate
  // layout positions each object by its centre, so without this the offsets
  // are applied to geometry that is already somewhere else entirely and every
  // part lands off the bed ("nothing landed on the bed").
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const t of placed) {
    for (const v of [t.a, t.b, t.c]) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
  }
  const dx = -(minX + maxX) / 2;
  const dy = -(minY + maxY) / 2;
  const dz = -minZ;
  const shift = (v: { x: number; y: number; z: number }) => ({
    x: v.x + dx,
    y: v.y + dy,
    z: v.z + dz,
  });
  return placed.map((t) => ({
    a: shift(t.a),
    b: shift(t.b),
    c: shift(t.c),
    normal: t.normal,
  }));
}

function outNameFor(plate: JobPlate, job: PrintJob): string {
  // The job id is part of the name because a session slices more than once and
  // every job has a plate 1. Sharing "plate-1.gcode" meant the second job
  // overwrote the first's output in place — and since the first job's download
  // token still pointed at that path, asking for the earlier plate handed back
  // the later job's G-code.
  return `plate-${plate.index}-${job.id.slice(0, 8)}`;
}

/**
 * Slice a plate that uses more than one extruder.
 *
 * Writes a 3MF carrying each part's extruder assignment plus a matching
 * multi-extruder config, then slices that. Objects get explicit positions
 * because a 3MF build item must state one — the CLI's arranger does not run for
 * a project file. The packer has already proven the plate fits, so this only
 * has to lay the instances out without overlapping them.
 */
async function sliceMultiMaterialPlate(
  plate: JobPlate,
  job: PrintJob,
  doSlice: SliceFn,
): Promise<SliceMetrics> {
  const bed = job.bed ?? { x: 250, y: 210, z: 210 };
  const nozzleMm = job.params.nozzleDiameterMm ?? 0.4;
  const material: PrintMaterial = job.material ?? "PLA";

  // Each extruder takes the colour of the part assigned to it. A gap here is
  // left UNDEFINED rather than filled with white: an extruder whose parts
  // carry no colour is one nobody has said anything about, and writing
  // "#FFFFFF" into the config turned that silence into an explicit white
  // plate. Only the multi-extruder config below, which must state a value per
  // extruder, substitutes anything — and only for slots this plate never uses.
  const extruders = distinctExtruders(plate.parts);
  const colours: Array<string | undefined> = [];
  for (const e of extruders) {
    const owner = plate.parts.find((p) => (p.extruder ?? 1) === e && p.colourHex);
    colours[e - 1] = owner?.colourHex;
  }

  // Place each instance where the PACKER put it. That layout is the one proven
  // to fit; re-deriving positions here with a second algorithm is how a plate
  // ends up describing an arrangement that was never checked.
  const threeMfParts: ThreeMfPart[] = [];
  let fallbackX = 10;
  for (const part of plate.parts) {
    const mesh = await parseMesh(part.path);
    // Apply the pose the planner chose. Without this the 3MF carries the
    // ORIGINAL geometry while the packer laid the plate out using the ROTATED
    // footprint, so parts sit on a bed they don't actually fit — the
    // orientation pass was reported to the user and then thrown away.
    const triangles = orientedTriangles(mesh.triangles, part, job.params.scale);
    for (let copy = 0; copy < part.copies; copy++) {
      const at = part.placements?.[copy];
      // The geometry is centred on the origin, so a lower-left footprint
      // corner becomes a centre by adding half the part's size.
      const centre = at
        ? { x: at.x + part.sizeX / 2, y: at.y + part.sizeY / 2 }
        : { x: fallbackX + part.sizeX / 2, y: bed.y / 2 };
      if (!at) fallbackX += part.sizeX + 8;
      threeMfParts.push({
        path: part.path,
        triangles,
        extruder: part.extruder ?? 1,
        offset: { x: centre.x, y: centre.y, z: 0 },
      });
    }
  }

  const outName = outNameFor(plate, job);
  // Kept, not thrown into a temp file: this project IS the arranged, coloured
  // plate, and opening it in PrusaSlicer is the natural way to check the
  // layout and supports before committing hours of printing.
  const projectPath = join(sessionSlicesDir(), `${outName}.3mf`);
  // A plate can hold several parts and still need only one colour, and the
  // multi-material config has a floor of two extruders (the wipe tower needs
  // somewhere to purge to). Handing that to a single-colour plate opens the
  // project as a two-spool printer carrying a phantom white filament. Use the
  // plain single-extruder config when one colour is all this plate needs.
  const configIni =
    extruders.length > 1
      ? synthesizeMultiMaterialConfig({
          bed,
          nozzleMm,
          material,
          // Per-extruder vectors must have an entry for every extruder, so an
          // unused or uncoloured slot gets a neutral placeholder HERE, where it
          // means "this spool is not part of the plan" — never as a stand-in
          // for a colour a part was supposed to have.
          colours: colours.map((c) => c ?? "#FFFFFF"),
        })
      : synthesizeConfigForGeometry(
          "Slicely job printer",
          bed,
          nozzleMm,
          material,
          colours[0],
        ).path;
  writeThreeMf(projectPath, threeMfParts, [], readConfigText(configIni));
  plate.projectPath = projectPath;

  // The 3MF already carries geometry, placement, and extruder assignment, so
  // extraInputs / arrange / merge would fight it.
  const params: SliceParams = {
    layerHeightMm: job.params.layerHeightMm,
    fillDensityPct: job.params.fillDensityPct,
    fillPattern: job.params.fillPattern,
    perimeters: job.params.perimeters,
    supportMaterial: job.params.supportMaterial,
    brimWidthMm: job.params.brimWidthMm,
  };
  return doSlice(projectPath, params, configIni, outName);
}

/** The text of a synthesized config, or undefined if it can't be read. A
 *  project without its settings still opens — it just shows the user's own
 *  profile instead of the one Slicely sliced against. */
function readConfigText(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Sum whatever's known from completed plates into job.totals. Slice-derived
 *  fields (time/filament) only exist once a plate has metrics; toolChanges
 *  is carried over from the colour plan computed at plan time (slicing
 *  doesn't change it). */
function applyTotals(job: PrintJob): void {
  const done = job.plates.filter((p) => p.metrics);
  const filamentG = sumOptional(done.map((p) => p.metrics?.filamentUsedG));
  const filamentCost = sumOptional(done.map((p) => p.metrics?.filamentCost));
  const minutes = sumOptional(done.map((p) => parseDurationToMinutes(p.metrics?.estimatedPrintTime)));

  job.totals = {
    plateCount: job.plates.length,
    partCount: job.totals?.partCount ?? job.plates.reduce((s, p) => s + p.parts.reduce((s2, jp) => s2 + jp.copies, 0), 0),
    toolChanges: job.totals?.toolChanges ?? job.colourPlan?.toolChanges,
    filamentG,
    filamentCost,
    estimatedMinutes: minutes,
  };
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a + b, 0);
}

/** Parse PrusaSlicer's "estimated printing time" comment, e.g.
 *  "1d 2h 3m 4s" or "23m 45s", into whole minutes. Undefined for anything
 *  that doesn't contain at least one recognizable unit. */
export function parseDurationToMinutes(text?: string): number | undefined {
  if (!text) return undefined;
  const re = /(\d+)\s*d|(\d+)\s*h|(\d+)\s*m(?!s)|(\d+)\s*s/g;
  let totalSeconds = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    matched = true;
    if (m[1]) totalSeconds += Number(m[1]) * 86400;
    else if (m[2]) totalSeconds += Number(m[2]) * 3600;
    else if (m[3]) totalSeconds += Number(m[3]) * 60;
    else if (m[4]) totalSeconds += Number(m[4]);
  }
  return matched ? Math.round(totalSeconds / 60) : undefined;
}
