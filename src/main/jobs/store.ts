// Persist jobs to the AMBIENT SESSION's jobs.json. A flat JSON array is plenty
// for the expected scale (a hobbyist's queue of print jobs, not a database
// workload) and keeps this dependency-free.
//
// One file per session, not one file per server. A single shared
// `<workdir>/jobs.json` made every job on the box readable by every visitor:
// the agent's `job_status` with no arguments listed all of them, `job_status
// {jobId}` handed back somebody else's plan (and emitted a `job` event, which
// the chat route records as ownership — so the REST routes then served it too),
// and `run_job {jobId}` re-sliced a stranger's parts on their behalf. Scoping
// the FILE removes the whole class: a foreign id is simply not in this
// session's store, so it reads as "no such job" without anything having to
// remember to check.
//
// For the default session — Electron, and any startup code outside a request —
// `sessionFile` resolves to the plain workdir, so the path stays exactly
// `<workdir>/jobs.json` and an existing install keeps its queue.
//
// Writes are atomic (write to a sibling temp file, then rename onto the real
// path) so a crash or power loss mid-write can never leave jobs.json
// truncated/corrupt — `rename` is atomic on the same filesystem on both
// POSIX and Windows. This guards against corruption from an interrupted
// WRITE; it is not a transaction log, so two processes racing a
// load-modify-save cycle at the same instant can still clobber each other's
// change. That's an accepted limitation for a single-user desktop app /
// single-process web server, which is this repo's actual deployment shape.
//
// A missing or unparsable file starts empty rather than throwing — the very
// first run has no jobs.json yet, and a half-written-then-crashed file
// should degrade to "no jobs" rather than take the app down.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { PrintJob } from "../../shared/jobs";
import { sessionFile } from "../session-context";

function jobsPath(): string {
  return sessionFile("jobs.json");
}

export async function loadJobs(): Promise<PrintJob[]> {
  try {
    const text = await readFile(jobsPath(), "utf8");
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as PrintJob[]) : [];
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: PrintJob[]): Promise<void> {
  const path = jobsPath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(jobs, null, 2), "utf8");
  await rename(tmp, path);
}

export async function getJobById(id: string): Promise<PrintJob | undefined> {
  const jobs = await loadJobs();
  return jobs.find((j) => j.id === id);
}

/** Insert or replace (by id) and persist. */
export async function upsertJob(job: PrintJob): Promise<void> {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.push(job);
  await saveJobs(jobs);
}
