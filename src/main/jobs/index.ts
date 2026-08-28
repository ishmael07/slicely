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
