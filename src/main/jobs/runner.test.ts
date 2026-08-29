import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDurationToMinutes, requestCancel, runJob, type SliceFn } from "./runner";
import type { JobEvent, JobPart, JobPlate, PrintJob } from "../../shared/jobs";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCubeTriangles, trianglesToBinaryStl } from "./testFixtures";

function jobPart(path: string, copies = 1): JobPart {
  return { path, name: path, copies, sizeX: 10, sizeY: 10, sizeZ: 10 };
}

function plate(index: number, parts: JobPart[]): JobPlate {
  return { index, parts, status: "planned", colours: [] };
}

let jobCounter = 0;
function job(plates: JobPlate[]): PrintJob {
  const now = new Date().toISOString();
  return {
    id: `job-${jobCounter++}`,
    name: "test job",
    createdAt: now,
    updatedAt: now,
    status: "planned",
    plates,
    params: {},
    goal: "quality",
    material: "PLA",
    notes: [],
  };
}

test("a failed plate does not abort the run — other plates still slice, and the failure is reflected in job.status", async () => {
  const j = job([plate(1, [jobPart("/a.stl")]), plate(2, [jobPart("/b.stl")]), plate(3, [jobPart("/c.stl")])]);

  const sliceFn: SliceFn = async (stlPath) => {
    if (stlPath === "/b.stl") throw new Error("simulated slicer failure");
    return { gcodePath: `${stlPath}.gcode`, filamentUsedG: 5, estimatedPrintTime: "10m" };
  };

  const events: JobEvent[] = [];
  const result = await runJob(j, (e) => events.push(e), { sliceFn });

  assert.equal(result.plates[0].status, "ready");
  assert.equal(result.plates[1].status, "failed");
  assert.equal(result.plates[2].status, "ready", "plate 3 must still have been attempted after plate 2 failed");
  assert.ok(result.plates[1].error?.includes("simulated slicer failure"));
  assert.equal(result.status, "failed");

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "plate_start", "plate_done",
    "plate_start", "plate_failed",
    "plate_start", "plate_done",
    "job_failed",
  ]);
});

test("a fully successful run marks every plate ready and the job status 'ready', emitting job_done", async () => {
  const j = job([plate(1, [jobPart("/a.stl")]), plate(2, [jobPart("/b.stl")])]);
  const sliceFn: SliceFn = async (stlPath) => ({
    gcodePath: `${stlPath}.gcode`,
    filamentUsedG: 10,
    filamentCost: 0.5,
    estimatedPrintTime: "1h 5m",
  });

  const events: JobEvent[] = [];
  const result = await runJob(j, (e) => events.push(e), { sliceFn });

  assert.ok(result.plates.every((p) => p.status === "ready"));
  assert.equal(result.status, "ready");
  assert.equal(events[events.length - 1].type, "job_done");
  assert.equal(result.totals?.filamentG, 20);
  assert.equal(result.totals?.filamentCost, 1);
  assert.equal(result.totals?.estimatedMinutes, 65 * 2);
});

test("cancellation stops before the next plate and marks the job cancelled", async () => {
  const j = job([plate(1, [jobPart("/a.stl")]), plate(2, [jobPart("/b.stl")]), plate(3, [jobPart("/c.stl")])]);

  let sliced = 0;
  const sliceFn: SliceFn = async (stlPath) => {
    sliced++;
    if (stlPath === "/a.stl") requestCancel(j.id); // cancel mid-flight, before plate 2 starts
    return { gcodePath: `${stlPath}.gcode` };
  };

  const result = await runJob(j, undefined, { sliceFn });
  assert.equal(sliced, 1, "only the in-flight plate should have been sliced before the cancellation took effect");
  assert.equal(result.status, "cancelled");
  assert.equal(result.plates[0].status, "ready");
  assert.equal(result.plates[1].status, "planned");
  assert.equal(result.plates[2].status, "planned");
});

test("re-running a job with a previously-failed plate retries only the non-ready plates", async () => {
  const j = job([plate(1, [jobPart("/a.stl")]), plate(2, [jobPart("/b.stl")])]);
  let attempt = 0;
  const flakySlice: SliceFn = async (stlPath) => {
    if (stlPath === "/b.stl" && attempt === 0) {
      attempt++;
      throw new Error("first attempt fails");
    }
    return { gcodePath: `${stlPath}.gcode` };
  };

  const first = await runJob(j, undefined, { sliceFn: flakySlice });
  assert.equal(first.status, "failed");

  const calledPaths: string[] = [];
  const secondSliceFn: SliceFn = async (stlPath) => {
    calledPaths.push(stlPath);
    return { gcodePath: `${stlPath}.gcode` };
  };
  const second = await runJob(first, undefined, { sliceFn: secondSliceFn });
  assert.deepEqual(calledPaths, ["/b.stl"], "plate 1 was already ready and should not be re-sliced");
  assert.equal(second.status, "ready");
});

test("a multi-part plate is sliced from ONE 3MF project, never from a list of STLs", async () => {
  // Passing several STLs to PrusaSlicer's CLI loses parts: without --merge it
  // re-exports every input to the same --output, so only the LAST survives
  // (verified — slicing A+B produced byte-identical G-code to B alone), and
  // with --merge it fails outright. A 3MF holds many objects in one file.
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-"));
  const a = join(dir, "a.stl");
  const b = join(dir, "b.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));
  writeFileSync(b, trianglesToBinaryStl(buildCubeTriangles(8)));

  try {
    const j = job([plate(1, [jobPart(a, 1), jobPart(b, 2)])]);
    let slicedPath: string | undefined;
    let extra: string[] | undefined;
    const sliceFn: SliceFn = async (stlPath, params) => {
      slicedPath = stlPath;
      extra = params?.extraInputs;
      return { gcodePath: "out.gcode" };
    };
    await runJob(j, undefined, { sliceFn });

    assert.match(slicedPath ?? "", /\.3mf$/, "the plate must be sliced as a project file");
    assert.ok(existsSync(slicedPath!), "the 3MF must actually be written");
    assert.equal(extra, undefined, "extraInputs is the path that drops parts");

    // Every instance must be in the project: 1 of A plus 2 of B. The 3MF is a
    // deflated ZIP, so read the model document out of it properly.
    const unzipper = await import("unzipper");
    const archive = await unzipper.Open.file(slicedPath!);
    const entry = archive.files.find((f) => f.path === "3D/3dmodel.model");
    assert.ok(entry, "the project must contain a 3MF model document");
    const model = (await entry!.buffer()).toString("utf8");
    const objects = (model.match(/<object id=/g) ?? []).length;
    assert.equal(
      objects,
      3,
      "one object per physical instance — a dropped copy is a part that never prints",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("parseDurationToMinutes handles day/hour/minute/second components", () => {
  assert.equal(parseDurationToMinutes("1d 2h 3m 4s"), 24 * 60 + 2 * 60 + 3 + Math.round(4 / 60));
  assert.equal(parseDurationToMinutes("45m 30s"), 45 + Math.round(30 / 60));
  assert.equal(parseDurationToMinutes(undefined), undefined);
  assert.equal(parseDurationToMinutes("garbage"), undefined);
});
