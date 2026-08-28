// ─────────────────────────────────────────────────────────────────────────────
// Type-only mirrors of the three v2 façades (src/main/printers, src/main/
// sourcing, src/main/jobs) that other agents are building in parallel with
// this web layer. Sibling PRs may not have landed those directories yet.
//
// Why this file exists instead of plain `import { listPrinters } from
// "../main/printers"` at the top of each route file: a CommonJS `import {x}
// from "mod"` compiles to a top-level `require("mod")`, which throws the
// instant the FILE is loaded — even if the caller never touches `x` — so one
// missing façade would crash the whole server (and every unrelated test) at
// boot. Instead, each `loadXxxApi()` below does the `require` lazily and
// swallows a missing module, so:
//   1. the server still boots, and every OTHER route still works, even before
//      these three directories exist (the affected routes answer 503 instead
//      of taking the process down with them), and
//   2. tests can hand a route factory a fake implementation directly and
//      never risk touching the real module, network, or PrusaSlicer.
// Once src/main/printers|sourcing|jobs land, nothing here needs to change —
// the next `require` picks up the real module automatically.
//
// The interfaces below are typed by hand from the shared contracts
// (src/shared/printers.ts, src/shared/sourcing.ts, src/shared/jobs.ts) to
// match the façades' documented exports exactly.
import type {
  PrinterConnection,
  PrinterSecrets,
  PrinterTestResult,
  PrinterStatus,
  PrinterTransport,
  SendJobOptions,
  SendJobResult,
  DiscoveredPrinter,
} from "../shared/printers";
import type {
  SourceId,
  SearchOptions,
  SearchOutcome,
  UrlResolution,
} from "../shared/sourcing";
import type { DownloadResult } from "../shared/types";
import type {
  PrintJob,
  JobEvent,
  JobPlanOptions,
  OrientationResult,
  OrientationOptions,
} from "../shared/jobs";
import type { SourceAvailability } from "../shared/sourcing";
import type { PrintGoal, PrintMaterial, SliceParams } from "../shared/types";

/** The minimal per-part input planJob actually accepts — NOT the full
 *  `JobPart` (which also carries computed fields like size/orientation that
 *  only exist once a job has been planned). */
export interface PlanJobPartInput {
  path: string;
  copies?: number;
  colourHex?: string;
}

/** Mirrors "../main/printers". */
export interface PrintersApi {
  listPrinters(): Promise<PrinterConnection[]>;
  addPrinter(
    input: Omit<PrinterConnection, "id"> & PrinterSecrets,
  ): Promise<{ printer: PrinterConnection; test: PrinterTestResult }>;
  updatePrinter(
    id: string,
    patch: Partial<PrinterConnection & PrinterSecrets>,
  ): Promise<PrinterConnection>;
  removePrinter(id: string): Promise<void>;
  testPrinter(id: string): Promise<PrinterTestResult>;
  allStatuses(): Promise<PrinterStatus[]>;
  printerStatus(id: string): Promise<PrinterStatus>;
  sendToPrinter(
    id: string,
    gcodePath: string,
    opts?: Partial<SendJobOptions>,
  ): Promise<SendJobResult>;
  controlPrinter(
    id: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<SendJobResult>;
  discoverPrinters(timeoutMs?: number): Promise<DiscoveredPrinter[]>;
  setActivePrinter(id: string | undefined): Promise<void>;
  setAutoStart(id: string, armed: boolean): Promise<void>;
  driverLabels(): Array<{
    transport: PrinterTransport;
    label: string;
    defaultPort: number;
    requiredSecrets: string[];
  }>;
}

/** Mirrors "../main/sourcing". */
export interface SourcingApi {
  searchModels(query: string, opts?: SearchOptions): Promise<SearchOutcome>;
  resolveUrl(url: string): Promise<UrlResolution>;
  downloadModel(
    source: SourceId,
    modelId: string,
    opts?: { fileId?: string; destDir?: string },
  ): Promise<DownloadResult>;
  downloadFromUrl(
    url: string,
    opts?: { destDir?: string },
  ): Promise<DownloadResult>;
  sourceAvailability(): SourceAvailability[];
}

/** Mirrors "../main/jobs". */
export interface JobsApi {
  planJob(
    parts: PlanJobPartInput[],
    opts: JobPlanOptions & { name?: string; goal?: PrintGoal; material?: PrintMaterial; params?: SliceParams },
  ): Promise<PrintJob>;
  runJob(
    jobId: string,
    onEvent?: (e: JobEvent) => void,
  ): Promise<PrintJob>;
  getJob(id: string): Promise<PrintJob | undefined>;
  listJobs(): Promise<PrintJob[]>;
  chooseOrientation(
    meshPath: string,
    opts?: OrientationOptions,
  ): Promise<OrientationResult>;
}

/** Best-effort require of a not-yet-guaranteed sibling module. Never throws —
 *  returns undefined (and logs) when the module is missing or fails to load,
 *  so the caller can degrade a single subsystem instead of the whole server. */
function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(id) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "MODULE_NOT_FOUND") {
      // The module exists but blew up on load (a real bug) — surface it in
      // the server log even though we still degrade gracefully.
      console.error(`[facades] "${id}" failed to load:`, err);
    }
    return undefined;
  }
}

export function loadPrintersApi(): PrintersApi | undefined {
  return tryRequire<PrintersApi>("../main/printers");
}

export function loadSourcingApi(): SourcingApi | undefined {
  return tryRequire<SourcingApi>("../main/sourcing");
}

export function loadJobsApi(): JobsApi | undefined {
  return tryRequire<JobsApi>("../main/jobs");
}
