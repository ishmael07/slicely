// Types shared across the Electron main process, preload bridge, and renderer.
// Keep this file dependency-free — it is imported on both sides of the IPC line.

import type {
  SourceId,
  SourcedModel,
  SearchOutcome,
  SourceAvailability,
  UrlResolution,
} from "./sourcing";
import type {
  PrinterConnection,
  PrinterStatus,
  PrinterTestResult,
  PrinterTransport,
  DiscoveredPrinter,
  SendJobResult,
} from "./printers";
import type { PrintJob, JobEvent, OrientationResult } from "./jobs";

export type {
  SourceId,
  SourcedModel,
  SearchOutcome,
  SourceAvailability,
  UrlResolution,
  PrinterConnection,
  PrinterStatus,
  PrinterTestResult,
  PrinterTransport,
  DiscoveredPrinter,
  SendJobResult,
  PrintJob,
  JobEvent,
  OrientationResult,
};

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

/** @deprecated Use `SourceId` from "./sourcing". Kept as an alias so v1 code
 *  (providers/, renderer cards) keeps compiling while sourcing v2 lands. */
export type ModelSource = SourceId;

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
  /** Live update to a running tool's label. Long operations (planning a job,
   *  slicing plate after plate) otherwise show a spinner that never changes,
   *  which is indistinguishable from being stuck. */
  | { type: "tool_progress"; tool: string; label: string }
  | { type: "models"; models: ModelResult[] }
  | { type: "download"; model: ModelResult; result: DownloadResult }
  | { type: "info"; info: ModelInfo }
  | { type: "metrics"; metrics: SliceMetrics }
  | { type: "status"; status: SlicerStatus }
  // ── v2: sourcing, printers, jobs ──────────────────────────────────────────
  /** Federated search finished — includes per-source success/failure. */
  | { type: "search"; outcome: SearchOutcome }
  /** A pasted URL was resolved to something downloadable (or not). */
  | { type: "resolved"; resolution: UrlResolution }
  /** The printer list or one printer's live status changed. */
  | { type: "printers"; printers: PrinterConnection[]; statuses: PrinterStatus[] }
  /** Outcome of sending G-code to a printer. */
  | { type: "sent"; printerId: string; result: SendJobResult }
  /** A multi-plate job was planned or updated. */
  | { type: "job"; job: PrintJob }
  /** Streamed progress while a job slices plate by plate. */
  | { type: "job_progress"; event: JobEvent }
  /** Orientation pass result for a single part. */
  | { type: "orientation"; partPath: string; result: OrientationResult }
  /** Something the user can act on, rendered as a button rather than buried in
   *  prose. Slicely runs the slicer on the SERVER, so "opened it in PrusaSlicer"
   *  means nothing to a browser on another machine — a button that hands over
   *  the file (or the install page) is the version that actually works there. */
  | {
      type: "action";
      /** Button text, e.g. "Open in PrusaSlicer". */
      label: string;
      kind: "open-project" | "link" | "install";
      /** Where the button goes. For a server-side file the chat route swaps
       *  this for a session-scoped download URL before it reaches the browser. */
      href?: string;
      /** Server-side file to hand over. Never sent to the browser as-is. */
      filePath?: string;
      /** One short line under the button, when the button alone isn't obvious. */
      hint?: string;
    }
  /** Something failed. `code` is the stable wire code the UI branches on
   *  (`no_key`, `key_rejected`, `rate_limited`, …) so it can show the right
   *  affordance — the "connect your key" card rather than a red line of prose.
   *  Optional: plain tool/agent failures carry a message only. */
  | { type: "error"; message: string; code?: string }
  | { type: "done" };

/**
 * Channel names used across the preload bridge.
 *
 * This list is SHORT on purpose (Task E2). It used to mirror the whole product
 * — chat, settings, printers, sourcing, jobs — because the Mac app had its own
 * renderer talking to the main process over IPC while the web client talked to
 * the server over HTTP: two transports for one API, and every feature written
 * twice. The window now loads the web client, so the API is HTTP for everybody
 * and IPC is left with only what a browser genuinely cannot do: reach into
 * macOS. The two "open this file" channels take an OPAQUE TOKEN, never a
 * filesystem path — main resolves it against the session's own G-code registry,
 * so the page can only ever name files the server already gave it.
 *
 * It is also exactly what the client CALLS. An unused channel is still reachable
 * from a compromised page, so two were removed in fix round 1: `openInSlicer`
 * (which handed a G-CODE token to the model editor — the wrong kind of file for
 * that window, and no button ever invoked it) and a synchronous `version`, which
 * nothing in the UI displayed. If "Open in PrusaSlicer" is wanted later it needs
 * a MODEL-path token and a button that uses it, and can be added then.
 */
export const IPC = {
  /** Open a sliced .gcode in PrusaSlicer's G-code viewer. */
  openGcode: "slicely:openGcode",
  /** Reveal a sliced .gcode in Finder. */
  revealGcode: "slicely:revealGcode",
  /** Native open dialog for mesh/CAD files; resolves to absolute paths. */
  pickFiles: "slicely:pickFiles",
} as const;

/** A reasoning-effort tier the user can pick. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * An AI provider a user can connect a key to.
 *
 * Lives here rather than beside the provider implementations because it is on
 * the wire: /api/config lists providers, /api/key names one, and every model in
 * /api/settings says which one it needs. The implementations are in
 * main/agent/provider-*.ts, and nothing client-side imports those.
 */
export type ProviderId = "anthropic" | "openai";

/** One provider as /api/config describes it. The KEY ITSELF never appears — only
 *  whether this session has one and the four-character hint that identifies it. */
export interface ProviderInfo {
  id: ProviderId;
  /** How to name it in the UI, e.g. "OpenAI". */
  label: string;
  hasKey: boolean;
  keyHint?: string;
  /** The copy the key card is built from. Shipped rather than duplicated in the
   *  client: two tables for one truth means a corrected console URL in
   *  main/agent/provider-*.ts leaves the card pointing at the old one. Optional,
   *  so a client can still render against a server too old to send it. */
  keyHelp?: ProviderKeyHelp;
}

/** One provider's key-card copy, flattened for the wire (`formatMessage` is a
 *  sentence here, not the function it is on the server). */
export interface ProviderKeyHelp {
  /** Field label, e.g. "OpenAI API key". */
  label: string;
  /** Input placeholder, e.g. "sk-ant-…". */
  placeholder: string;
  consoleUrl: string;
  /** How to name that URL in prose, e.g. "platform.openai.com/api-keys". */
  consoleLabel: string;
  /** What to say about a paste that isn't recognised at all — the client's own
   *  refusal, before any request is made. */
  formatMessage: string;
}

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
  /** Which provider answers for it — i.e. which key it needs. The picker groups
   *  on this and disables the models of a provider with no key connected. */
  provider: ProviderId;
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

/** Result of accepting a user-supplied CAD/mesh file into the workspace.
 *  SERVER-SIDE ONLY: `localPath` is an absolute path on the server's disk, and
 *  absolute paths never reach a client (spec §Error handling). What a browser
 *  is told about the same file is a `WorkspaceFile` — see below. */
export interface UploadResult {
  localPath: string;
  fileName: string;
  sizeBytes: number;
  ext: string;
  /** Files PrusaSlicer can slice directly vs. ones it can only import/convert. */
  sliceable: boolean;
}

/**
 * One file in the session's workspace, as the CLIENT is told about it.
 *
 * `POST /api/upload` used to answer with the `UploadResult` above, absolute
 * `localPath` and all — and the client put that path into the chat prompt so
 * the agent's tools could find the file. So the sessions root and the session
 * id travelled to the browser (and on to Anthropic) on every attachment, which
 * the spec forbids outright.
 *
 * `relPath` replaces it: the file's location relative to the session's OWN
 * directory, always POSIX-separated ("uploads/cube.stl"). It is exactly as
 * useful to the agent — main/session-context.ts resolves a relative path
 * against the ambient session's directory (never `process.cwd()`) and then
 * applies the same workspace containment check as before — and it names nothing
 * outside the visitor's own workspace. Every endpoint that takes a path back
 * from a client accepts this form: /api/slice, /api/preview, /api/jobs.
 */
export interface WorkspaceFile {
  /** The file's name inside the workspace, e.g. "cube.stl". */
  name: string;
  /** Session-relative POSIX path, e.g. "uploads/cube.stl" or
   *  "uploads/kit/part1.stl" for a part out of a ZIP. */
  relPath: string;
  sizeBytes: number;
  ext: string;
  /** Files PrusaSlicer can slice directly vs. ones it can only import/convert. */
  sliceable: boolean;
}

/**
 * Hard caps on what a single ZIP archive may expand into — the zip-bomb
 * bounds, shared by BOTH extractors (main/meshzip.ts for uploads,
 * main/sourcing/download.ts for downloads) so neither can be the soft spot.
 *
 * Entry COUNT is the cheap attack: a few kilobytes of archive can name tens of
 * thousands of files, each of which costs an inode, a write, and a row in the
 * session's file list. Total UNCOMPRESSED SIZE is the classic one: DEFLATE
 * reaches ~1000:1 on zeroes, so a 2 MB upload can ask for 2 GB of disk.
 * 500 entries / 2 GB is far beyond any real multi-part model kit.
 */
export const MAX_ZIP_ENTRIES = 500;
export const MAX_ZIP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Cap on ONE entry's uncompressed size.
 *
 * The two caps above bound an archive in aggregate and still let a single
 * member be enormous: one declared 1.9 GB entry passes both, and an extractor
 * that buffers an entry whole (`entry.buffer()`) then asks Node for a 1.9 GB
 * Buffer — which either throws or takes the process's memory with it, long
 * before any total-bytes counter gets a chance to object. A per-entry ceiling
 * is what makes streaming extraction safe to bound incrementally. Matches the
 * per-entry allowance `sourcing/download.ts` already applies to fetched zips.
 */
export const MAX_ZIP_ENTRY_BYTES = 500 * 1024 * 1024;

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
 * The API surface the preload bridge exposes to the page as `window.slicely`.
 *
 * NATIVE-ONLY, AND TOKENS NOT PATHS (Task E2). Everything the page can also do
 * over HTTP it does over HTTP — this is only the handful of actions that need a
 * Mac: the PrusaSlicer GUI, Finder, the native file dialog, and the real
 * filesystem paths of dropped files (which the browser deliberately hides).
 *
 * The two "open this file" calls take the same opaque G-code token the server
 * already handed the page (`GET /api/gcode/:id`), not a path. The page never
 * learns where anything is on disk, and a compromised page cannot ask macOS to
 * open an arbitrary file: main looks the token up in this session's own
 * registry, and anything that isn't in it does nothing.
 *
 * Declared here (dependency-free) so both the preload (Electron context) and
 * the client (browser context) can reference it. Its absence is how the client
 * knows it is in a browser: `window.slicely` exists nowhere else, which is what
 * gates the native buttons and the desktop header (see src/web).
 */
export interface SlicelyDesktopApi {
  /** Open a sliced G-code file in PrusaSlicer's G-code viewer. */
  openGcode(token: string): Promise<void>;
  /** Reveal a sliced G-code file in Finder. */
  revealGcode(token: string): Promise<void>;
  /** Native open dialog, filtered to the accepted mesh/CAD extensions.
   *  Resolves to absolute paths (empty when cancelled) — hand them to
   *  `POST /api/attach-local`, which is the only thing that may read them. */
  pickFiles(): Promise<string[]>;
  /** The real on-disk paths of dropped `File` objects — the one thing a browser
   *  cannot tell you about a file the user just dropped. Synchronous, because
   *  it must run inside the drop handler while the DataTransfer is alive. */
  pathsForDrop(files: File[]): string[];
}

// ── Accounts (Task A7 owns these; stub until accounts/core merges) ──────────
//
// The wire shapes lane B's `/api/me` and lane A's `/api/config` both speak.
// Frozen verbatim in the plan (Task A7's Interfaces block), so lane A's copy and
// this one are the same text and the merge can take either.

/** One sign-in button. The order of the list is fixed (google, then github) so
 *  the UI never reorders between renders. */
export interface SigninProvider {
  id: "google" | "github";
  label: string;
}

/** Everything the client is told about a signed-in account — an email, a
 *  monogram letter, four integers and two pre-formatted strings. Deliberately
 *  NOT the provider identity, the provider user id, or anything about a key. */
export interface AccountView {
  email: string;
  name?: string;
  /** One uppercase letter, for the monogram. */
  initial: string;
  balanceMicros: number;
  /** "$0.42" — formatted once, on the server, so two clients cannot disagree. */
  balanceLabel: string;
  grantedMicros: number;
  grantedLabel: string;
  chatsToday: number;
  chatsPerDay: number;
  exhausted: boolean;
}

export interface MeResponse {
  signedIn: boolean;
  account?: AccountView;
}

declare global {
  interface Window {
    /** The preload bridge. Present in the Mac app and nowhere else. */
    slicely?: SlicelyDesktopApi;
  }
}
