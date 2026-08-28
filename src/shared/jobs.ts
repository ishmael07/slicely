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
}

// ── Colour ───────────────────────────────────────────────────────────────────

/** Assignment of one part to one physical filament slot. */
export interface ColourAssignment {
  /** Absolute path of the part this applies to. */
  partPath: string;
  /** 1-based PrusaSlicer extruder index. */
  extruder: number;
  /** "#RRGGBB" actually loaded in that slot. */
  colourHex: string;
  /** How the assignment was made. */
  reason: "user" | "matched-slot" | "nearest-colour" | "default";
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
  metrics?: SliceMetrics;
  /** Distinct colours on this plate, for the UI and for tool-change costing. */
  colours: string[];
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
}

/** Progress event emitted while a job slices, so the UI can stream it. */
export type JobEvent =
  | { type: "job_planned"; job: PrintJob }
  | { type: "plate_start"; jobId: string; plateIndex: number }
  | { type: "plate_done"; jobId: string; plateIndex: number; metrics: SliceMetrics }
  | { type: "plate_failed"; jobId: string; plateIndex: number; error: string }
  | { type: "job_done"; job: PrintJob }
  | { type: "job_failed"; jobId: string; error: string };
