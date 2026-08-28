import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planJob } from "./planner";
import { trianglesToBinaryStl, buildBoxTriangles, rotateTriangles } from "./testFixtures";
import type { ModelInfo } from "../../shared/types";
import type { FilamentSlot } from "../../shared/printers";

/** Fake `getModelInfo`: no PrusaSlicer CLI, just a lookup table keyed by the
 *  fake paths each test uses. */
function fakeInfo(table: Record<string, { sizeX: number; sizeY: number; sizeZ: number; volumeMm3?: number }>) {
  return async (path: string): Promise<ModelInfo> => {
    const t = table[path];
    if (!t) throw new Error(`no fake info for ${path}`);
    return { filePath: path, sizeX: t.sizeX, sizeY: t.sizeY, sizeZ: t.sizeZ, volumeMm3: t.volumeMm3 ?? 1000, manifold: true };
  };
}

const SLOTS: FilamentSlot[] = [
  { index: 0, colourHex: "#ff0000", loaded: true },
  { index: 1, colourHex: "#0000ff", loaded: true },
];

test("grouping by colour cuts a job that would otherwise mix colours per plate down to single-colour plates", async () => {
  const table = {
    "/red-big.stl": { sizeX: 90, sizeY: 40, sizeZ: 10 },
    "/blue-big.stl": { sizeX: 90, sizeY: 40, sizeZ: 10 },
    "/red-small.stl": { sizeX: 20, sizeY: 20, sizeZ: 10 },
    "/blue-small.stl": { sizeX: 20, sizeY: 20, sizeZ: 10 },
  };
  const parts = [
    { path: "/red-big.stl", colourHex: "#ff0000" },
    { path: "/blue-big.stl", colourHex: "#0000ff" },
    { path: "/red-small.stl", colourHex: "#ff0000" },
    { path: "/blue-small.stl", colourHex: "#0000ff" },
  ];
  const baseOpts = {
    bed: { x: 200, y: 40, z: 100 },
    spacingMm: 6,
    autoOrient: false,
    params: { layerHeightMm: 0.2 },
    slots: SLOTS,
  };
  const deps = { getModelInfo: fakeInfo(table) };

  const ungrouped = await planJob(parts, { ...baseOpts, groupByColour: false }, deps);
  const grouped = await planJob(parts, { ...baseOpts, groupByColour: true }, deps);

  assert.ok(
    ungrouped.plates.some((p) => p.colours.length > 1),
    "sanity check: without grouping, this layout should mix colours on a plate",
  );
  assert.ok(
    grouped.plates.every((p) => p.colours.length <= 1),
    "with grouping, every plate should be a single colour",
  );
  assert.equal(grouped.totals?.toolChanges, grouped.colourPlan?.toolChanges);
});

test("parts taller than maxHeightMm are excluded from plates and reported oversized", async () => {
  const table = {
    "/short.stl": { sizeX: 20, sizeY: 20, sizeZ: 20 },
    "/tall.stl": { sizeX: 20, sizeY: 20, sizeZ: 500 },
  };
  const parts = [{ path: "/short.stl" }, { path: "/tall.stl" }];
  const job = await planJob(
    parts,
    { bed: { x: 200, y: 200, z: 200 }, maxHeightMm: 200, autoOrient: false, params: {} },
    { getModelInfo: fakeInfo(table) },
  );
  assert.equal(job.plates.length, 1);
  assert.equal(job.plates[0].parts.length, 1);
  assert.equal(job.plates[0].parts[0].path, "/short.stl");
  assert.ok(job.oversized?.some((p) => p.path === "/tall.stl"));
});

test("a part wider than the bed even alone is reported oversized by the packer", async () => {
  const table = { "/huge.stl": { sizeX: 500, sizeY: 500, sizeZ: 10 } };
  const job = await planJob(
    [{ path: "/huge.stl" }],
    { bed: { x: 200, y: 200, z: 200 }, autoOrient: false, params: {} },
    { getModelInfo: fakeInfo(table) },
  );
  assert.equal(job.plates.length, 0);
  assert.equal(job.oversized?.length, 1);
});

test("totals reflect plate/part counts at plan time", async () => {
  const table = { "/a.stl": { sizeX: 10, sizeY: 10, sizeZ: 10 } };
  const job = await planJob(
    [{ path: "/a.stl", copies: 3 }],
    { bed: { x: 200, y: 200, z: 200 }, autoOrient: false, params: {} },
    { getModelInfo: fakeInfo(table) },
  );
  assert.equal(job.totals?.partCount, 3);
  assert.equal(job.totals?.plateCount, job.plates.length);
});

test("planJob rejects an empty parts list with a clear error", async () => {
  await assert.rejects(() => planJob([], { bed: { x: 200, y: 200, z: 200 } }, {}), /at least one part/i);
});

test("end-to-end with autoOrient: a real (synthetic) STL that needs reorienting gets rotated and noted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slicely-planner-test-"));
  const path = join(dir, "plate.stl");
  try {
    // A thin plate, tilted so it isn't lying flat "as imported".
    const tilted = rotateTriangles(buildBoxTriangles(50, 30, 2), 40, 20, 0);
    await writeFile(path, trianglesToBinaryStl(tilted));

    // getModelInfo would normally report the (rotated) as-imported bbox —
    // approximate it generously here since only its rough size matters for
    // packing; the real orientation search runs against the actual mesh file.
    const job = await planJob(
      [{ path }],
      { bed: { x: 200, y: 200, z: 200 }, autoOrient: true, goal: "quality", params: { layerHeightMm: 0.2 } },
      { getModelInfo: fakeInfo({ [path]: { sizeX: 60, sizeY: 60, sizeZ: 60 } }) },
    );

    assert.equal(job.plates.length, 1);
    const jobPart = job.plates[0].parts[0];
    assert.ok(jobPart.orientation, "expected an orientation result to be attached");
    // Reoriented flat: height should collapse down toward the plate's 2mm
    // thickness, nowhere near the ~60mm bounding-box guess.
    assert.ok(jobPart.sizeZ < 10, `expected a flat reorientation, got sizeZ=${jobPart.sizeZ}`);
    assert.ok(job.notes.some((n) => /reoriented/i.test(n)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
