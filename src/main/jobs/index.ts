// Façade for the job-level smart-slicing system (P3). Other modules
// (agent tools, the web server) should only ever import from here — the
// sibling files (mesh/orientation/colour/planner/runner/store) are
// implementation detail and free to change shape.

import type {
  ColourPlan,
  JobEvent,
  JobPart,
  JobPlanOptions,
  OrientationOptions,
  OrientationResult,
  PrintJob,
} from "../../shared/jobs";
import type { FilamentSlot } from "../../shared/printers";
import type { PrintGoal, PrintMaterial, SliceParams } from "../../shared/types";
import { planJob as planJobInternal, type PlanJobInput } from "./planner";
import { requestCancel, runJob as runJobInternal } from "./runner";
import { chooseOrientation as chooseOrientationFromTriangles } from "./orientation";
import { planColours as planColoursSync } from "./colour";
import { parseMesh } from "./mesh";
import { getJobById, loadJobs, upsertJob } from "./store";

export async function planJob(
  parts: Array<{ path: string; copies?: number; colourHex?: string }>,
  opts: JobPlanOptions & { name?: string; goal?: PrintGoal; material?: PrintMaterial; params?: SliceParams },
): Promise<PrintJob> {
  const input: PlanJobInput[] = parts;
  const job = await planJobInternal(input, opts);
  await upsertJob(job);
  return job;
}

export async function runJob(jobId: string, onEvent?: (e: JobEvent) => void): Promise<PrintJob> {
  const job = await getJobById(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const result = await runJobInternal(job, onEvent);
  await upsertJob(result);
  return result;
}

export async function getJob(id: string): Promise<PrintJob | undefined> {
  return getJobById(id);
}

export async function listJobs(): Promise<PrintJob[]> {
  return loadJobs();
}

export async function cancelJob(id: string): Promise<void> {
  // Signal an in-flight runJob (in THIS process) to stop at the next plate
  // boundary, and — for a job that isn't actively slicing right now (e.g.
  // still "planned", or a run that already ended in a different process
  // lifetime) — mark it cancelled directly so the persisted state is
  // correct even if no runner is listening.
  requestCancel(id);
  const job = await getJobById(id);
  if (!job) return;
  if (job.status !== "slicing" && job.status !== "printing") {
    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
    await upsertJob(job);
  }
}

export async function chooseOrientation(
  meshPath: string,
  opts?: OrientationOptions,
): Promise<OrientationResult> {
  const mesh = await parseMesh(meshPath);
  return chooseOrientationFromTriangles(mesh.triangles, opts);
}

export async function planColours(parts: JobPart[], slots: FilamentSlot[]): Promise<ColourPlan> {
  return planColoursSync(parts, slots);
}

/** Result of splitting a model into its separate solid pieces. */
export interface SplitResult {
  name: string;
  /** How many significant pieces the mesh contains (1 = nothing to split). */
  pieces: number;
  /** Files written, one per piece, when `write` was true. */
  paths: string[];
  sizes: Array<{ x: number; y: number; z: number }>;
  /** Fragments too small to be real parts, ignored. */
  dropped: number;
  written: boolean;
}

/**
 * Split one model into its disconnected solids, optionally writing each as its
 * own STL beside the original so it can be printed as a separate part.
 *
 * This is what lets a single file get several colours: the pieces flow through
 * the ordinary multi-part path, where each already gets its own filament.
 */
export async function splitModel(
  meshPath: string,
  write = true,
): Promise<SplitResult> {
  const { parseMesh } = await import("./mesh");
  const { splitShells, significantShells, writeShellStl } = await import("./shells");
  const { basename, dirname, join, extname } = await import("node:path");

  const mesh = await parseMesh(meshPath);
  const all = splitShells(mesh.triangles);
  const shells = significantShells(all);
  const name = basename(meshPath);

  const result: SplitResult = {
    name,
    pieces: shells.length,
    paths: [],
    sizes: shells.map((s) => s.size),
    dropped: all.length - shells.length,
    written: false,
  };
  if (shells.length <= 1 || !write) return result;

  const stem = basename(meshPath, extname(meshPath));
  const dir = dirname(meshPath);
  shells.forEach((shell, i) => {
    const dest = join(dir, `${stem}-part${String(i + 1).padStart(2, "0")}.stl`);
    writeShellStl(dest, shell);
    result.paths.push(dest);
  });
  result.written = true;
  return result;
}

/**
 * A small, drawable version of a model for the viewer.
 *
 * Decimated and normalised server-side because real meshes are far too heavy
 * to send: a 386k-triangle model is ~14MB of raw floats.
 */
export async function previewMesh(
  meshPath: string,
  target?: number,
): Promise<import("./preview").PreviewMesh> {
  const { parseMesh } = await import("./mesh");
  const { buildPreviewMesh } = await import("./preview");
  const mesh = await parseMesh(meshPath);
  return buildPreviewMesh(mesh.triangles, target);
}
