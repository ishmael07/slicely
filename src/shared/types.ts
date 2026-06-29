// Types shared across the Electron main process, preload bridge, and renderer.
// Keep this file dependency-free — it is imported on both sides of the IPC line.

/** A 3D model search hit, normalized across marketplaces. */
export interface ModelResult {
  /** Stable id within its source (string form). */
  id: string;
  source: ModelSource;
  title: string;
  /** Author / uploader display name, if known. */
  creator?: string;
  /** Absolute thumbnail image URL, if known. */
  thumbnail?: string;
  /** Human-facing web page for the model. */
  webUrl: string;
  /** License string as reported by the source, if any. */
  license?: string;
  /**
   * True when Slicely can download the mesh directly in-app. When false, the
   * UI offers "Open in browser" instead (download is login-gated at source).
   */
  downloadable: boolean;
}

export type ModelSource = "thingiverse" | "printables" | "makerworld";

/** A downloadable file belonging to a model (Thingiverse only, for the MVP). */
export interface ModelFile {
  id: string;
  name: string;
  /** Bytes, if reported. */
  sizeBytes?: number;
  ext: string; // ".stl", ".3mf", ".step", ...
}

/** One saved mesh file (a single part of a possibly multi-part model). */
export interface DownloadPart {
  localPath: string;
  fileName: string;
  sizeBytes: number;
  ext: string;
}

/** Result of downloading + saving a model locally.
 *  `localPath`/`fileName`/`sizeBytes` describe the PRIMARY part (kept for
 *  backward compatibility); `parts` lists every mesh saved (>= 1) when the
 *  model is multi-part or was a ZIP archive. */
export interface DownloadResult {
  localPath: string;
  fileName: string;
  sizeBytes: number;
  parts?: DownloadPart[];
}

/** Parsed output of `PrusaSlicer --info` for a single mesh. */
export interface ModelInfo {
  filePath: string;
  sizeX: number; // mm
  sizeY: number; // mm
  sizeZ: number; // mm
  volumeMm3?: number;
  facets?: number;
  manifold?: boolean;
  parts?: number;
}

/** Parameters Slicely can hand to PrusaSlicer for a slice. */
export interface SliceParams {
  layerHeightMm?: number; // e.g. 0.2
  /** Infill density as a percent value 0–100 (e.g. 20 = 20%). */
  fillDensityPct?: number;
  /** Infill pattern (PrusaSlicer fill_pattern value), e.g. "gyroid". */
  fillPattern?: string;
  /** Number of vertical walls (perimeters). */
  perimeters?: number;
  topSolidLayers?: number;
  bottomSolidLayers?: number;
  supportMaterial?: boolean;
  /** Overhang threshold in degrees (PrusaSlicer support_material_threshold).
   *  0 = PrusaSlicer's AUTOMATIC overhang detection (most accurate). A LOWER
   *  angle produces MORE supports, HIGHER produces FEWER. (Verified vs source —
   *  the inverse of an earlier, mistaken comment.) */
  supportThresholdDeg?: number;
  /** Support generation style — PrusaSlicer support_material_style: "grid"
   *  (classic/normal) or "organic" (tree, lighter & easier to remove; needs
   *  PrusaSlicer ≥ 2.6). "snug" is also valid. */
  supportStyle?: string;
  /** Only grow supports from the build plate, never on top of the model
   *  (support_material_buildplate_only). */
  supportBuildplateOnly?: boolean;
  brimWidthMm?: number; // 0 = none
  nozzleDiameterMm?: number; // e.g. 0.4

  // ── Plate / multi-part / cosmetic (the "max out slicing" options) ──────────
  /** Additional mesh files to place on the SAME plate as the primary input.
   *  Multiple inputs are auto-arranged by PrusaSlicer unless `arrange` is false. */
  extraInputs?: string[];
  /** Auto-arrange multiple inputs on the bed. Default true when >1 input;
   *  set false to keep original coordinates (PrusaSlicer --dont-arrange). */
  arrange?: boolean;
  /** Merge all inputs into a single object after arranging (--merge). */
  merge?: boolean;
  /** Number of auto-arranged copies of a SINGLE model (--duplicate N).
   *  Ignored when extraInputs is non-empty. */
  copies?: number;
  /** Uniform scale factor (1 = 100%); maps to --scale. */
  scale?: number;
  /** Z-axis rotation in degrees (--rotate). */
  rotateDeg?: number;
  /** Filament colour "#RRGGBB". NOTE: on a single-extruder FDM printer this is
   *  PREVIEW-ONLY — it does not change the physical print. */
  filamentColour?: string;
}

/** What the print is for — drives the whole settings profile. */
export type PrintGoal = "draft" | "quality" | "functional";

/** Filament family the user is printing with. */
export type PrintMaterial = "PLA" | "PETG" | "ABS";

/** Metrics parsed from a sliced G-code file. */
export interface SliceMetrics {
  gcodePath: string;
  estimatedPrintTime?: string; // e.g. "1h 23m 45s"
  filamentUsedMm?: number;
  filamentUsedG?: number;
  filamentCost?: number;
  layerCount?: number;
  /** 1-based index of this plate when a job spans multiple plates. */
  plateIndex?: number;
  /** Total number of plates the job was split into. */
  plateCount?: number;
  /** How many parts/copies are on this plate. */
  partsOnPlate?: number;
  /** True when the sliced G-code actually contains support extrusions
   *  (detected by scanning for ";TYPE:Support material" lines). This is the
   *  ground-truth signal that supports were generated — not just requested. */
  supportsGenerated?: boolean;
  /** Plain-language notes about anything Slicely auto-corrected to make this
   *  slice succeed or print reliably (e.g. clamped a too-thick layer height,
   *  fell back from organic→grid supports). Surfaced to the user. */
  fixes?: string[];
}

/** Whether/where PrusaSlicer is installed and whether it's running now. */
export interface SlicerStatus {
  installed: boolean;
  running: boolean;
  binaryPath?: string;
  version?: string;
  appName: string; // "PrusaSlicer"
}

// ── IPC channel payloads ─────────────────────────────────────────────────────

/** One streamed event from the agent to the renderer. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; tool: string; label: string }
  | { type: "tool_end"; tool: string; ok: boolean; summary?: string }
  | { type: "models"; models: ModelResult[] }
  | { type: "download"; model: ModelResult; result: DownloadResult }
  | { type: "info"; info: ModelInfo }
  | { type: "metrics"; metrics: SliceMetrics }
  | { type: "status"; status: SlicerStatus }
  | { type: "error"; message: string }
  | { type: "done" };

/** Channel names used across the preload bridge. */
export const IPC = {
  sendMessage: "slicely:sendMessage",
  agentEvent: "slicely:agentEvent",
  cancel: "slicely:cancel",
  getStatus: "slicely:getStatus",
  openExternal: "slicely:openExternal",
  importModel: "slicely:importModel",
  resizeWindow: "slicely:resizeWindow",
  getConfigState: "slicely:getConfigState",
  revealPath: "slicely:revealPath",
  openSlicer: "slicely:openSlicer",
  openGcode: "slicely:openGcode",
  getSettings: "slicely:getSettings",
  updateSettings: "slicely:updateSettings",
  updatePreferences: "slicely:updatePreferences",
  uploadFiles: "slicely:uploadFiles",
  pickFile: "slicely:pickFile",
} as const;

/** Reports which credentials are present, so the UI can warn the user. */
export interface ConfigState {
  hasAnthropicKey: boolean;
  hasThingiverseToken: boolean;
  model: string;
  workdir: string;
}

/** A reasoning-effort tier the user can pick. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Tri-state for supports/brim in the user's saved defaults:
 *   - "auto": let Slicely decide from the model's real geometry (recommended).
 *   - "on":   always generate them, regardless of geometry.
 *   - "off":  never generate them. */
export type FeatureMode = "auto" | "on" | "off";

/** Support generation style the user can pin. "grid" = classic/normal,
 *  "organic" = tree supports (lighter, easier to remove; PrusaSlicer ≥ 2.6). */
export type SupportStyle = "grid" | "organic" | "snug";

/** A printer the user has saved. Either a known catalog key (bed + nozzle come
 *  from the catalog) OR "custom" with an explicit bed + nozzle they typed in. */
export interface PrinterPref {
  /** Catalog key (e.g. "prusa-mk4", "ender-3", "generic") or "custom". */
  key: string;
  /** Display label (catalog label, or the user's custom name). */
  label?: string;
  /** Custom build volume in mm — only meaningful when key === "custom". */
  bed?: { x: number; y: number; z: number };
  /** Custom nozzle diameter in mm — only meaningful when key === "custom". */
  nozzleMm?: number;
}

/**
 * The user's PERSISTENT printing preferences. Saved to disk so Slicely never
 * has to re-ask the printer or default settings between sessions. Every field
 * is optional: an unset field means "no saved default — decide per the model /
 * the request". Explicit per-slice arguments always win over these.
 */
export interface PrintPreferences {
  /** The saved printer (geometry + nozzle source). Unset ⇒ ask once / generic. */
  printer?: PrinterPref;
  /** Default filament family. Unset ⇒ PLA. */
  material?: PrintMaterial;
  /** Default print goal (draft/quality/functional). Unset ⇒ ask once / quality. */
  goal?: PrintGoal;
  /** Default infill density percent (0–100). Unset ⇒ goal-derived. */
  fillDensityPct?: number;
  /** Default infill pattern (e.g. "gyroid"). Unset ⇒ goal-derived. */
  fillPattern?: string;
  /** How to handle supports by default. Unset ⇒ "auto". */
  supports?: FeatureMode;
  /** Preferred support style when supports are generated. Unset ⇒ "grid". */
  supportStyle?: SupportStyle;
  /** How to handle a brim by default. Unset ⇒ "auto". */
  brim?: FeatureMode;
  /** Brim width in mm used when brim is "on" (or auto decides to add one).
   *  Unset ⇒ geometry-derived width. */
  brimWidthMm?: number;
}

/** A model the UI offers in its picker, with capability flags for the UI. */
export interface ModelChoice {
  id: string;
  label: string;
  blurb: string;
  supportsEffort: boolean;
  supportsXHigh: boolean;
  supportsMax: boolean;
}

/** The user's live model + effort selection. */
export interface UserSettings {
  model: string;
  effort: EffortLevel;
}

/** One printer the settings UI offers in its picker. */
export interface PrinterChoice {
  /** Catalog key (e.g. "prusa-mk4"). */
  key: string;
  label: string;
  nozzleMm: number;
  bed: { x: number; y: number; z: number };
}

/** Settings payload sent to the renderer: current selection + the catalogs. */
export interface SettingsState {
  current: UserSettings;
  models: ModelChoice[];
  efforts: EffortLevel[];
  /** The user's persistent printing preferences (printer + slice defaults). */
  preferences: PrintPreferences;
  /** Known printers Slicely can synthesize a config for (for the picker). */
  printers: PrinterChoice[];
  /** Filament families the UI offers. */
  materials: PrintMaterial[];
  /** Print goals the UI offers. */
  goals: PrintGoal[];
}

/** Result of accepting a user-supplied CAD/mesh file into the workspace. */
export interface UploadResult {
  localPath: string;
  fileName: string;
  sizeBytes: number;
  ext: string;
  /** Files PrusaSlicer can slice directly vs. ones it can only import/convert. */
  sliceable: boolean;
}

/** Mesh/CAD extensions Slicely accepts from the user. `.zip` is accepted and
 *  expanded into its contained meshes. */
export const ACCEPTED_UPLOAD_EXTS = [
  ".stl",
  ".3mf",
  ".obj",
  ".amf",
  ".step",
  ".stp",
  ".zip",
] as const;

/**
 * The API surface the preload bridge exposes to the renderer as
 * `window.slicely`. Declared here (dependency-free) so both the preload
 * (Node/Electron context) and the renderer (browser context) can reference it
 * without the renderer pulling in Electron types.
 */
export interface SlicelyApi {
  sendMessage(message: string): Promise<void>;
  cancel(): void;
  onAgentEvent(handler: (event: AgentEvent) => void): () => void;
  getStatus(): Promise<SlicerStatus>;
  getConfigState(): Promise<ConfigState>;
  openExternal(url: string): Promise<void>;
  /** Open one or more model/gcode files in the PrusaSlicer GUI. Passing
   *  multiple files loads them onto one auto-arranged plate. */
  openInSlicer(path: string | string[]): Promise<void>;
  /** Reveal a local file (e.g. sliced G-code) in Finder. */
  revealPath(path: string): Promise<void>;
  /** Open one or more MODELS in the regular PrusaSlicer editor (multiple = one
   *  arranged plate), ready to slice. NOT for G-code — use openGcode for that. */
  openSlicer(path: string | string[]): Promise<void>;
  /** Open an already-sliced .gcode in PrusaSlicer's G-code viewer (the finished
   *  toolpath preview / export view). Use only when the user wants the finished
   *  result, not the editable editor. */
  openGcode(gcodePath: string): Promise<void>;
  /** Get the current model/effort selection and the available catalog. */
  getSettings(): Promise<SettingsState>;
  /** Persist a model/effort change; returns the updated selection. */
  updateSettings(patch: Partial<UserSettings>): Promise<SettingsState>;
  /** Persist a change to the user's printing preferences (printer + slice
   *  defaults). Returns the full updated settings state. */
  updatePreferences(patch: Partial<PrintPreferences>): Promise<SettingsState>;
  /** Open a native file picker for CAD/mesh files; returns accepted uploads. */
  pickFile(): Promise<UploadResult[]>;
  /** Accept dropped files by absolute path; returns accepted uploads. */
  uploadFiles(paths: string[]): Promise<UploadResult[]>;
  resizeWindow(height: number): void;
}
