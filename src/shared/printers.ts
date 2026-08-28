// ─────────────────────────────────────────────────────────────────────────────
// P0 — Print transport contracts.
//
// The layer that turns Slicely from "a thing that writes G-code files" into
// "a thing that prints". Every driver implements PrinterDriver; the registry
// persists PrinterConnection records; the UI renders PrinterStatus.
//
// Dependency-free: imported by the Electron main process, the preload bridge,
// the renderer, AND the web server. Do not import Node or Electron here.
// ─────────────────────────────────────────────────────────────────────────────

/** How Slicely talks to a printer. */
export type PrinterTransport =
  | "octoprint"      // OctoPrint REST API (LAN, X-Api-Key)
  | "moonraker"      // Klipper/Moonraker REST API (LAN, usually no auth)
  | "prusalink"      // PrusaLink on MK4/XL/Mini (LAN, HTTP digest or API key)
  | "prusa-connect"  // Prusa Connect cloud
  | "bambu-lan"      // Bambu Lab MQTT over LAN (serial + access code)
  | "bambu-cloud"    // Bambu Lab cloud MQTT (account token)
  | "file";          // No printer: write G-code to a folder / SD card

/** True when this transport reaches the printer over the public internet.
 *  Cloud transports are what make zero-install (web) Slicely able to print. */
export const CLOUD_TRANSPORTS: ReadonlySet<PrinterTransport> = new Set<PrinterTransport>([
  "prusa-connect",
  "bambu-cloud",
]);

/** A printer the user has connected. Persisted to disk.
 *  Secrets (apiKey/accessCode/token/password) are stored separately by the
 *  registry and are NEVER included when a connection is sent to the renderer. */
export interface PrinterConnection {
  /** Stable local id (uuid-ish). */
  id: string;
  /** User-facing name, e.g. "Prusa MK4 (workshop)". */
  label: string;
  transport: PrinterTransport;

  // ── Addressing ────────────────────────────────────────────────────────────
  /** Hostname or IP for LAN transports. */
  host?: string;
  /** Port for LAN transports (driver supplies a sane default). */
  port?: number;
  /** Bambu device serial (LAN + cloud). */
  serial?: string;
  /** Prusa Connect printer uuid. */
  printerUuid?: string;
  /** Destination directory for the "file" transport. */
  outputDir?: string;

  // ── Geometry, so Slicely can slice FOR this printer ────────────────────────
  bed?: { x: number; y: number; z: number };
  nozzleMm?: number;
  /** Printer model string as reported by the device, if known. */
  model?: string;
  /** Number of usable filament slots (1 = single extruder, 4 = AMS, 16 = AMS x4). */
  filamentSlots?: number;

  /** Set false to keep a printer configured but hidden from the picker. */
  enabled?: boolean;
  /** ISO timestamp of the last successful contact. */
  lastSeenAt?: string;
}

/** Credentials for a connection. Held in a separate secrets store; only the
 *  main/server process ever sees these. */
export interface PrinterSecrets {
  /** OctoPrint X-Api-Key, PrusaLink API key, Moonraker API key. */
  apiKey?: string;
  /** PrusaLink digest-auth username (default "maker"). */
  username?: string;
  /** PrusaLink digest-auth password. */
  password?: string;
  /** Bambu LAN access code (8 chars, shown on the printer screen). */
  accessCode?: string;
  /** Cloud bearer token (Prusa Connect / Bambu cloud). */
  token?: string;
}

/** A connection plus its secrets — what a driver actually receives. */
export type ResolvedPrinter = PrinterConnection & PrinterSecrets;

/** Coarse printer state, normalized across every vendor's vocabulary. */
export type PrinterState =
  | "offline"
  | "idle"
  | "preparing"   // heating / homing / leveling
  | "printing"
  | "paused"
  | "finished"
  | "error"
  | "unknown";

/** One AMS / MMU / spool slot the printer reports. */
export interface FilamentSlot {
  /** 0-based slot index. Maps to a PrusaSlicer extruder (index + 1). */
  index: number;
  /** "#RRGGBB" as reported by the printer. */
  colourHex?: string;
  /** "PLA", "PETG", "ABS", "PLA-CF", … */
  material?: string;
  /** Vendor label, e.g. "Bambu PLA Basic". */
  label?: string;
  /** 0–100 if the printer estimates remaining filament. */
  remainingPct?: number;
  /** False when the slot is empty. */
  loaded?: boolean;
}

/** Live status of one printer. */
export interface PrinterStatus {
  /** PrinterConnection.id this status belongs to. */
  id: string;
  state: PrinterState;
  /** Name of the file currently printing. */
  jobName?: string;
  /** 0–100. */
  progressPct?: number;
  /** Seconds remaining, when the printer estimates it. */
  timeRemainingSec?: number;
  /** Current layer / total layers, when reported. */
  currentLayer?: number;
  totalLayers?: number;
  nozzleTempC?: number;
  nozzleTargetC?: number;
  bedTempC?: number;
  bedTargetC?: number;
  /** Loaded filaments (AMS/MMU). Empty or single-entry on simple printers. */
  filaments?: FilamentSlot[];
  /** Human-readable detail, especially for "error". */
  message?: string;
  /** ISO timestamp this status was observed. */
  observedAt: string;
}

/** Outcome of probing a connection's reachability + credentials. */
export interface PrinterTestResult {
  ok: boolean;
  /** Plain-language result, shown directly to the user. */
  message: string;
  /** Firmware / server version string, when the probe learns one. */
  version?: string;
  /** Geometry the probe discovered — merged into the connection on save. */
  discovered?: {
    model?: string;
    bed?: { x: number; y: number; z: number };
    nozzleMm?: number;
    filamentSlots?: number;
  };
}

/** How to send a job. */
export interface SendJobOptions {
  /**
   * Start the print immediately after upload.
   *
   * SAFETY: default false. A print started on a bed that still holds the last
   * part damages the printer and can be a fire risk, and no consumer FDM
   * printer reliably senses a clear bed. Slicely only sets this true when the
   * user has explicitly armed auto-start for that printer.
   */
  startImmediately: boolean;
  /** Filename to store on the printer. Defaults to the G-code's basename. */
  jobName?: string;
}

export interface SendJobResult {
  ok: boolean;
  /** Vendor job/file id, when one is returned. */
  jobId?: string;
  /** Whether the print was actually started (vs. just uploaded). */
  started: boolean;
  /** Plain-language result for the user. */
  message: string;
}

/** A printer found on the LAN by the discovery scanner. */
export interface DiscoveredPrinter {
  transport: PrinterTransport;
  host: string;
  port: number;
  /** Best-effort friendly name from mDNS/HTTP probe. */
  label: string;
  /** Device model, when the probe reveals it. */
  model?: string;
  /** What the user still has to supply, e.g. "Needs an API key". */
  needs?: string;
}

/**
 * Every transport implements this. Drivers are pure network clients: they take
 * a ResolvedPrinter and talk to it. They never touch disk beyond reading the
 * G-code file they are asked to upload, and never persist anything.
 */
export interface PrinterDriver {
  readonly transport: PrinterTransport;
  /** Default TCP port for this transport. */
  readonly defaultPort: number;
  /** Human label for the picker, e.g. "OctoPrint". */
  readonly label: string;
  /** Which credential fields the setup UI must collect. */
  readonly requiredSecrets: ReadonlyArray<keyof PrinterSecrets>;

  /** Probe reachability + credentials. Must never throw — return ok:false. */
  test(printer: ResolvedPrinter): Promise<PrinterTestResult>;

  /** Fetch live status. Must never throw — return state "offline"/"error". */
  status(printer: ResolvedPrinter): Promise<PrinterStatus>;

  /** Upload a G-code file, optionally starting it. */
  send(
    printer: ResolvedPrinter,
    gcodePath: string,
    opts: SendJobOptions,
  ): Promise<SendJobResult>;

  /** Optional job controls; omit when the transport can't do it. */
  pause?(printer: ResolvedPrinter): Promise<SendJobResult>;
  resume?(printer: ResolvedPrinter): Promise<SendJobResult>;
  cancel?(printer: ResolvedPrinter): Promise<SendJobResult>;
}

/** What the printer picker in the UI renders. */
export interface PrinterChoiceV2 {
  id: string;
  label: string;
  transport: PrinterTransport;
  state: PrinterState;
  /** Present when the printer reports live progress. */
  progressPct?: number;
  /** True for the connection currently selected as the send target. */
  active: boolean;
  /** True when the user has armed unattended auto-start for this printer. */
  autoStart: boolean;
}
