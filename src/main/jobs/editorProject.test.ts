// The project handed to PrusaSlicer when the user says "open it".
//
// PrusaSlicer ships single_instance = 1, so with the app already open a second
// launch hands over the file paths and DROPS the rest of the command line. Every
// setting the user asked for has to be inside the file or it does not arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEditorProject } from "./editorProject";
import { buildCubeTriangles } from "./testFixtures";

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
