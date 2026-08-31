// ─────────────────────────────────────────────────────────────────────────────
// Writes a 3MF project that assigns each part to a specific extruder.
//
// This is what makes multi-colour real rather than cosmetic. PrusaSlicer's CLI
// takes a list of STLs and slices them all with extruder 1 — there is no flag
// to say "this file prints in blue". Per-object extruder assignment lives in a
// 3MF project's Slic3r_PE_model.config, so producing multi-material G-code
// means writing that file ourselves. (`--export-3mf` cannot stand in: given
// several inputs it exports each one separately, overwriting the output, so it
// yields a single-object 3MF.)
//
// Scope is deliberately narrow: one object per part, one instance each, an
// identity transform plus a translation from the packer. No modifiers, no
// per-face painting — painting a single mesh is a different problem that
// genuinely requires the GUI.
//
// Format references: 3MF Core Specification 1.x, and PrusaSlicer's own
// Slic3r_PE_model.config as emitted by --export-3mf (inspected directly).
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";
import { basename } from "node:path";
import type { Triangle } from "./mesh";

/**
 * A filament change partway up the print.
 *
 * This is how a SINGLE part gets more than one colour without per-triangle
 * painting: the printer pauses at a height, you swap the spool (or an
 * MMU/AMS swaps it), and everything above prints in the new colour. It works
 * on any printer, including single-extruder machines with no AMS at all.
 */
export interface ColourChange {
  /** Height in mm at which the new colour starts. */
  atZ: number;
  /** Colour that begins at this height, "#RRGGBB". */
  colourHex: string;
}

/** One part to place in the project. */
export interface ThreeMfPart {
  /** Source file, used only for the human-readable name metadata. */
  path: string;
  triangles: Triangle[];
  /** 1-based extruder. PrusaSlicer numbers extruders from 1. */
  extruder: number;
  /** Translation applied to the object, in mm. */
  offset?: { x: number; y: number; z: number };
}

/** XML-escape a value destined for an attribute. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trim a float for XML without losing print-relevant precision (µm). */
function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Build the 3MF mesh document.
 *
 * Vertices are de-duplicated per object: STL repeats every vertex per triangle,
 * and a 3MF triangle indexes shared vertices, so writing them raw would triple
 * the file and make PrusaSlicer's mesh repair work harder than it needs to.
 */
function modelXml(parts: ThreeMfPart[]): string {
  const objects: string[] = [];
  const items: string[] = [];

  parts.forEach((part, i) => {
    const id = i + 1;
    const index = new Map<string, number>();
    const vertices: string[] = [];
    const triangles: string[] = [];

    const vertexId = (x: number, y: number, z: number): number => {
      // Quantise to 1 nm before keying so float noise doesn't defeat sharing.
      const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
      const hit = index.get(key);
      if (hit !== undefined) return hit;
      const next = vertices.length;
      index.set(key, next);
      vertices.push(`    <vertex x="${n(x)}" y="${n(y)}" z="${n(z)}"/>`);
      return next;
    };

    for (const t of part.triangles) {
      const a = vertexId(t.a.x, t.a.y, t.a.z);
      const b = vertexId(t.b.x, t.b.y, t.b.z);
      const c = vertexId(t.c.x, t.c.y, t.c.z);
      // A degenerate triangle (two shared vertices) is not printable geometry
      // and makes PrusaSlicer complain; drop it rather than pass it on.
      if (a === b || b === c || a === c) continue;
      triangles.push(`    <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }

    objects.push(
      `  <object id="${id}" type="model">\n` +
        `   <mesh>\n` +
        `    <vertices>\n${vertices.join("\n")}\n    </vertices>\n` +
        `    <triangles>\n${triangles.join("\n")}\n    </triangles>\n` +
        `   </mesh>\n` +
        `  </object>`,
    );

    const o = part.offset ?? { x: 0, y: 0, z: 0 };
    // 3MF transforms are row-major 4x3: the 3x3 basis then the translation.
    items.push(
      `  <item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${n(o.x)} ${n(o.y)} ${n(o.z)}"/>`,
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    ` <resources>\n${objects.join("\n")}\n </resources>\n` +
    ` <build>\n${items.join("\n")}\n </build>\n` +
    `</model>\n`
  );
}

/**
 * Build PrusaSlicer's per-object config.
 *
 * The `extruder` metadata is the entire point of this module. It is written at
 * BOTH object and volume level: PrusaSlicer reads the volume's value when one
 * is present, and the object's otherwise, and emitting both makes the intent
 * survive either path.
 */
function configXml(parts: ThreeMfPart[]): string {
  const blocks = parts.map((part, i) => {
    const id = i + 1;
    const name = esc(basename(part.path));
    const last = Math.max(0, part.triangles.length - 1);
    return (
      ` <object id="${id}" instances_count="1">\n` +
      `  <metadata type="object" key="name" value="${name}"/>\n` +
      `  <metadata type="object" key="extruder" value="${part.extruder}"/>\n` +
      `  <volume firstid="0" lastid="${last}">\n` +
      `   <metadata type="volume" key="name" value="${name}"/>\n` +
      `   <metadata type="volume" key="volume_type" value="ModelPart"/>\n` +
      `   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
      `   <metadata type="volume" key="extruder" value="${part.extruder}"/>\n` +
      `   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" ` +
      `facets_reversed="0" backwards_edges="0"/>\n` +
      `  </volume>\n` +
      ` </object>`
    );
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${blocks.join("\n")}\n</config>\n`;
}

/**
 * Which kind of printer these codes were written for.
 *
 * PrusaSlicer's own enum (libslic3r CustomGCode::Mode). "SingleExtruder" is one
 * hot end, one spool. "MultiAsSingle" is one hot end fed by several spools —
 * an AMS/MMU, which is what `single_extruder_multi_material = 1` describes and
 * what every consumer multi-colour printer is. Writing SingleExtruder into a
 * project whose config has several extruders describes a printer that isn't
 * there.
 */
export type CustomGcodeMode = "SingleExtruder" | "MultiAsSingle" | "MultiExtruder";

/**
 * PrusaSlicer's per-height custom G-code document.
 *
 * type="0" is ColorChange, which is valid in every mode — it is the "stop here
 * and put a different colour in" instruction, as opposed to a tool change,
 * which names a specific extruder to switch to. M600 is the command that
 * carries it out.
 */
function customGcodeXml(changes: ColourChange[], mode: CustomGcodeMode): string {
  const codes = changes
    .slice()
    .sort((a, b) => a.atZ - b.atZ)
    .map(
      (c) =>
        ` <code print_z="${n(c.atZ)}" type="0" extruder="1" ` +
        `color="${esc(c.colourHex.toUpperCase())}" extra="" gcode="M600"/>`,
    );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<custom_gcodes_per_print_z>\n${codes.join("\n")}\n` +
    ` <mode value="${mode}"/>\n` +
    `</custom_gcodes_per_print_z>\n`
  );
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  ` <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  ` <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
  `</Types>\n`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  ` <Relationship Target="/3D/3dmodel.model" Id="rel-1" ` +
  `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>\n`;

// ── Minimal ZIP writer ───────────────────────────────────────────────────────
// A 3MF is an OPC package, i.e. a ZIP. Nothing in this project's dependencies
// writes ZIPs (unzipper only reads), so this emits the small subset the format
// needs: deflated entries, local headers, a central directory, and an EOCD.

interface ZipEntry {
  name: string;
  data: Buffer;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 6 });
    // Only take the compressed form when it actually helps.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Build the 3MF package in memory. Exported for testing without disk I/O. */
export function buildThreeMf(
  parts: ThreeMfPart[],
  colourChanges: ColourChange[] = [],
  printConfigIni?: string,
  mode: CustomGcodeMode = "SingleExtruder",
): Buffer {
  if (parts.length === 0) throw new Error("A 3MF needs at least one part.");
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
    { name: "3D/3dmodel.model", data: Buffer.from(modelXml(parts), "utf8") },
    { name: "Metadata/Slic3r_PE_model.config", data: Buffer.from(configXml(parts), "utf8") },
  ];
  if (colourChanges.length > 0) {
    entries.push({
      name: "Metadata/Slic3r_PE_custom_gcode_per_print_z.xml",
      data: Buffer.from(customGcodeXml(colourChanges, mode), "utf8"),
    });
  }
  // Without this part, opening the project shows the geometry against whatever
  // profile the user happens to have loaded: their bed, their filament, their
  // colours. The settings Slicely sliced against — including filament_colour,
  // which is what makes the plate LOOK like what was asked for — live here.
  if (printConfigIni && printConfigIni.trim()) {
    entries.push({
      name: "Metadata/Slic3r_PE.config",
      data: Buffer.from(iniToProjectConfig(printConfigIni), "utf8"),
    });
  }
  return zip(entries);
}

/** Write a 3MF project to `destPath`, optionally with colour changes by height. */
export function writeThreeMf(
  destPath: string,
  parts: ThreeMfPart[],
  colourChanges: ColourChange[] = [],
  printConfigIni?: string,
  mode: CustomGcodeMode = "SingleExtruder",
): string {
  writeFileSync(destPath, buildThreeMf(parts, colourChanges, printConfigIni, mode));
  return destPath;
}

/**
 * Convert a PrusaSlicer `.ini` into the project's config part.
 *
 * The two formats hold the same key/value pairs; the project part comments each
 * line out, exactly as the config block PrusaSlicer appends to finished G-code.
 * Section headers and existing comments are dropped — a project config is flat.
 *
 * The leading header line is REQUIRED, not decoration: PrusaSlicer discards the
 * first line of this part as a generator stamp. Without it the first real
 * setting is eaten, and since bed_shape sorts first that meant a plate arranged
 * for a 325x320 bed opened against the built-in 200x200 one with every part
 * reported "outside the print volume".
 */
function iniToProjectConfig(ini: string): string {
  const out: string[] = ["; generated by Slicely"];
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.push(`; ${line.slice(0, eq).trim()} = ${line.slice(eq + 1).trim()}`);
  }
  return out.join("\n") + "\n";
}
