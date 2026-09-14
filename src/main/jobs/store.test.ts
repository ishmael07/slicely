import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { cancelJob } from "./index";
import { isCancelRequested } from "./runner";
import { DEFAULT_SESSION_ID, runInSession, sessionContext } from "../session-context";
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

// ── One store per session ────────────────────────────────────────────────────
//
// The store used to be one `<workdir>/jobs.json` for the whole process, which
// on a shared server meant every visitor's job queue was one file that every
// other visitor's agent could read, list, and re-run. The file is now the
// ambient session's — and the default session's file must NOT have moved, or an
// existing Electron install would silently lose its queue.

test("the default session's jobs.json is still <workdir>/jobs.json — Electron's file does not move", async () => {
  await saveJobs([fakeJob("electron")]);

  // Not "a file exists somewhere": the exact path v1 wrote, read back raw.
  const onDisk = JSON.parse(await readFile(join(WORKDIR, "jobs.json"), "utf8")) as PrintJob[];
  assert.deepEqual(onDisk.map((j) => j.id), ["electron"]);

  // And explicitly inside the default session, which is what Electron's
  // out-of-request calls resolve to, for the same answer.
  const viaDefault = await runInSession(sessionContext(DEFAULT_SESSION_ID), () => loadJobs());
  assert.deepEqual(viaDefault.map((j) => j.id), ["electron"]);
});

test("each session gets its own jobs.json and cannot see another session's jobs", async () => {
  const dirA = join(WORKDIR, "sessions", "alice");
  const dirB = join(WORKDIR, "sessions", "bob");
  const ctxA = sessionContext("alice", dirA);
  const ctxB = sessionContext("bob", dirB);

  await saveJobs([fakeJob("electron")]);
  await runInSession(ctxA, () => saveJobs([fakeJob("job-a")]));
  await runInSession(ctxB, () => saveJobs([fakeJob("job-b")]));

  // Three separate files, one per session.
  for (const [dir, id] of [[dirA, "job-a"], [dirB, "job-b"]] as const) {
    const onDisk = JSON.parse(await readFile(join(dir, "jobs.json"), "utf8")) as PrintJob[];
    assert.deepEqual(onDisk.map((j) => j.id), [id]);
  }

  assert.deepEqual((await runInSession(ctxA, () => loadJobs())).map((j) => j.id), ["job-a"]);
  assert.deepEqual((await runInSession(ctxB, () => loadJobs())).map((j) => j.id), ["job-b"]);
  assert.deepEqual((await loadJobs()).map((j) => j.id), ["electron"]);

  // A job id from another session is simply absent — the same answer a
  // made-up id gets, so a lookup cannot confirm the id exists on the server.
  assert.equal(await runInSession(ctxA, () => getJobById("job-b")), undefined);
  assert.equal(await runInSession(ctxB, () => getJobById("job-a")), undefined);
  assert.equal(await runInSession(ctxB, () => getJobById("electron")), undefined);

  // Writing in one session leaves the others untouched.
  await runInSession(ctxA, () => upsertJob(fakeJob("job-a2")));
  assert.deepEqual(
    (await runInSession(ctxA, () => loadJobs())).map((j) => j.id).sort(),
    ["job-a", "job-a2"],
  );
  assert.deepEqual((await runInSession(ctxB, () => loadJobs())).map((j) => j.id), ["job-b"]);
});

// ── Cancelling is scoped too (Extra E1) ──────────────────────────────────────
//
// `cancelJob` used to call `requestCancel(id)` FIRST and only then look the job
// up. The lookup is session-scoped, but the cancellation set is process-wide
// and is consulted by the runner at every plate boundary — so a visitor who
// guessed or was leaked a job id could stop a stranger's print mid-run, and the
// stop stuck even though the lookup immediately afterwards found nothing.

test("cancelJob ignores a job id this session does not own, without touching the process-wide cancel set", async () => {
  const ctxA = sessionContext("cancel-alice", join(WORKDIR, "sessions", "cancel-alice"));
  const ctxB = sessionContext("cancel-bob", join(WORKDIR, "sessions", "cancel-bob"));

  const mine = fakeJob("cancel-mine");
  const theirs = fakeJob("cancel-theirs");
  await runInSession(ctxA, () => saveJobs([mine]));
  await runInSession(ctxB, () => saveJobs([theirs]));

  // Alice tries to cancel Bob's job.
  await runInSession(ctxA, () => cancelJob("cancel-theirs"));
  assert.equal(
    isCancelRequested("cancel-theirs"),
    false,
    "a foreign job id must never reach requestCancel — the set is process-wide",
  );
  // And Bob's persisted job is untouched.
  assert.equal((await runInSession(ctxB, () => getJobById("cancel-theirs")))?.status, "planned");

  // A made-up id is the same no-op.
  await runInSession(ctxA, () => cancelJob("cancel-never-existed"));
  assert.equal(isCancelRequested("cancel-never-existed"), false);

  // Alice cancelling HER OWN job still works, and still persists.
  await runInSession(ctxA, () => cancelJob("cancel-mine"));
  assert.equal(isCancelRequested("cancel-mine"), true);
  assert.equal((await runInSession(ctxA, () => getJobById("cancel-mine")))?.status, "cancelled");
});
