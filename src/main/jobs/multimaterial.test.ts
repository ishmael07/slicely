// Tests for the multi-material path: the 3MF project that carries per-object
// extruder assignments, and the config that gives PrusaSlicer more than one
// extruder to assign to.
//
// Before this path existed, colours were resolved against the printer's spools
// and then discarded at slice time, so every plate printed in one colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildThreeMf, writeThreeMf } from "./threemf";
import { synthesizeMultiMaterialConfig, distinctExtruders } from "./multimaterial";
import { buildCubeTriangles } from "./testFixtures";

test("distinctExtruders reports each extruder once, in order", () => {
  assert.deepEqual(
    distinctExtruders([{ extruder: 2 }, { extruder: 1 }, { extruder: 2 }, {}]),
    [1, 2],
    "an unset extruder counts as 1",
  );
  assert.deepEqual(distinctExtruders([{ extruder: 1 }, {}]), [1]);
});

test("the 3MF is a readable archive with the four parts a 3MF needs", () => {
  const buf = buildThreeMf([
    { path: "a.stl", triangles: buildCubeTriangles(10), extruder: 1 },
  ]);
  // Local file header magic — proves we emitted a real ZIP, not bytes.
  assert.equal(buf.readUInt32LE(0), 0x04034b50);

  const dir = mkdtempSync(join(tmpdir(), "slicely-3mf-"));
  const f = join(dir, "t.3mf");
  writeFileSync(f, buf);
  try {
    const listing = execFileSync("unzip", ["-l", f], { encoding: "utf8" });
    for (const entry of [
      "[Content_Types].xml",
      "_rels/.rels",
      "3D/3dmodel.model",
      "Metadata/Slic3r_PE_model.config",
    ]) {
      assert.ok(listing.includes(entry), `missing ${entry}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each part's extruder is recorded in the project config", () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-3mf-"));
  const f = join(dir, "t.3mf");
  try {
    writeThreeMf(f, [
      { path: "red.stl", triangles: buildCubeTriangles(10), extruder: 1 },
      { path: "blue.stl", triangles: buildCubeTriangles(10), extruder: 2 },
      { path: "green.stl", triangles: buildCubeTriangles(10), extruder: 3 },
    ]);
    const cfg = execFileSync("unzip", ["-p", f, "Metadata/Slic3r_PE_model.config"], {
      encoding: "utf8",
    });
    // This assignment IS the feature: without it every object prints on
    // extruder 1 and the colour plan is decoration.
    for (const n of [1, 2, 3]) {
      assert.ok(
        cfg.includes(`key="extruder" value="${n}"`),
        `extruder ${n} not assigned in the project config`,
      );
    }
    assert.ok(cfg.includes('value="red.stl"'), "part names should survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mesh document shares vertices instead of repeating them per triangle", () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-3mf-"));
  const f = join(dir, "t.3mf");
  try {
    // A cube is 12 triangles over 8 corners. STL stores 36 vertices; a 3MF
    // should index the 8.
    writeThreeMf(f, [{ path: "c.stl", triangles: buildCubeTriangles(10), extruder: 1 }]);
    const model = execFileSync("unzip", ["-p", f, "3D/3dmodel.model"], { encoding: "utf8" });
    const vertices = (model.match(/<vertex /g) ?? []).length;
    const triangles = (model.match(/<triangle /g) ?? []).length;
    assert.equal(vertices, 8, `expected 8 shared vertices, got ${vertices}`);
    assert.equal(triangles, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the config declares one extruder per colour, as vectors", () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-mm-"));
  const p = join(dir, "mm.ini");
  try {
    synthesizeMultiMaterialConfig({
      bed: { x: 250, y: 210, z: 210 },
      nozzleMm: 0.4,
      material: "PLA",
      colours: ["#C81E1E", "#1E6FC8", "#18A558"],
      destPath: p,
    });
    const ini = readFileSync(p, "utf8");
    assert.match(ini, /nozzle_diameter = 0\.4,0\.4,0\.4/, "per-extruder values must be vectors");
    assert.match(ini, /filament_colour = #C81E1E;#1E6FC8;#18A558/);
    assert.match(ini, /single_extruder_multi_material = 1/);
    // PrusaSlicer hard-fails the slice without these two when a wipe tower is
    // on, so they are correctness, not tuning.
    assert.match(ini, /use_relative_e_distances = 1/);
    assert.match(ini, /support_material_extruder = 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single colour still yields a valid two-extruder config floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-mm-"));
  const p = join(dir, "mm.ini");
  try {
    synthesizeMultiMaterialConfig({
      bed: { x: 200, y: 200, z: 200 },
      nozzleMm: 0.6,
      material: "PETG",
      colours: ["#FF0000"],
      destPath: p,
    });
    const ini = readFileSync(p, "utf8");
    // Multi-material means at least two extruders even if only one colour was
    // named; the second is padded rather than left undefined.
    assert.match(ini, /nozzle_diameter = 0\.6,0\.6/);
    assert.match(ini, /filament_colour = #FF0000;#FFFFFF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
