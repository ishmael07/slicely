// ─────────────────────────────────────────────────────────────────────────────
// P3 — Job-level smart slicing contracts.
//
// v1 reasons about ONE mesh at a time. This layer reasons about a JOB: dozens
// of parts, chosen orientations, packed across plates, coloured across AMS
// slots, sliced in order, and streamed to a printer over hours or days.
//
// Dependency-free. No Node, no Electron.
// ─────────────────────────────────────────────────────────────────────────────

import type { SliceMetrics, SliceParams, PrintGoal, PrintMaterial } from "./types";
import type { FilamentSlot } from "./printers";

// ── Orientation ──────────────────────────────────────────────────────────────

/** A candidate pose for a single part, with the cost of printing it that way. */
export interface OrientationCandidate {
  /** Rotation applied about each axis, in degrees, from the mesh as imported. */
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  /** Bounding box in this pose, mm. */
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Projected area of faces steeper than the support threshold, mm². The
   *  dominant term in support cost. */
  overhangAreaMm2: number;
  /** Contact area with the bed, mm². Higher = better adhesion, less warping. */
  bedContactMm2: number;
  /** Number of layers at the active layer height. Drives print time. */
  layerCount: number;
  /** 0–100. Higher is better. Weighted by the active goal. */
  score: number;
  /** Why this pose scored as it did — surfaced to the user. */
  rationale: string[];
}

export interface OrientationResult {
  best: OrientationCandidate;
  /** All evaluated poses, best first. Capped for UI sanity. */
  candidates: OrientationCandidate[];
  /** True when the as-imported pose was already best (no rotation applied). */
  keptAsImported: boolean;
}

export interface OrientationOptions {
  /** Goal steers the weighting: draft→time, quality→surface, functional→strength. */
  goal?: PrintGoal;
  /** Overhang angle (deg from vertical) beyond which support is needed. */
  supportThresholdDeg?: number;
  layerHeightMm?: number;
  /** Direction the part will be loaded in service; strength-goal poses try to
   *  put layer lines perpendicular to it. Unit vector in model space. */
  loadAxis?: { x: number; y: number; z: number };
  /** Cap on poses evaluated. Default 24 (axis-aligned + face-normal candidates). */
  maxCandidates?: number;
  /** Mesh data the caller has already computed. Supplying it avoids repeating
   *  a full pass over the triangles, which dominates orientation on a large
   *  model. Typed loosely here so this contract stays dependency-free. */
  mesh?: unknown;
}

// ── Colour ───────────────────────────────────────────────────────────────────

/** Assignment of one part to one physical filament slot. */
export interface ColourAssignment {
  /** Absolute path of the part this applies to. */
  partPath: string;
  /** 1-based PrusaSlicer extruder index. */
  extruder: number;
  /** "#RRGGBB" actually loaded in that slot.
   *
   *  UNDEFINED means no colour is known — nothing was requested and no spool
   *  reported one. That is a real answer, not a gap to fill in: inventing a
   *  colour here is how a plate nobody asked to be white was written into a
   *  project as `filament_colour = #FFFFFF`. Absent must stay absent all the
   *  way down, so PrusaSlicer's own default is what shows. */
  colourHex?: string;
  /** How the assignment was made. `unset` = no colour is known at all. */
  reason: "user" | "matched-slot" | "nearest-colour" | "default" | "unset";
}

/** A whole-job colour plan resolved against the printer's real loaded spools. */
export interface ColourPlan {
  /** Slots as reported by the printer (or declared by the user). */
  slots: FilamentSlot[];
  assignments: ColourAssignment[];
  /** Estimated tool changes across the job — the main multi-colour time cost. */
  toolChanges: number;
  /** Estimated grams flushed/purged on tool changes. */
  wasteG?: number;
  /** e.g. "Requested teal isn't loaded; using the closest slot (cyan)." */
  warnings: string[];
  /** True when the printer has one usable slot: colour is preview-only. */
  singleExtruder: boolean;
}

// ── Jobs & plates ────────────────────────────────────────────────────────────

/** One part in a job. */
export interface JobPart {
  /** Absolute path to the mesh on disk. */
  path: string;
  /** Display name (usually the basename). */
  name: string;
  /** How many of this part the job needs. */
  copies: number;
  /** Footprint + height in mm, in the CHOSEN orientation. */
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  volumeMm3?: number;
  /** Pose selected by the orientation pass, when one ran. */
  orientation?: OrientationCandidate;
  /** Requested colour "#RRGGBB", before it's resolved against real slots. */
  colourHex?: string;
  /** 1-based extruder, once the colour plan is resolved. */
  extruder?: number;
  /** Per-part slice overrides that beat the job-level params. */
  overrides?: Partial<SliceParams>;
  /** Where the packer put each instance on the bed, in mm from the origin
   *  (the footprint's lower-left corner). One entry per copy. The slicer uses
   *  these directly so grouping and positioning cannot disagree. */
  placements?: Array<{ x: number; y: number }>;
}

export type PlateStatus =
  | "planned"
  | "slicing"
  | "ready"      // G-code exists
  | "queued"     // sent to a printer, waiting
  | "printing"
  | "done"
  | "failed";

/** One bed's worth of parts. */
export interface JobPlate {
  /** 1-based. */
  index: number;
  parts: JobPart[];
  status: PlateStatus;
  /** Path to the sliced G-code, once sliced. */
  gcodePath?: string;
  /** The 3MF project for this plate: every part arranged, oriented and
   *  coloured as planned. Opening this in PrusaSlicer shows the real layout,
   *  where opening the source STLs shows an unarranged pile. */
  projectPath?: string;
  metrics?: SliceMetrics;
  /** Distinct colours on this plate, for the UI and for tool-change costing. */
  colours: string[];
  /** Filament swaps up the height of this plate, resolved against the plate's
   *  own tallest part. Written into the plate's project so PrusaSlicer SHOWS
   *  them and lets the user move them, and inserted into the finished G-code
   *  as the actual swap commands. */
  colourChanges?: Array<{ atZ: number; colourHex: string }>;
  /** The colour the plate STARTS in, when it is banded. Used as the project's
   *  filament_colour so it opens looking like the print's first layer. */
  startColour?: string;
  /** Why these parts were grouped together. */
  rationale?: string;
  /** Set when status is "failed". */
  error?: string;
}

export type JobStatus =
  | "planned"
  | "slicing"
  | "ready"
  | "printing"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

/** A full print job: many parts, many plates, sliced and printed in order. */
export interface PrintJob {
  id: string;
  name: string;
  /** ISO timestamp. */
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  plates: JobPlate[];
  /** Job-wide slice settings; per-part `overrides` win over these. */
  params: SliceParams;
  goal: PrintGoal;
  material: PrintMaterial;
  /** Printer this job targets (PrinterConnection.id), when one is chosen. */
  printerId?: string;
  /** Usable bed the job was planned against, in mm. Kept because slicing a
   *  multi-extruder plate writes a 3MF with explicit object positions, which
   *  needs the bed the packer actually used. */
  bed?: { x: number; y: number; z: number };
  /**
   * Colours stacked up the print, bottom first, for colouring a SINGLE part
   * without painting it. Slicely divides the plate's height into equal bands
   * and inserts a filament swap at each boundary.
   *
   * A filament swap is a property of the PRINTER, not of one object, so these
   * bands apply to everything on the plate at that height. Planning warns when
   * a banded plate holds more than one part.
   */
  colourBands?: string[];
  /**
   * Colour changes at heights the user named, rather than at equal fractions.
   * "black up to 5 mm", "change at layer 40", "the bottom third in black" —
   * requests equal bands cannot express. Resolved by colourchange.ts against
   * the plate's height and the active layer height.
   *
   * When both are given, stops win: they are the more specific request.
   */
  colourStops?: Array<{
    atZ?: number;
    atLayer?: number;
    atFraction?: number;
    colourHex: string;
  }>;
  colourPlan?: ColourPlan;
  /** Summed across every plate, once sliced. */
  totals?: JobTotals;
  /** Parts that fit no plate even alone — the user must scale them down. */
  oversized?: JobPart[];
  /** Plain-language notes about planning decisions. */
  notes: string[];
}

export interface JobTotals {
  plateCount: number;
  partCount: number;
  estimatedMinutes?: number;
  filamentG?: number;
  filamentCost?: number;
  toolChanges?: number;
}

/** How to plan a job. */
export interface JobPlanOptions {
  /** Usable bed, mm. */
  bed: { x: number; y: number; z: number };
  /** Gap between parts, mm — should come from the active profile. */
  spacingMm?: number;
  /** Run the orientation pass on every part. Default true. */
  autoOrient?: boolean;
  /** Group parts by colour so each plate needs the fewest tool changes.
   *  Default true when the job uses more than one colour. */
  groupByColour?: boolean;
  /** Max build height, mm — parts taller than this are flagged oversized. */
  maxHeightMm?: number;
  goal?: PrintGoal;
  /** Printer slots, used to resolve the colour plan while packing. */
  slots?: FilamentSlot[];
  /** Colours stacked up the print, bottom first — see PrintJob.colourBands. */
  colourBands?: string[];
  /** Explicit colour stops — see PrintJob.colourStops. */
  colourStops?: PrintJob["colourStops"];
  /** Called as planning proceeds, so a caller can show what is happening
   *  instead of a spinner that never changes. */
  onProgress?: (p: PlanProgress) => void;
}

/** Where planning has got to. Emitted per part, because inspecting and
 *  orienting a detailed mesh is the slow step and the user should see it move. */
export interface PlanProgress {
  stage: "inspecting" | "orienting" | "colouring" | "packing";
  /** 1-based, and 0 when the stage is not per-part. */
  index: number;
  total: number;
  /** File being worked on, when the stage is per-part. */
  partName?: string;
}

/** Progress event emitted while a job slices, so the UI can stream it. */
export type JobEvent =
  | { type: "job_planned"; job: PrintJob }
  | { type: "plate_start"; jobId: string; plateIndex: number }
  | { type: "plate_done"; jobId: string; plateIndex: number; metrics: SliceMetrics }
  | { type: "plate_failed"; jobId: string; plateIndex: number; error: string }
  | { type: "job_done"; job: PrintJob }
  | { type: "job_failed"; jobId: string; error: string };
