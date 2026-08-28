// Persist jobs to <workdir>/jobs.json. A flat JSON array is plenty for the
// expected scale (a hobbyist's queue of print jobs, not a database
// workload) and keeps this dependency-free.
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
import { dirname, join } from "node:path";
import type { PrintJob } from "../../shared/jobs";
import { getConfig } from "../config";

function jobsPath(): string {
  return join(getConfig().workdir, "jobs.json");
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
