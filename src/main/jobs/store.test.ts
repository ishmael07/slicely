import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts caches its resolved workdir on first getConfig() call and never
// re-reads the environment afterward, so this MUST be set before any store.ts
// function runs. Since test() callbacks only execute after this file's
// synchronous top-level has fully finished, setting it here (regardless of
// where it lands relative to import hoisting) is safe.
const WORKDIR = join(tmpdir(), `slicely-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SLICELY_WORKDIR = WORKDIR;

import { getJobById, loadJobs, saveJobs, upsertJob } from "./store";
import type { PrintJob } from "../../shared/jobs";

// Every test in this file shares WORKDIR (config.ts's caching leaves no way to
// give each test its own), so cleanup can't live in a per-test finally — an
// `after` hook removes it once, when the whole file is done.
after(async () => {
  await rm(WORKDIR, { recursive: true, force: true });
});

function fakeJob(id: string): PrintJob {
  const now = new Date().toISOString();
  return {
    id, name: id, createdAt: now, updatedAt: now,
    status: "planned", plates: [], params: {}, goal: "quality", material: "PLA", notes: [],
  };
}

test("loadJobs starts empty when jobs.json doesn't exist yet", async () => {
  const jobs = await loadJobs();
  assert.deepEqual(jobs, []);
});

test("saveJobs writes atomically (no leftover .tmp- file) and loadJobs reads it back", async () => {
  await saveJobs([fakeJob("a"), fakeJob("b")]);
  const jobs = await loadJobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.id).sort(), ["a", "b"]);

  const files = await readdir(WORKDIR);
  assert.ok(!files.some((f) => f.includes(".tmp-")), `leftover temp file(s): ${files.join(", ")}`);
});

test("upsertJob inserts new and replaces existing by id", async () => {
  await saveJobs([fakeJob("x")]);
  await upsertJob(fakeJob("y"));
  let jobs = await loadJobs();
  assert.equal(jobs.length, 2);

  const updated = fakeJob("x");
  updated.name = "renamed";
  await upsertJob(updated);
  jobs = await loadJobs();
  assert.equal(jobs.length, 2);
  const found = await getJobById("x");
  assert.equal(found?.name, "renamed");
});

test("a corrupt jobs.json starts empty rather than throwing", async () => {
  await mkdir(WORKDIR, { recursive: true });
  await writeFile(join(WORKDIR, "jobs.json"), "{ this is not valid json ]]]");
  const jobs = await loadJobs();
  assert.deepEqual(jobs, []);
});

test("a jobs.json containing a non-array value also starts empty", async () => {
  await writeFile(join(WORKDIR, "jobs.json"), JSON.stringify({ not: "an array" }));
  const jobs = await loadJobs();
  assert.deepEqual(jobs, []);
});
