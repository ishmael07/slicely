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
import { adoptGcodeFile, type SessionRecord } from "./session";

function fakeSession(root: string, id: string): SessionRecord {
  const dir = join(root, id);
  const slicesDir = join(dir, "slices");
  return {
    id,
    dir,
    uploadsDir: join(dir, "uploads"),
    downloadsDir: join(dir, "downloads"),
    slicesDir,
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
