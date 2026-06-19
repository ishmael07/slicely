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

/** Result of downloading + saving a model file locally. */
export interface DownloadResult {
  localPath: string;
  fileName: string;
  sizeBytes: number;
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
  supportMaterial?: boolean;
  brimWidthMm?: number; // 0 = none
  nozzleDiameterMm?: number; // e.g. 0.4
}

/** Metrics parsed from a sliced G-code file. */
export interface SliceMetrics {
  gcodePath: string;
  estimatedPrintTime?: string; // e.g. "1h 23m 45s"
  filamentUsedMm?: number;
  filamentUsedG?: number;
  filamentCost?: number;
  layerCount?: number;
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
} as const;

/** Reports which credentials are present, so the UI can warn the user. */
export interface ConfigState {
  hasAnthropicKey: boolean;
  hasThingiverseToken: boolean;
  model: string;
  workdir: string;
}

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
  openInSlicer(path: string): Promise<void>;
  resizeWindow(height: number): void;
}
