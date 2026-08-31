// The project handed to PrusaSlicer when the user says "open it".
//
// PrusaSlicer ships single_instance = 1, so with the app already open a second
// launch hands over the file paths and DROPS the rest of the command line. Every
// setting the user asked for has to be inside the file or it does not arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEditorProject } from "./editorProject";
import { buildCubeTriangles, writeThreeMfFixture } from "./testFixtures";

const TETRA =
  `<mesh><vertices>` +
  `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>` +
  `<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>` +
  `</vertices><triangles>` +
  `<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>` +
  `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
  `</triangles></mesh>`;

/** An ASCII STL of a cube, so the helper can be driven through real file I/O. */
function writeCubeStl(path: string, size: number): void {
  const tris = buildCubeTriangles(size);
  const body = tris
    .map(
      (t) =>
        `facet normal 0 0 1\n outer loop\n` +
        [t.a, t.b, t.c].map((v) => `  vertex ${v.x} ${v.y} ${v.z}`).join("\n") +
        `\n endloop\nendfacet`,
    )
    .join("\n");
  writeFileSync(path, `solid cube\n${body}\nendsolid cube\n`);
}

test("the project carries the settings, and parts do not land on top of each other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-"));
  try {
    const a = join(dir, "a.stl");
    const b = join(dir, "b.stl");
    writeCubeStl(a, 20);
    writeCubeStl(b, 20);
    const ini = join(dir, "cfg.ini");
    writeFileSync(ini, "bed_shape = 0x0,220x0,220x220,0x220\nfilament_colour = #000000\n");

    const out = join(dir, "open.3mf");
    const project = await writeEditorProject({
      paths: [a, b],
      bed: { x: 220, y: 220, z: 250 },
      configIni: ini,
      destPath: out,
    });
    assert.equal(project, out);

    const config = execFileSync("unzip", ["-p", out, "Metadata/Slic3r_PE.config"], {
      encoding: "utf8",
    });
    assert.ok(config.includes("; filament_colour = #000000"), "the colour must travel");
    assert.ok(config.includes("; bed_shape = 0x0,220x0,220x220,0x220"), "so must the printer");

    // Two loose STLs both land on the origin, which is what produced
    // PrusaSlicer's "Conflicts in G-code paths" error.
    const model = execFileSync("unzip", ["-p", out, "3D/3dmodel.model"], { encoding: "utf8" });
    const offsets = [...model.matchAll(/transform="[^"]*?([-\d.]+) ([-\d.]+) [-\d.]+"/g)].map(
      (m) => `${m[1]},${m[2]}`,
    );
    assert.equal(offsets.length, 2, "both parts must be placed");
    assert.notEqual(offsets[0], offsets[1], "parts must not be stacked at one spot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a requested scale is baked into the geometry, not left on a dropped flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-"));
  try {
    const a = join(dir, "a.stl");
    writeCubeStl(a, 20);

    const plain = join(dir, "plain.3mf");
    const scaled = join(dir, "scaled.3mf");
    await writeEditorProject({ paths: [a], bed: { x: 220, y: 220, z: 250 }, destPath: plain });
    await writeEditorProject({
      paths: [a],
      bed: { x: 220, y: 220, z: 250 },
      destPath: scaled,
      scale: 2,
    });

    const coords = (f: string): number[] =>
      [...execFileSync("unzip", ["-p", f, "3D/3dmodel.model"], { encoding: "utf8" }).matchAll(
        /<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g,
      )].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);

    const spanOf = (f: string): number => {
      const c = coords(f);
      return Math.max(...c) - Math.min(...c);
    };

    const before = spanOf(plain);
    const after = spanOf(scaled);
    assert.ok(before > 0, "the plain project must have geometry");
    assert.ok(
      Math.abs(after / before - 2) < 0.01,
      `scale must reach the file: ${before} -> ${after}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a downloaded model's own colours open as its own colours", async () => {
  // "Open it" on a multi-colour download rebuilt every object as extruder 1,
  // so the plate opened one flat colour and the file's colours were gone. They
  // were in the file the whole time.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources>` +
      `<object id="1" type="model">${TETRA}</object>` +
      `<object id="2" type="model">${TETRA}</object>` +
      `</resources><build>` +
      `<item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>` +
      `</build></model>`,
    "Metadata/Slic3r_PE_model.config":
      `<config>` +
      `<object id="1"><metadata type="object" key="extruder" value="1"/></object>` +
      `<object id="2"><metadata type="object" key="extruder" value="2"/></object>` +
      `</config>`,
    "Metadata/Slic3r_PE.config": `; generated\n; filament_colour = #008080;#000000\n`,
  });
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-colour-"));
  try {
    const out = join(dir, "open.3mf");
    const project = await writeEditorProject({
      paths: [fixture.path],
      bed: { x: 220, y: 220, z: 250 },
      destPath: out,
    });
    assert.ok(project, "a coloured 3MF must still produce a project");

    const config = execFileSync("unzip", ["-p", out, "Metadata/Slic3r_PE_model.config"], {
      encoding: "utf8",
    });
    const extruders = [...config.matchAll(/key="extruder" value="(\d+)"/g)].map((m) => m[1]);
    assert.ok(extruders.includes("1") && extruders.includes("2"), `got ${extruders.join(",")}`);

    const print = execFileSync("unzip", ["-p", out, "Metadata/Slic3r_PE.config"], {
      encoding: "utf8",
    });
    assert.match(print, /filament_colour = #008080;#000000/i, "both colours must be loaded");
  } finally {
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("painting on an imported model survives being opened", async () => {
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
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-paint-"));
  try {
    const out = join(dir, "open.3mf");
    await writeEditorProject({
      paths: [fixture.path],
      bed: { x: 220, y: 220, z: 250 },
      destPath: out,
    });
    const model = execFileSync("unzip", ["-p", out, "3D/3dmodel.model"], { encoding: "utf8" });
    assert.match(model, /slic3rpe:mmu_segmentation="4"/, "the author's painting must survive");
  } finally {
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("colour changes asked for at open time are in the project, ready to see", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-bands-"));
  try {
    const a = join(dir, "a.stl");
    writeCubeStl(a, 20);
    const out = join(dir, "open.3mf");
    await writeEditorProject({
      paths: [a],
      bed: { x: 220, y: 220, z: 250 },
      destPath: out,
      colourChanges: [{ atZ: 10, colourHex: "#1E6FC8" }],
    });
    const xml = execFileSync(
      "unzip",
      ["-p", out, "Metadata/Slic3r_PE_custom_gcode_per_print_z.xml"],
      { encoding: "utf8" },
    );
    assert.match(xml, /print_z="10"/);
    assert.match(xml, /color="#1E6FC8"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("a PAINTED model opens with enough extruders for its painting to mean anything", async () => {
  // Carrying the paint codes is only half of it. A model painted in two
  // filaments is ONE object assigned to extruder 1 — the second colour lives
  // entirely in the painting — so counting extruders from the object
  // assignments alone gives 1, the project opens as a single-extruder printer,
  // and PrusaSlicer has no second filament to paint with. Verified against
  // PrusaSlicer 2.9.5: the same painted model produces 22 tool changes with a
  // two-extruder config and 0 with a one-extruder config.
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model"><mesh><vertices>` +
      `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>` +
      `<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>` +
      `</vertices><triangles>` +
      `<triangle v1="0" v2="2" v3="1" paint_color="4"/>` +
      `<triangle v1="0" v2="1" v3="3"/>` +
      `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
      `</triangles></mesh></object></resources>` +
      `<build><item objectid="1"/></build></model>`,
    "Metadata/model_settings.config":
      `<config><object id="1"><metadata key="extruder" value="1"/></object></config>`,
    "Metadata/project_settings.config": JSON.stringify({
      filament_colour: ["#000000", "#0086D6"],
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-painted-"));
  try {
    const out = join(dir, "open.3mf");
    await writeEditorProject({
      paths: [fixture.path],
      bed: { x: 220, y: 220, z: 250 },
      destPath: out,
    });
    const cfg = execFileSync("unzip", ["-p", out, "Metadata/Slic3r_PE.config"], {
      encoding: "utf8",
    });
    assert.match(
      cfg,
      /nozzle_diameter = 0\.4,0\.4/,
      "the printer must have a second extruder for the painting to use",
    );
    assert.match(cfg, /filament_colour = #000000;#0086D6/i, "in the model's own colours");
  } finally {
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the merged config can be written out, so a slice can be told to USE it", async () => {
  // PrusaSlicer's priority is overrides > --load > the project's own settings,
  // so slicing a painted project while passing a single-extruder --load
  // silently overrides the two extruders the painting needs and produces a
  // one-colour print. The slice has to be handed the SAME merged config the
  // project carries. (Verified against 2.9.5: the real MakerWorld keycard
  // slices to 32 tool changes on its own config and 0 under a --load of a
  // single-extruder one.)
  const fixture = writeThreeMfFixture({
    "3D/3dmodel.model":
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model"><mesh><vertices>` +
      `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>` +
      `<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>` +
      `</vertices><triangles>` +
      `<triangle v1="0" v2="2" v3="1" paint_color="4"/>` +
      `<triangle v1="0" v2="1" v3="3"/>` +
      `<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>` +
      `</triangles></mesh></object></resources>` +
      `<build><item objectid="1"/></build></model>`,
    "Metadata/project_settings.config": JSON.stringify({
      filament_colour: ["#000000", "#0086D6"],
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "slicely-editor-emit-"));
  try {
    const emitted = join(dir, "effective.ini");
    await writeEditorProject({
      paths: [fixture.path],
      bed: { x: 220, y: 220, z: 250 },
      destPath: join(dir, "open.3mf"),
      emitConfigTo: emitted,
    });
    const ini = readFileSync(emitted, "utf8");
    assert.match(ini, /nozzle_diameter = 0\.4,0\.4/, "the slice must see both extruders");
    assert.match(ini, /filament_colour = #000000;#0086D6/i);
  } finally {
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
