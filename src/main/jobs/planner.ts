// Turn a flat list of parts into a fully packed, coloured, ready-to-slice
// PrintJob. This is the orchestration layer: it doesn't invent any new
// geometry or packing logic of its own — it calls mesh.ts/orientation.ts to
// choose a pose, colour.ts to resolve extruders, and plates.ts (UNMODIFIED,
// per its own header) to do the actual bin-packing.
//
// Pipeline, in order:
//   1. inspect every part            (prusaslicer.getModelInfo — fast, no
//                                      full mesh parse needed for this step)
//   2. orient every part              (mesh.ts + orientation.ts — only when
//                                      opts.autoOrient, since it's the
//                                      expensive step: full triangle parse)
//   3. derive job-wide slice params   (prusaslicer.recommendForPlate, unless
//                                      the caller supplied its own)
//   4. resolve the colour plan        (colour.ts, against opts.slots)
//   5. pack onto plates               (plates.ts packPlates — grouped by
//                                      colour first when opts.groupByColour,
//                                      so each plate needs the fewest tool
//                                      changes)
//   6. flag anything that fits no plate (too tall, or too big even alone)
//   7. total up what's known at plan time (slice-derived totals — time,
//                                      filament weight/cost — are filled in
//                                      by runner.ts once plates are sliced)

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  JobPart,
  JobPlanOptions,
  JobPlate,
  JobTotals,
  PrintJob,
} from "../../shared/jobs";
import type { ModelInfo, PrintGoal, PrintMaterial, SliceParams } from "../../shared/types";
import { getModelInfo, recommendForPlate } from "../prusaslicer";
import { DEFAULT_SPACING, packPlates, type BedArea, type Plate, type PlatePart } from "../plates";
import { parseMesh } from "./mesh";
import { chooseOrientation } from "./orientation";
import { planColours } from "./colour";

export interface PlanJobInput {
  path: string;
  copies?: number;
  colourHex?: string;
}

export interface PlanJobOptions extends JobPlanOptions {
  name?: string;
  goal?: PrintGoal;
  material?: PrintMaterial;
  params?: SliceParams;
}

/** Injectable for tests: default inspects via the real PrusaSlicer CLI
 *  (prusaslicer.getModelInfo), which the P3 brief requires tests NOT invoke.
 *  Swapping this in a test avoids needing a PrusaSlicer install while still
 *  exercising the real packing/colour/orientation orchestration below. */
export interface PlanJobDeps {
  getModelInfo?: (path: string) => Promise<ModelInfo>;
}

/** Below this, a part's largest dimension is almost certainly a unit-conversion
 *  mistake in the source file rather than an intentional miniature. 5 mm is
 *  comfortably under any real printed part while still catching cm/inch
 *  imports, which land 10-25x too small. */
/**
 * Should each colour get its own plate?
 *
 * An explicit choice always wins — a user asking to "put the black parts on one
 * plate and the blue on another" must get exactly that, and one asking to print
 * them together must too. With no explicit choice, follow the hardware: a
 * printer with two or more loaded slots (AMS/MMU) swaps filament itself
 * mid-print, so mixing colours on one plate is the point of it; a
 * single-extruder printer needs single-colour plates, because there the "tool
 * change" is the user swapping a spool between plates.
 *
 * A job using only one colour is never split.
 */
export function shouldGroupByColour(input: {
  distinctColours: number;
  usableSlots: number;
  explicit?: boolean;
}): boolean {
  if (input.distinctColours <= 1) return false;
  if (typeof input.explicit === "boolean") return input.explicit;
  return input.usableSlots < 2;
}

export const MIN_PLAUSIBLE_PART_MM = 5;

/**
 * Warn about parts small enough that the file's units are probably wrong.
 *
 * Without this a 1.7 mm speck is placed on the plate with no comment, and the
 * user only finds out after printing it. Exported so the rule can be tested
 * without invoking PrusaSlicer.
 *
 * Returns undefined when every part is a plausible size.
 */
export function tinyPartsNote(parts: JobPart[]): string | undefined {
  const tiny = parts.filter(
    (p) => Math.max(p.sizeX, p.sizeY, p.sizeZ) < MIN_PLAUSIBLE_PART_MM,
  );
  if (tiny.length === 0) return undefined;
  const names = tiny
    .map(
      (p) =>
        `"${p.name}" (${p.sizeX.toFixed(1)} x ${p.sizeY.toFixed(1)} x ${p.sizeZ.toFixed(1)} mm)`,
    )
    .join(", ");
  return (
    `${tiny.length === 1 ? "One part is" : `${tiny.length} parts are`} smaller than ` +
    `${MIN_PLAUSIBLE_PART_MM} mm: ${names}. That usually means the file's units are ` +
    `wrong (authored in cm or inches). Scale it up before printing, or it will come ` +
    `out as a speck.`
  );
}

export async function planJob(
  parts: PlanJobInput[],
  opts: PlanJobOptions,
  deps: PlanJobDeps = {},
): Promise<PrintJob> {
  if (parts.length === 0) {
    throw new Error("planJob requires at least one part.");
  }
  const inspect = deps.getModelInfo ?? getModelInfo;

  const goal: PrintGoal = opts.goal ?? "quality";
  const material: PrintMaterial = opts.material ?? "PLA";
  const autoOrient = opts.autoOrient ?? true;
  const notes: string[] = [];

  // ── 1. Inspect every part ────────────────────────────────────────────────
  const report = opts.onProgress ?? (() => undefined);
  report({ stage: "inspecting", index: 0, total: parts.length });
  const infos = await Promise.all(parts.map((p) => inspect(p.path)));

  // ── 3a. Derive params EARLY (orientation's layer-count scoring wants a
  //        real layer height, not a guess) ────────────────────────────────
  const params: SliceParams = opts.params ?? recommendForPlate(infos, { goal, material }).params;
  if (!opts.params) {
    notes.push(
      `No slice settings supplied — derived defaults for a ${material} ${goal} print (${params.layerHeightMm} mm layers).`,
    );
  }

  // ── 2. Orient each part (optional, and per-part best-effort) ────────────
  const draftParts: Array<{
    input: PlanJobInput;
    info: Awaited<ReturnType<typeof getModelInfo>>;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    orientation?: JobPart["orientation"];
  }> = [];

  for (let i = 0; i < parts.length; i++) {
    const input = parts[i];
    const info = infos[i];
    const name = basename(input.path);
    // Per part, because this is the slow step: parsing a detailed mesh and
    // scoring every candidate pose against it takes seconds each.
    report({
      stage: autoOrient ? "orienting" : "inspecting",
      index: i + 1,
      total: parts.length,
      partName: name,
    });
    let sizeX = info.sizeX;
    let sizeY = info.sizeY;
    let sizeZ = info.sizeZ;
    let orientation: JobPart["orientation"];

    if (autoOrient) {
      try {
        const mesh = await parseMesh(input.path);
        const result = chooseOrientation(mesh.triangles, {
          // Reuse what parseMesh already computed rather than repeating a
          // full pass over the triangles.
          mesh,
          goal,
          layerHeightMm: params.layerHeightMm,
          supportThresholdDeg: params.supportThresholdDeg,
        });
        orientation = result.best;
        if (result.keptAsImported) {
          notes.push(`"${name}": as-imported orientation was already best — kept unrotated.`);
        } else {
          sizeX = result.best.sizeX;
          sizeY = result.best.sizeY;
          sizeZ = result.best.sizeZ;
          notes.push(
            `"${name}": reoriented (X ${result.best.rotXDeg}°, Y ${result.best.rotYDeg}°) — ${result.best.rationale[0] ?? "better pose found"}`,
          );
        }
      } catch (err) {
        notes.push(
          `"${name}": couldn't analyze geometry for orientation (${err instanceof Error ? err.message : String(err)}) — using the as-imported pose.`,
        );
      }
    }

    draftParts.push({ input, info, sizeX, sizeY, sizeZ, orientation });
  }

  // ── Build JobPart[] (one entry per distinct input part) ─────────────────
  const jobParts: JobPart[] = draftParts.map((d) => ({
    path: d.input.path,
    name: basename(d.input.path),
    copies: d.input.copies && d.input.copies > 0 ? Math.round(d.input.copies) : 1,
    sizeX: d.sizeX,
    sizeY: d.sizeY,
    sizeZ: d.sizeZ,
    volumeMm3: d.info.volumeMm3,
    orientation: d.orientation,
    colourHex: d.input.colourHex,
  }));

  // ── 4. Colour plan ───────────────────────────────────────────────────────
  report({ stage: "colouring", index: 0, total: parts.length });
  const colourPlan = planColours(jobParts, opts.slots ?? []);
  // Apply POSITIONALLY: planColours returns exactly one assignment per input
  // part, in order. Keying by file path collided whenever the same STL was
  // requested in two colours — the last assignment overwrote the first, so
  // asking for three red cubes and two yellow ones produced five of whichever
  // colour resolved last, even when the requested colour was loaded.
  colourPlan.assignments.forEach((a, i) => {
    const p = jobParts[i];
    if (!p) return;
    p.extruder = a.extruder;
    p.colourHex = a.colourHex;
  });
  // Colour warnings live on colourPlan and are surfaced from there — by the UI
  // with a paint icon, and by the plan_job tool as "Colour notes". Copying them
  // into `notes` as well showed every one of them twice.

  // ── 6a. Height-oversized parts never reach the packer ───────────────────
  const maxHeightMm = opts.maxHeightMm;
  const tooTall = maxHeightMm ? jobParts.filter((p) => p.sizeZ > maxHeightMm) : [];
  const packable = maxHeightMm ? jobParts.filter((p) => p.sizeZ <= maxHeightMm) : jobParts;
  if (tooTall.length > 0) {
    notes.push(
      `${tooTall.length} part(s) exceed the ${maxHeightMm} mm height limit and were excluded from packing: ${tooTall.map((p) => p.name).join(", ")}.`,
    );
  }

  // ── 5. Pack (grouped by colour when requested/defaulted) ────────────────
  const distinctColours = new Set(packable.map((p) => p.colourHex ?? ""));
  // A printer with two or more loaded slots (AMS/MMU) changes filament on
  // its own MID-PLATE — putting several colours on one plate is the whole
  // point of it. Only a single-extruder printer benefits from one colour per
  // plate, where the "tool change" is the user swapping the spool by hand
  // between plates. Defaulting to grouped regardless defeated multi-colour
  // printing on exactly the machines that support it.
  const usableSlots = (opts.slots ?? []).filter((sl) => sl.loaded !== false).length;
  const multiMaterial = usableSlots >= 2;
  const groupByColour = shouldGroupByColour({
    distinctColours: distinctColours.size,
    usableSlots,
    explicit: opts.groupByColour,
  });

  const bed: BedArea = { w: opts.bed.x, d: opts.bed.y };
  const spacing = opts.spacingMm ?? DEFAULT_SPACING;

  report({ stage: "packing", index: 0, total: parts.length });
  const packedPlates: Plate[] = [];
  const packOversized: PlatePart[] = [];
  // Identity for packing: a part's position in `packable`. See toPlateParts.
  const indexOf = new Map(packable.map((p, i) => [p, i]));

  if (multiMaterial && distinctColours.size > 1 && opts.groupByColour !== true) {
    notes.push(
      `Printer has ${usableSlots} filament slots loaded, so colours share a plate — ` +
        `it swaps filament itself mid-print.`,
    );
  }

  if (groupByColour && distinctColours.size > 1) {
    const byColour = new Map<string, JobPart[]>();
    for (const p of packable) {
      const key = p.colourHex ?? "";
      const list = byColour.get(key);
      if (list) list.push(p);
      else byColour.set(key, [p]);
    }
    for (const group of byColour.values()) {
      const { plates, oversized } = packPlates(toPlateParts(group, indexOf), bed, spacing);
      packedPlates.push(...plates);
      packOversized.push(...oversized);
    }
    notes.push(
      `Grouped parts by colour across ${byColour.size} colour group(s) so each plate needs the fewest tool changes.`,
    );
  } else {
    const { plates, oversized } = packPlates(toPlateParts(packable, indexOf), bed, spacing);
    packedPlates.push(...plates);
    packOversized.push(...oversized);
  }

  // ── Build JobPlate[] ─────────────────────────────────────────────────────
  // NOTE: `plate.parts[].path` holds the packable INDEX, not a file path —
  // see toPlateParts. Two entries for the same STL in different colours are
  // genuinely different parts, and keying by file path merged them into one
  // (losing a colour). The index keeps them distinct.
  const jobPlates: JobPlate[] = packedPlates.map((plate, i) => {
    const counts = new Map<string, number>();
    for (const pp of plate.parts) counts.set(pp.path, (counts.get(pp.path) ?? 0) + 1);
    // Keep the packer's chosen positions, one entry per placed instance, so
    // the 3MF places parts exactly where the plate was proven to fit. Two
    // separate layout algorithms (one deciding grouping, one deciding
    // positions) could disagree about whether a plate actually fits.
    const placements = new Map<string, Array<{ x: number; y: number }>>();
    for (const pp of plate.parts) {
      const list = placements.get(pp.path) ?? [];
      if (pp.x !== undefined && pp.y !== undefined) list.push({ x: pp.x, y: pp.y });
      placements.set(pp.path, list);
    }
    const plateParts: JobPart[] = [...counts.entries()].map(([idx, copies]) => ({
      ...packable[Number(idx)],
      copies,
      placements: placements.get(idx),
    }));
    const colours = [...new Set(plateParts.map((p) => p.colourHex).filter((c): c is string => !!c))];
    return {
      index: i + 1,
      parts: plateParts,
      status: "planned",
      colours,
      rationale:
        colours.length <= 1
          ? `${plateParts.length} part${plateParts.length === 1 ? "" : "s"}${colours.length === 1 ? `, all colour ${colours[0]}` : ""} — no in-plate tool changes.`
          : `${plateParts.length} part${plateParts.length === 1 ? "" : "s"} across ${colours.length} colours.`,
    };
  });

  // ── 6b. Bed-footprint-oversized parts ────────────────────────────────────
  const oversizedCounts = new Map<string, number>();
  for (const pp of packOversized) oversizedCounts.set(pp.path, (oversizedCounts.get(pp.path) ?? 0) + 1);
  const oversizedFromPack: JobPart[] = [...oversizedCounts.entries()].map(([idx, copies]) => ({
    ...packable[Number(idx)],
    copies,
  }));
  // A part only a couple of millimetres across is nearly always a UNIT error in
  // the source file (an STL authored in cm or inches, imported as mm), not a
  // deliberate choice. Slicely would otherwise place a 1.7 mm speck on the
  // plate without comment and the user would only find out after printing.
  const tinyNote = tinyPartsNote(jobParts);
  if (tinyNote) notes.push(tinyNote);

  const oversized = [...oversizedFromPack, ...tooTall];
  if (oversizedFromPack.length > 0) {
    notes.push(
      `${oversizedFromPack.length} part(s) don't fit the bed even alone: ${oversizedFromPack.map((p) => p.name).join(", ")}. Scale them down or rotate manually.`,
    );
  }

  const totalPartCount = jobParts.reduce((s, p) => s + p.copies, 0);
  const totals: JobTotals = {
    plateCount: jobPlates.length,
    partCount: totalPartCount,
    toolChanges: colourPlan.toolChanges,
  };

  const now = new Date().toISOString();
  const job: PrintJob = {
    id: randomUUID(),
    name: opts.name ?? `Job ${now.slice(0, 16).replace("T", " ")}`,
    createdAt: now,
    updatedAt: now,
    status: "planned",
    plates: jobPlates,
    bed: opts.bed,
    colourBands: opts.colourBands,
    params,
    goal,
    material,
    colourPlan,
    totals,
    oversized: oversized.length > 0 ? oversized : undefined,
    notes,
  };
  return job;
}

/**
 * Flatten parts (and their copies) into the footprints packPlates works with.
 *
 * `PlatePart.path` carries the part's INDEX in `packable`, not a file path.
 * packPlates only needs an opaque identity, and the file path is not one: the
 * same STL requested in two colours is two different parts, and keying by path
 * merged them into one — silently dropping a colour. The index is unique per
 * part, and `indexOf` maps back to it after packing (the same JobPart objects
 * appear in the colour subsets, so identity lookup works there too).
 */
function toPlateParts(
  list: JobPart[],
  indexOf: Map<JobPart, number>,
): PlatePart[] {
  const out: PlatePart[] = [];
  for (const p of list) {
    const id = String(indexOf.get(p) ?? 0);
    for (let i = 0; i < p.copies; i++) out.push({ path: id, w: p.sizeX, d: p.sizeY });
  }
  return out;
}
