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
    let sizeX = info.sizeX;
    let sizeY = info.sizeY;
    let sizeZ = info.sizeZ;
    let orientation: JobPart["orientation"];

    if (autoOrient) {
      try {
        const mesh = await parseMesh(input.path);
        const result = chooseOrientation(mesh.triangles, {
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
  const colourPlan = planColours(jobParts, opts.slots ?? []);
  const assignmentByPath = new Map(colourPlan.assignments.map((a) => [a.partPath, a]));
  for (const p of jobParts) {
    const a = assignmentByPath.get(p.path);
    if (a) {
      p.extruder = a.extruder;
      p.colourHex = a.colourHex;
    }
  }
  notes.push(...colourPlan.warnings);

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
  const groupByColour = opts.groupByColour ?? distinctColours.size > 1;

  const bed: BedArea = { w: opts.bed.x, d: opts.bed.y };
  const spacing = opts.spacingMm ?? DEFAULT_SPACING;

  const packedPlates: Plate[] = [];
  const packOversized: PlatePart[] = [];

  if (groupByColour && distinctColours.size > 1) {
    const byColour = new Map<string, JobPart[]>();
    for (const p of packable) {
      const key = p.colourHex ?? "";
      const list = byColour.get(key);
      if (list) list.push(p);
      else byColour.set(key, [p]);
    }
    for (const group of byColour.values()) {
      const { plates, oversized } = packPlates(toPlateParts(group), bed, spacing);
      packedPlates.push(...plates);
      packOversized.push(...oversized);
    }
    notes.push(
      `Grouped parts by colour across ${byColour.size} colour group(s) so each plate needs the fewest tool changes.`,
    );
  } else {
    const { plates, oversized } = packPlates(toPlateParts(packable), bed, spacing);
    packedPlates.push(...plates);
    packOversized.push(...oversized);
  }

  // ── Build JobPlate[] ─────────────────────────────────────────────────────
  const partByPath = new Map(jobParts.map((p) => [p.path, p]));
  const jobPlates: JobPlate[] = packedPlates.map((plate, i) => {
    const counts = new Map<string, number>();
    for (const pp of plate.parts) counts.set(pp.path, (counts.get(pp.path) ?? 0) + 1);
    const plateParts: JobPart[] = [...counts.entries()].map(([path, copies]) => ({
      ...partByPath.get(path)!,
      copies,
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
  const oversizedFromPack: JobPart[] = [...oversizedCounts.entries()].map(([path, copies]) => ({
    ...partByPath.get(path)!,
    copies,
  }));
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

function toPlateParts(list: JobPart[]): PlatePart[] {
  const out: PlatePart[] = [];
  for (const p of list) {
    for (let i = 0; i < p.copies; i++) out.push({ path: p.path, w: p.sizeX, d: p.sizeY });
  }
  return out;
}
