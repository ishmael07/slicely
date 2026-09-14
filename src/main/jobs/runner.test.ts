import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDurationToMinutes, requestCancel, runJob, type SliceFn } from "./runner";
import type { JobEvent, JobPart, JobPlate, PrintJob } from "../../shared/jobs";
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCubeTriangles, trianglesToBinaryStl } from "./testFixtures";
import { resetConfigForTests } from "../config";

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


test("a plate nobody asked to be coloured is sliced with NO filament_colour at all", async () => {
  // The white-plate bug, at the seam where it actually reached PrusaSlicer.
  // colour.ts fabricated "#ffffff" for a part with no requested colour, and
  // the multi-instance path here filled its own gaps with "#FFFFFF" as well,
  // so the plate's config carried an explicit `filament_colour = #FFFFFF` and
  // the project opened WHITE. Writing no key leaves PrusaSlicer's own default,
  // which is the honest answer when nobody has said anything about colour.
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-nocolour-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const j = job([plate(1, [jobPart(a, 2)])]); // 2 copies => the 3MF project path
    j.bed = { x: 220, y: 220, z: 250 };
    let configPath: string | undefined;
    const sliceFn: SliceFn = async (_p, _params, configIni) => {
      configPath = configIni;
      return { gcodePath: "out.gcode" };
    };
    await runJob(j, undefined, { sliceFn });

    assert.ok(configPath, "the plate must be sliced against a config");
    const ini = readFileSync(configPath!, "utf8");
    assert.ok(
      !/^\s*filament_colour\s*=/m.test(ini),
      `no colour was requested, so no colour may be written. Got:\n${ini}`,
    );
    assert.ok(!/#FFFFFF/i.test(ini), "white must not be invented anywhere in the config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plate WITH a requested colour still carries it into the config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-colour-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const p = jobPart(a, 2);
    p.colourHex = "#008080"; // teal
    const j = job([{ index: 1, parts: [p], status: "planned", colours: ["#008080"] }]);
    j.bed = { x: 220, y: 220, z: 250 };
    let configPath: string | undefined;
    const sliceFn: SliceFn = async (_path, _params, configIni) => {
      configPath = configIni;
      return { gcodePath: "out.gcode" };
    };
    await runJob(j, undefined, { sliceFn });

    const ini = readFileSync(configPath!, "utf8");
    assert.match(ini, /filament_colour = #008080/i, "a colour that WAS asked for must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Read one entry out of a written 3MF project. */
async function entryText(threeMfPath: string, name: string): Promise<string | undefined> {
  const unzipper = await import("unzipper");
  const archive = await unzipper.Open.file(threeMfPath);
  const entry = archive.files.find((f) => f.path === name);
  return entry ? (await entry.buffer()).toString("utf8") : undefined;
}

test("colour bands travel INTO the plate project, not just into the G-code", async () => {
  // Bands were only ever post-processed into the finished G-code as M600s. The
  // project a user opens was written with no colour changes at all, so the
  // plate showed one flat colour and the swaps were invisible and un-editable.
  // A project that carries them shows the bands in Preview and can be adjusted
  // by hand — which is the whole reason to open it.
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-bands-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const j = job([plate(1, [jobPart(a, 1)])]);
    j.bed = { x: 220, y: 220, z: 250 };
    j.colourBands = ["#000000", "#1E6FC8"]; // black bottom half, blue top half
    const sliceFn: SliceFn = async () => ({ gcodePath: join(dir, "out.gcode") });
    writeFileSync(join(dir, "out.gcode"), ";LAYER_CHANGE\n;Z:5\nG1 X1\n");

    const result = await runJob(j, undefined, { sliceFn });
    const project = result.plates[0].projectPath;
    assert.ok(project, "the plate must leave a project behind");

    const xml = await entryText(project!, "Metadata/Slic3r_PE_custom_gcode_per_print_z.xml");
    assert.ok(xml, "the project must carry the colour changes");
    assert.match(xml!, /print_z="5"/, "the swap sits at half the 10mm part's height");
    assert.match(xml!, /color="#1E6FC8"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a banded plate opens showing the colour it STARTS in", async () => {
  // filament_colour is the swatch PrusaSlicer paints the plate with. With bands
  // there is no single part colour to use, so the plate opened in the default
  // colour — the one colour the user definitely did not ask for.
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-bandcolour-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const j = job([plate(1, [jobPart(a, 1)])]);
    j.bed = { x: 220, y: 220, z: 250 };
    j.colourBands = ["#000000", "#1E6FC8"];
    let configPath: string | undefined;
    const sliceFn: SliceFn = async (_p, _params, configIni) => {
      configPath = configIni;
      return { gcodePath: join(dir, "out.gcode") };
    };
    writeFileSync(join(dir, "out.gcode"), ";LAYER_CHANGE\n;Z:5\nG1 X1\n");
    await runJob(j, undefined, { sliceFn });

    const ini = readFileSync(configPath!, "utf8");
    assert.match(ini, /filament_colour = #000000/i, "the first band is the colour the print starts in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bands reach the project on a multi-instance plate too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-bands-mm-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const j = job([plate(1, [jobPart(a, 2)])]);
    j.bed = { x: 220, y: 220, z: 250 };
    j.colourBands = ["#000000", "#1E6FC8"];
    const sliceFn: SliceFn = async () => ({ gcodePath: join(dir, "out.gcode") });
    writeFileSync(join(dir, "out.gcode"), ";LAYER_CHANGE\n;Z:5\nG1 X1\n");

    const result = await runJob(j, undefined, { sliceFn });
    const xml = await entryText(
      result.plates[0].projectPath!,
      "Metadata/Slic3r_PE_custom_gcode_per_print_z.xml",
    );
    assert.ok(xml, "the multi-instance project must carry the colour changes too");
    assert.match(xml!, /color="#1E6FC8"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the heights the swaps actually landed on are recorded on the plate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-runner-bandz-"));
  const a = join(dir, "a.stl");
  writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));

  try {
    const j = job([plate(1, [jobPart(a, 1)])]);
    j.bed = { x: 220, y: 220, z: 250 };
    j.colourBands = ["#000000", "#1E6FC8"];
    const sliceFn: SliceFn = async () => ({ gcodePath: join(dir, "out.gcode") });
    writeFileSync(join(dir, "out.gcode"), ";LAYER_CHANGE\n;Z:5\nG1 X1\n");

    const result = await runJob(j, undefined, { sliceFn });
    assert.deepEqual(result.plates[0].colourChanges, [{ atZ: 5, colourHex: "#1E6FC8" }]);
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

test("a multi-material plate deletes its synthesized config — no slicely-mm-*.ini is left behind", async () => {
  // multimaterial.ts writes the synthesized multi-extruder config to
  // `$TMPDIR/slicely-mm-<n>x-<material>-<ts>.ini` and nothing ever removed it:
  // 228 of them had accumulated on the verification machine, and a production
  // job leaves one per multi-colour plate. The file must exist WHILE the slicer
  // runs (it is passed on the command line) and be gone afterwards.
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  const workdir = mkdtempSync(join(tmpdir(), "slicely-mmrun-"));
  process.env.SLICELY_WORKDIR = workdir;
  resetConfigForTests();

  const before = new Set(mmTempFiles());
  const dir = mkdtempSync(join(tmpdir(), "slicely-mmrun-src-"));
  try {
    const a = join(dir, "a.stl");
    const b = join(dir, "b.stl");
    writeFileSync(a, trianglesToBinaryStl(buildCubeTriangles(10)));
    writeFileSync(b, trianglesToBinaryStl(buildCubeTriangles(10)));

    const parts: JobPart[] = [
      { ...jobPart(a), extruder: 1, colourHex: "#C81E1E" },
      { ...jobPart(b), extruder: 2, colourHex: "#1E6FC8" },
    ];
    const j = job([plate(1, parts)]);
    j.bed = { x: 250, y: 210, z: 210 };

    const configsSeen: string[] = [];
    const sliceFn: SliceFn = async (input, _params, configIni) => {
      assert.ok(configIni, "a multi-material plate must be sliced against a config");
      assert.ok(existsSync(configIni!), "the config must still exist while the slicer runs");
      configsSeen.push(configIni!);
      return { gcodePath: `${input}.gcode`, filamentUsedG: 5, estimatedPrintTime: "10m" };
    };

    const result = await runJob(j, () => undefined, { sliceFn });
    assert.equal(result.plates[0].status, "ready");
    assert.equal(configsSeen.length, 1);
    assert.match(configsSeen[0], /slicely-mm-2x-PLA-\d+\.ini$/, "the temp config is the one under test");
    assert.ok(!existsSync(configsSeen[0]), "the synthesized config must be deleted after the run");

    const leaked = mmTempFiles().filter((f) => !before.has(f));
    assert.deepEqual(leaked, [], `the run left temp configs behind: ${leaked.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
  }
});

/** Every `slicely-mm-*.ini` currently sitting in the system temp directory. */
function mmTempFiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => /^slicely-mm-.*\.ini$/.test(name));
}
