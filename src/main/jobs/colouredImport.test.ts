// Turning the colours a downloaded 3MF already carries into parts Slicely can
// print. Reading them (threemfColour.ts) is only half the job: the planner
// reasons about PARTS with colours, so a multi-colour download has to become
// several coloured parts to flow through orientation, packing and plating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandColouredThreeMf, summariseModelColours } from "./colouredImport";
import { parseMesh } from "./mesh";
import { writeThreeMfFixture, buildCubeTriangles, trianglesToBinaryStl } from "./testFixtures";

const TETRA =
  `<mesh><vertices>` +
  `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>` +
  `<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>` +
  `</vertices><triangles>` +
  `<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>` +
  `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
  `</triangles></mesh>`;

function twoColourModel(): ReturnType<typeof writeThreeMfFixture> {
  return writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources>` +
      `<object id="1" type="model">${TETRA}</object>` +
      `<object id="2" type="model">${TETRA}</object>` +
      `</resources><build>` +
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>` +
      `<item objectid="2" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>` +
      `</build></model>`,
    "Metadata/Slic3r_PE_model.config":
      `<config>` +
      `<object id="1"><metadata type="object" key="name" value="board"/>` +
      `<metadata type="object" key="extruder" value="1"/></object>` +
      `<object id="2"><metadata type="object" key="name" value="headers"/>` +
      `<metadata type="object" key="extruder" value="2"/></object>` +
      `</config>`,
    "Metadata/Slic3r_PE.config": `; generated\n; filament_colour = #008080;#000000\n`,
  });
}

test("a two-colour 3MF becomes two coloured parts, each still its own geometry", async () => {
  const fixture = twoColourModel();
  const out = mkdtempSync(join(tmpdir(), "slicely-expand-"));
  try {
    const parts = await expandColouredThreeMf(fixture.path, out);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].colourHex, "#008080");
    assert.equal(parts[1].colourHex, "#000000");
    assert.equal(parts[0].name, "board");

    for (const part of parts) {
      assert.ok(existsSync(part.path), `${part.path} must be written`);
      const mesh = await parseMesh(part.path);
      assert.equal(mesh.triangles.length, 4, "the object's own geometry, intact");
    }
  } finally {
    fixture.cleanup();
    rmSync(out, { recursive: true, force: true });
  }
});

test("the second object keeps the position its build item gave it", async () => {
  // Splitting a model and dropping every part on the origin makes an assembly
  // into a collision. The pieces are only meaningful relative to each other.
  const fixture = twoColourModel();
  const out = mkdtempSync(join(tmpdir(), "slicely-expand-pos-"));
  try {
    const parts = await expandColouredThreeMf(fixture.path, out);
    const mesh = await parseMesh(parts[1].path);
    assert.ok(
      mesh.triangles.every((t) => [t.a, t.b, t.c].every((v) => v.x >= 30)),
      "the second object was placed 30mm along X and must stay there",
    );
  } finally {
    fixture.cleanup();
    rmSync(out, { recursive: true, force: true });
  }
});

test("a single-colour 3MF is left alone — splitting it would gain nothing", async () => {
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model">${TETRA}</object></resources>` +
      `<build><item objectid="1"/></build></model>`,
  });
  const out = mkdtempSync(join(tmpdir(), "slicely-expand-one-"));
  try {
    assert.deepEqual(await expandColouredThreeMf(fixture.path, out), []);
  } finally {
    fixture.cleanup();
    rmSync(out, { recursive: true, force: true });
  }
});

test("summariseModelColours reports what a download already knows about itself", async () => {
  const fixture = twoColourModel();
  try {
    const summary = await summariseModelColours(fixture.path);
    assert.ok(summary, "a two-colour model has something to say");
    assert.deepEqual(summary!.palette, ["#008080", "#000000"]);
    assert.equal(summary!.colouredObjects, 2);
    assert.equal(summary!.paintedObjects, 0);
    assert.match(summary!.note, /2 colours/i);
    assert.match(summary!.note, /#008080/);
  } finally {
    fixture.cleanup();
  }
});

test("a painted model is reported as painted, and is NOT split apart", async () => {
  // Painting is regions within one mesh. There is nothing to separate: the
  // colours survive by carrying the paint codes, not by cutting the model up.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ` +
      `xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">` +
      `<resources><object id="1" type="model"><mesh><vertices>` +
      `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>` +
      `<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>` +
      `</vertices><triangles>` +
      `<triangle v1="0" v2="2" v3="1" slic3rpe:mmu_segmentation="4"/>` +
      `<triangle v1="0" v2="1" v3="3"/>` +
      `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
      `</triangles></mesh></object></resources>` +
      `<build><item objectid="1"/></build></model>`,
  });
  const out = mkdtempSync(join(tmpdir(), "slicely-expand-paint-"));
  try {
    const summary = await summariseModelColours(fixture.path);
    assert.equal(summary?.paintedObjects, 1);
    assert.match(summary!.note, /painted/i);
    assert.deepEqual(await expandColouredThreeMf(fixture.path, out), []);
  } finally {
    fixture.cleanup();
    rmSync(out, { recursive: true, force: true });
  }
});

test("an STL says nothing about colour, and is not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-expand-stl-"));
  const stl = join(dir, "a.stl");
  writeFileSync(stl, trianglesToBinaryStl(buildCubeTriangles(10)));
  try {
    assert.equal(await summariseModelColours(stl), undefined);
    assert.deepEqual(await expandColouredThreeMf(stl, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
