// Slice a planned job's plates in order, streaming progress as JobEvents.
// The one rule that matters most here: A SINGLE FAILED PLATE MUST NOT ABORT
// THE JOB. Plates already packed by planner.ts are independent PrusaSlicer
// invocations — one bad STL (non-manifold enough to trip a fatal validation
// error even after prusaslicer.ts's own auto-remediation) shouldn't cost the
// user every other plate that would have sliced fine.
//
// NOTE on how a plate is actually sliced: planner.ts already did the
// packing (via plates.ts), so each JobPlate is one bed's worth of parts with
// known copy counts. We call prusaslicer.ts's low-level `slice()` directly
// (primary + `extraInputs` + `merge`) rather than its `slicePlates()`
// convenience wrapper, because slicePlates() re-packs from scratch AND (read
// closely: it builds `extraInputs` from the DEDUPED set of other parts, so a
// plate with 3 copies of a non-primary part would only place 1). Since we
// already have the exact per-plate copy counts, we expand them ourselves
// into a flat, correctly-repeated input list.

import type { JobEvent, JobPlate, PrintJob } from "../../shared/jobs";
import type { SliceMetrics, SliceParams } from "../../shared/types";
import { slice } from "../prusaslicer";

/** Job ids with a cancellation request in flight. Checked between plates
 *  (never mid-slice — PrusaSlicer's CLI has no cooperative cancellation
 *  hook, so the soonest we can honestly stop is the next plate boundary). */
const cancelledJobs = new Set<string>();

export function requestCancel(jobId: string): void {
  cancelledJobs.add(jobId);
}

function isCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

/** Injectable for tests: the default slices for real via PrusaSlicer.
 *  Swapping this out is the only way to exercise runJob's control flow
 *  (retry/continue-on-failure, cancellation, totals) without a PrusaSlicer
 *  install or a network — the brief for this module requires hermetic
 *  tests, and Node's test runner has no built-in module-mocking we can rely
 *  on across versions. */
export type SliceFn = (
  stlPath: string,
  params?: SliceParams,
  configIni?: string,
  outName?: string,
) => Promise<SliceMetrics>;

export interface RunJobDeps {
  sliceFn?: SliceFn;
}

export async function runJob(
  job: PrintJob,
  onEvent?: (e: JobEvent) => void,
  deps: RunJobDeps = {},
): Promise<PrintJob> {
  const doSlice = deps.sliceFn ?? slice;
  const emit = (e: JobEvent) => onEvent?.(e);
  const touch = () => {
    job.updatedAt = new Date().toISOString();
  };

  let anyFailed = false;
  let cancelled = false;

  for (const plate of job.plates) {
    if (isCancelled(job.id)) {
      cancelled = true;
      break;
    }
    if (plate.status === "done" || plate.status === "ready") continue; // resume support

    plate.status = "slicing";
    touch();
    emit({ type: "plate_start", jobId: job.id, plateIndex: plate.index });

    try {
      const metrics = await sliceOnePlate(plate, job.params, doSlice);
      plate.status = "ready";
      plate.metrics = metrics;
      plate.gcodePath = metrics.gcodePath;
      plate.error = undefined;
      touch();
      emit({ type: "plate_done", jobId: job.id, plateIndex: plate.index, metrics });
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      plate.status = "failed";
      plate.error = message;
      touch();
      emit({ type: "plate_failed", jobId: job.id, plateIndex: plate.index, error: message });
      // Deliberately no `break`/`throw` — continue to the next plate.
    }
  }

  cancelledJobs.delete(job.id);
  applyTotals(job);
  touch();

  if (cancelled) {
    job.status = "cancelled";
    // JobEvent has no dedicated "cancelled" variant; job_failed is the
    // closest terminal signal a listener can rely on to stop waiting.
    emit({ type: "job_failed", jobId: job.id, error: "Cancelled by user." });
  } else if (anyFailed) {
    const failedCount = job.plates.filter((p) => p.status === "failed").length;
    job.status = "failed";
    emit({
      type: "job_failed",
      jobId: job.id,
      error: `${failedCount} of ${job.plates.length} plate(s) failed to slice.`,
    });
  } else {
    job.status = "ready";
    emit({ type: "job_done", job });
  }

  return job;
}

async function sliceOnePlate(
  plate: JobPlate,
  jobParams: SliceParams,
  doSlice: SliceFn,
): Promise<SliceMetrics> {
  if (plate.parts.length === 0) {
    throw new Error(`Plate ${plate.index} has no parts.`);
  }
  const primary = plate.parts[0];
  // File-existence is validated by the slicer function itself (the real
  // prusaslicer.ts `slice()` already throws a clear "Model file not found"
  // before spawning anything) — checking it again here would just duplicate
  // that, and would fight the `sliceFn` injection tests rely on.

  // Flatten every part's copies into one path per physical instance, then
  // pull out exactly ONE instance of the primary — the rest (including any
  // extra copies of the primary itself) become `extraInputs`.
  const flat: string[] = [];
  for (const p of plate.parts) {
    for (let i = 0; i < p.copies; i++) flat.push(p.path);
  }
  const primaryIdx = flat.indexOf(primary.path);
  if (primaryIdx >= 0) flat.splice(primaryIdx, 1);
  const extraInputs = flat;

  const params: SliceParams = {
    ...jobParams,
    ...primary.overrides,
    extraInputs,
    merge: extraInputs.length > 0 ? true : jobParams.merge,
  };

  const outName = `plate-${plate.index}`;
  return doSlice(primary.path, params, undefined, outName);
}

/** Sum whatever's known from completed plates into job.totals. Slice-derived
 *  fields (time/filament) only exist once a plate has metrics; toolChanges
 *  is carried over from the colour plan computed at plan time (slicing
 *  doesn't change it). */
function applyTotals(job: PrintJob): void {
  const done = job.plates.filter((p) => p.metrics);
  const filamentG = sumOptional(done.map((p) => p.metrics?.filamentUsedG));
  const filamentCost = sumOptional(done.map((p) => p.metrics?.filamentCost));
  const minutes = sumOptional(done.map((p) => parseDurationToMinutes(p.metrics?.estimatedPrintTime)));

  job.totals = {
    plateCount: job.plates.length,
    partCount: job.totals?.partCount ?? job.plates.reduce((s, p) => s + p.parts.reduce((s2, jp) => s2 + jp.copies, 0), 0),
    toolChanges: job.totals?.toolChanges ?? job.colourPlan?.toolChanges,
    filamentG,
    filamentCost,
    estimatedMinutes: minutes,
  };
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a + b, 0);
}

/** Parse PrusaSlicer's "estimated printing time" comment, e.g.
 *  "1d 2h 3m 4s" or "23m 45s", into whole minutes. Undefined for anything
 *  that doesn't contain at least one recognizable unit. */
export function parseDurationToMinutes(text?: string): number | undefined {
  if (!text) return undefined;
  const re = /(\d+)\s*d|(\d+)\s*h|(\d+)\s*m(?!s)|(\d+)\s*s/g;
  let totalSeconds = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    matched = true;
    if (m[1]) totalSeconds += Number(m[1]) * 86400;
    else if (m[2]) totalSeconds += Number(m[2]) * 3600;
    else if (m[3]) totalSeconds += Number(m[3]) * 60;
    else if (m[4]) totalSeconds += Number(m[4]);
  }
  return matched ? Math.round(totalSeconds / 60) : undefined;
}
