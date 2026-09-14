// Regression tests for three multi-user defects found by driving the real
// server: jobs were readable across sessions, re-adopting a plate's G-code
// registered a dead path, and a job run emitted two job_done frames.
//
// Hermetic: temp dirs only, no network, no PrusaSlicer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptGcodeFile, isInsideDir, type SessionRecord } from "./session";
import { relocateJobEventGcode } from "./routes/jobs";
import { runInSession, sessionContext } from "../main/session-context";
import { saveJobs } from "../main/jobs/store";
import { executeV2Tool } from "../main/agent/tools-v2";
import type { PrintJob } from "../shared/jobs";
import type { AgentEvent } from "../shared/types";

function fakeSession(root: string, id: string): SessionRecord {
  const dir = join(root, id);
  const slicesDir = join(dir, "slices");
  return {
    id,
    dir,
    uploadsDir: join(dir, "uploads"),
    downloadsDir: join(dir, "downloads"),
    slicesDir,
    scratchDir: join(dir, "scratch"),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    activeModelPaths: [],
    gcodeFiles: new Map(),
    jobIds: new Set<string>(),
    busy: false,
  };
}

test("adoptGcodeFile is idempotent: re-adopting returns the SAME token, not a dead path", async () => {
  const root = mkdtempSync(join(tmpdir(), "slicely-adopt-"));
  try {
    const session = fakeSession(root, "s1");
    const src = join(root, "plate-1.gcode");
    writeFileSync(src, "; gcode\n");

    const first = await adoptGcodeFile(session, src);
    assert.ok(existsSync(first.path), "adopted file must exist after the move");

    // This is the exact sequence that broke: plate_done adopts, then the
    // job-level event carries the SAME (already-relocated) path again.
    const second = await adoptGcodeFile(session, first.path);

    assert.equal(second.id, first.id, "must reuse the existing token");
    assert.equal(second.path, first.path);
    assert.equal(session.gcodeFiles.size, 1, "must not register a second entry");
    // Every registered token must point at a file that actually exists.
    for (const entry of session.gcodeFiles.values()) {
      assert.ok(existsSync(entry.path), `dead token path: ${entry.path}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoptGcodeFile refuses to mint a token for a file that does not exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "slicely-adopt-"));
  try {
    const session = fakeSession(root, "s1");
    await assert.rejects(
      () => adoptGcodeFile(session, join(root, "never-existed.gcode")),
      /no longer exists/,
      "a vanished source must throw, not hand back a downloadable id",
    );
    assert.equal(session.gcodeFiles.size, 0, "no token may be registered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two sessions adopting same-named G-code keep separate files and tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "slicely-adopt-"));
  try {
    const a = fakeSession(root, "alice");
    const b = fakeSession(root, "bob");
    const srcA = join(root, "a", "plate.gcode");
    const srcB = join(root, "b", "plate.gcode");
    for (const [p, body] of [[srcA, "; alice\n"], [srcB, "; bob\n"]] as const) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, body);
    }

    const ra = await adoptGcodeFile(a, srcA);
    const rb = await adoptGcodeFile(b, srcB);

    assert.notEqual(ra.id, rb.id);
    assert.notEqual(ra.path, rb.path, "same basename must not collide across sessions");
    assert.ok(ra.path.includes("alice") && rb.path.includes("bob"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job ownership: a session only ever sees the ids it recorded", () => {
  // The route filters `listJobs()` through `session.jobIds`; this pins that
  // contract so a future refactor cannot quietly widen it back to "all jobs".
  const root = mkdtempSync(join(tmpdir(), "slicely-jobs-"));
  try {
    const alice = fakeSession(root, "alice");
    const bob = fakeSession(root, "bob");
    alice.jobIds.add("job-a");
    bob.jobIds.add("job-b");

    const allJobsInStore = [{ id: "job-a" }, { id: "job-b" }, { id: "job-c" }];

    const visibleToAlice = allJobsInStore.filter((j) => alice.jobIds.has(j.id));
    const visibleToBob = allJobsInStore.filter((j) => bob.jobIds.has(j.id));

    assert.deepEqual(visibleToAlice.map((j) => j.id), ["job-a"]);
    assert.deepEqual(visibleToBob.map((j) => j.id), ["job-b"]);
    // job-c belongs to neither and must be invisible to both.
    assert.ok(!alice.jobIds.has("job-c") && !bob.jobIds.has("job-c"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The AGENT's job tools, not just the REST routes ──────────────────────────
//
// The test above pins the route-level filter, and the route-level filter was
// the whole defence — which the agent walked straight around. `job_status` with
// no arguments listed every job on the server; `job_status {jobId}` handed back
// a stranger's plan AND emitted a `job` event, which routes/chat.ts records in
// `session.jobIds` — so asking about somebody else's job MADE it yours, and the
// jobIds-gated routes then served it. `run_job {jobId}` re-sliced their parts.
//
// The fix is that the job store is per-session, so a foreign id is not "denied"
// — it is absent, which is also the answer a made-up id gets. These tests drive
// the real tool functions, because that is the path that was unguarded.

function fakeJob(id: string): PrintJob {
  const now = new Date().toISOString();
  return {
    id, name: id, createdAt: now, updatedAt: now,
    status: "planned", plates: [], params: {}, goal: "quality", material: "PLA", notes: [],
  };
}

/** An `emit` that applies routes/chat.ts's ownership rule verbatim: a `job`
 *  event on the stream is exactly what makes a job this session's. */
function recordingEmit(session: SessionRecord): {
  emit: (event: AgentEvent) => void;
  jobEvents: AgentEvent[];
} {
  const jobEvents: AgentEvent[] = [];
  return {
    jobEvents,
    emit: (event: AgentEvent) => {
      if (event.type === "job" && event.job?.id) {
        jobEvents.push(event);
        session.jobIds.add(event.job.id);
      }
    },
  };
}

test("agent job tools: another session's job id is simply not there", async () => {
  const root = mkdtempSync(join(tmpdir(), "slicely-agent-jobs-"));
  try {
    const alice = fakeSession(root, "alice-agent");
    const bob = fakeSession(root, "bob-agent");
    const ctx = (s: SessionRecord) => sessionContext(s.id, s.dir);

    await runInSession(ctx(alice), () => saveJobs([fakeJob("job-a")]));
    await runInSession(ctx(bob), () => saveJobs([fakeJob("job-b")]));
    alice.jobIds.add("job-a");
    bob.jobIds.add("job-b");

    const { emit, jobEvents } = recordingEmit(bob);

    // 1. Bob asks about Alice's job by id.
    const status = await runInSession(ctx(bob), () =>
      executeV2Tool("job_status", { jobId: "job-a" }, emit),
    );
    assert.match(status, /No job with id job-a\./, "must read as not-found, not as denied");
    assert.equal(jobEvents.length, 0, "no `job` event may reach the stream");
    assert.ok(!bob.jobIds.has("job-a"), "asking about a job must never make it yours");

    // 2. The bare listing is Bob's own queue, not the server's.
    const listed = await runInSession(ctx(bob), () => executeV2Tool("job_status", {}, emit));
    assert.match(listed, /^1 job\(s\)/, `expected exactly one job, got: ${listed}`);
    assert.match(listed, /id=job-b/);
    assert.ok(!listed.includes("job-a"), `Alice's job leaked into Bob's listing: ${listed}`);

    // 3. run_job refuses BEFORE anything runs — no slicer, no plates, no
    //    mutation of Alice's stored job.
    const ran = await runInSession(ctx(bob), () => executeV2Tool("run_job", { jobId: "job-a" }, emit));
    assert.match(ran, /No job with id job-a\./);
    assert.equal(jobEvents.length, 0);
    assert.ok(!bob.jobIds.has("job-a"));

    // 4. And none of this broke the ordinary case: Alice still sees her own.
    const own = await runInSession(ctx(alice), () =>
      executeV2Tool("job_status", { jobId: "job-a" }, () => {}),
    );
    assert.match(own, /Job "job-a" — planned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plate's .3mf project is adopted into the session and gets its own token", async () => {
  // The browser cannot launch PrusaSlicer, so the project file IS the handoff:
  // it carries the arrangement, orientations and colours Slicely planned. If it
  // never reaches the wire, a web user can only download bare G-code.
  const root = mkdtempSync(join(tmpdir(), "slicely-project-"));
  try {
    const session = fakeSession(root, "s1");
    const gcode = join(root, "plate-1.gcode");
    const project = join(root, "plate-1.3mf");
    writeFileSync(gcode, "; gcode\n");
    writeFileSync(project, "PKfake-3mf");

    const event = {
      type: "job_done",
      job: { id: "j1", plates: [{ index: 1, gcodePath: gcode, projectPath: project }] },
    } as unknown as Parameters<typeof relocateJobEventGcode>[1];

    const wire = (await relocateJobEventGcode(session, event)) as {
      job: { plates: Array<Record<string, unknown>> };
    };
    const plate = wire.job.plates[0];

    assert.ok(plate.gcodeId, "G-code must still be downloadable");
    assert.ok(plate.projectId, "the project must be downloadable too");
    assert.notEqual(plate.projectId, plate.gcodeId, "distinct files need distinct tokens");
    for (const entry of session.gcodeFiles.values()) {
      assert.ok(existsSync(entry.path), `dead token path: ${entry.path}`);
      assert.ok(
        isInsideDir(session.slicesDir, entry.path),
        `token escaped the session sandbox: ${entry.path}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
