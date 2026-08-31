// ─────────────────────────────────────────────────────────────────────────────
// Reading the colours a 3MF ALREADY has.
//
// A multi-colour model from Printables or MakerWorld ships its colours inside
// the file — the extruder each part is assigned to, the palette those indices
// point at, and, for a model the author painted rather than split up, a code on
// every triangle. That is what makes it a multi-colour model rather than a
// shape. Slicely used to discard all of it in parse3mf (which merges every
// object into one triangle soup) and then ask the user what colours they
// wanted, which is an odd question about a model whose author already answered
// it.
//
// Three dialects appear in real downloads and all three are read here:
//
//   • PrusaSlicer — Metadata/Slic3r_PE_model.config for per-object extruders,
//     Metadata/Slic3r_PE.config for the filament_colour palette they index.
//   • Bambu Studio / MakerWorld — Metadata/model_settings.config and
//     Metadata/project_settings.config (JSON).
//   • The 3MF core spec itself — <basematerials>/<colorgroup> resolved through
//     an object's pid/pindex, which is all a non-slicer exporter writes.
//
// Per-triangle PAINTING is deliberately not read here: those codes index a
// triangle list, so mesh.ts reads them while it is building that list. Two
// independent walks over a mesh would have to agree about ordering, component
// flattening and dropped faces, and the first time they did not, the wrong
// face would be painted with nothing to show for it.
// ─────────────────────────────────────────────────────────────────────────────
import unzipper from "unzipper";
import * as cheerio from "cheerio";

/**
 * Per-triangle painting, exactly as the file expressed it.
 *
 * Declared here with the rest of the colour vocabulary, but READ by
 * mesh.ts — the codes index a triangle list, so only whatever builds that list
 * can produce indices that mean anything.
 *
 * The codes are opaque on purpose: they are a slicer's private encoding of
 * "which filament, and how the triangle is subdivided", and re-emitting them
 * verbatim is what lets a painted model survive a round trip through Slicely.
 * Interpreting them would mean reimplementing a slicer's segmentation format
 * in order to write back something it already understands.
 */
export interface ImportedPaint {
  /** Triangle index WITHIN THE OBJECT, in document order, to its code. Only
   *  painted triangles appear; an absent index is unpainted. */
  codes: Map<number, string>;
  /** The attribute the codes came from, and the one they must go back into.
   *  Writing a Bambu code into PrusaSlicer's attribute would be silently
   *  wrong — same idea, different encoding. */
  attribute: string;
}

/** One object in the file, and what the file says about its colour. */
export interface ImportedObject {
  /** The object's id in 3D/3dmodel.model. */
  objectId: string;
  name?: string;
  /** 1-based extruder the file assigns this object to. */
  extruder?: number;
  /** The colour that extruder holds, "#rrggbb", when the palette says. */
  colourHex?: string;
}

export interface ImportedColours {
  /** Objects in document order — the same order mesh.ts parses them in. */
  objects: ImportedObject[];
  /** Distinct filament colours the file uses, in extruder order. */
  palette: string[];
  /** Which dialect the colour information came from, for reporting. */
  source?: "prusaslicer" | "bambu" | "3mf-materials";
}

const EMPTY: ImportedColours = { objects: [], palette: [] };

/**
 * Read every colour fact a 3MF states about itself.
 *
 * Never throws. Colour is an enhancement to an import: a malformed archive
 * should cost the user their colours, never their model, and the caller
 * treats an empty result as "this file says nothing about colour".
 */
export async function readThreeMfColours(filePath: string): Promise<ImportedColours> {
  let entries: Map<string, string>;
  try {
    entries = await readEntries(filePath);
  } catch {
    return EMPTY;
  }

  const model = entries.get("3d/3dmodel.model");
  if (!model) return EMPTY;

  const objects = readObjects(model);
  if (objects.length === 0) return EMPTY;

  // Slicer metadata wins over core-spec materials: a file carrying both was
  // written BY a slicer, and its own assignments are the ones its author saw.
  const prusa = readPrusaSlicer(entries, objects);
  if (prusa) return prusa;
  const bambu = readBambu(entries, objects);
  if (bambu) return bambu;

  // No slicer metadata. The core spec's own materials are all that is left,
  // and they are what a plain CAD export writes.
  const materials = readBaseMaterials(model);
  if (materials.length > 0) {
    for (const obj of objects) {
      if (obj.materialIndex !== undefined) {
        obj.colourHex = materials[obj.materialIndex];
      }
    }
    return { objects: strip(objects), palette: materials, source: "3mf-materials" };
  }

  // No palette and no assignments. Painting may still be present — that is
  // read by parse3mfObjects, which owns the triangles the codes index into.
  return { objects: strip(objects), palette: [] };
}

// ── Archive ──────────────────────────────────────────────────────────────────

/** Every entry we might need, keyed by lowercased path. A 3MF is small enough
 *  that reading the handful of metadata parts up front beats reopening it. */
async function readEntries(filePath: string): Promise<Map<string, string>> {
  const wanted = new Set([
    "3d/3dmodel.model",
    "metadata/slic3r_pe_model.config",
    "metadata/slic3r_pe.config",
    "metadata/model_settings.config",
    "metadata/project_settings.config",
  ]);
  const directory = await unzipper.Open.file(filePath);
  const out = new Map<string, string>();
  for (const file of directory.files) {
    const key = file.path.toLowerCase();
    if (!wanted.has(key)) continue;
    out.set(key, (await file.buffer()).toString("utf8"));
  }
  return out;
}

// ── The model document ───────────────────────────────────────────────────────

interface WorkingObject extends ImportedObject {
  /** Resolved from pid/pindex against the file's base materials. */
  materialIndex?: number;
}

/** Objects in document order, with their painting and any core-spec material
 *  reference. Order matters: it is how a caller lines these up with the
 *  triangles mesh.ts parsed out of the same document. */
function readObjects(modelXml: string): WorkingObject[] {
  const $ = cheerio.load(modelXml, { xmlMode: true });
  const objects: WorkingObject[] = [];

  $("object").each((_i, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const objectId = attribs.id;
    if (!objectId) return;

    const obj: WorkingObject = { objectId };
    if (attribs.name) obj.name = attribs.name;

    // pid names a resource group, pindex the entry within it. An object with
    // pid but no pindex uses the first entry.
    if (attribs.pid !== undefined) {
      const index = Number(attribs.pindex ?? 0);
      if (Number.isFinite(index)) obj.materialIndex = index;
    }

    objects.push(obj);
  });

  return objects;
}

/** Core-spec colours: <basematerials><base displaycolor>, and the materials
 *  extension's <colorgroup><color>. Both index by position. */
function readBaseMaterials(modelXml: string): string[] {
  const $ = cheerio.load(modelXml, { xmlMode: true });
  const out: string[] = [];
  $("basematerials base, colorgroup color").each((_i, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const hex = hex6(attribs.displaycolor ?? attribs.color);
    if (hex) out.push(hex);
  });
  return out;
}

// ── PrusaSlicer ──────────────────────────────────────────────────────────────

function readPrusaSlicer(
  entries: Map<string, string>,
  objects: WorkingObject[],
): ImportedColours | undefined {
  // Neither part is required. A file can name its palette without assigning
  // any object to it — that palette is still the model's own colours, and
  // gating on the assignments threw it away.
  const config = entries.get("metadata/slic3r_pe_model.config");

  // PrusaSlicer tags its metadata with type="object"/"volume". A volume's
  // value overrides the object's when present — that is how a multi-part
  // object gets more than one colour — so it is tried first.
  const extruders = config
    ? readConfigExtruders(config, [
        'metadata[type="volume"][key="extruder"]',
        'metadata[type="object"][key="extruder"]',
      ])
    : new Map<string, number>();
  const names = config
    ? readConfigNames(config, 'metadata[key="name"]')
    : new Map<string, string>();

  // The palette lives in the PRINT config, as commented key = value lines.
  const palette = readSemicolonList(
    entries.get("metadata/slic3r_pe.config"),
    /^;?\s*filament_colour\s*=\s*(.+)$/im,
  );

  if (extruders.size === 0 && palette.length === 0) return undefined;
  apply(objects, extruders, names, palette);
  return { objects: strip(objects), palette, source: "prusaslicer" };
}

// ── Bambu Studio / MakerWorld ────────────────────────────────────────────────

function readBambu(
  entries: Map<string, string>,
  objects: WorkingObject[],
): ImportedColours | undefined {
  const config = entries.get("metadata/model_settings.config");

  // Bambu writes an untyped <metadata key="extruder"> on the object, and the
  // same key on each <part> of a multi-part object. The part is the more
  // specific statement, so it is tried first.
  const extruders = config
    ? readConfigExtruders(config, [
        'part > metadata[key="extruder"]',
        'metadata[key="extruder"]',
      ])
    : new Map<string, number>();
  const names = config
    ? readConfigNames(config, 'metadata[key="name"]')
    : new Map<string, string>();

  const palette = readBambuPalette(entries.get("metadata/project_settings.config"));

  if (extruders.size === 0 && palette.length === 0) return undefined;
  apply(objects, extruders, names, palette);
  return { objects: strip(objects), palette, source: "bambu" };
}

/** project_settings.config is JSON. Its filament_colour is an array, though
 *  some exporters write a single string. */
function readBambuPalette(json?: string): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { filament_colour?: unknown };
    const raw = parsed.filament_colour;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    return list.map((c) => hex6(String(c))).filter((c): c is string => !!c);
  } catch {
    return [];
  }
}

// ── Shared config reading ────────────────────────────────────────────────────

/** Object id -> 1-based extruder, from a slicer's per-object config document.
 *  `selectors` are tried in order, most specific first; the first that matches
 *  inside an object wins. Passing selectors rather than a callback keeps the
 *  two dialects' differences to the one thing that actually differs. */
function readConfigExtruders(configXml: string, selectors: string[]): Map<string, number> {
  const $ = cheerio.load(configXml, { xmlMode: true });
  const out = new Map<string, number>();
  $("object").each((_i, el) => {
    const id = (el as { attribs?: Record<string, string> }).attribs?.id;
    if (!id) return;
    let value: string | undefined;
    for (const selector of selectors) {
      value = $(el).find(selector).first().attr("value");
      if (value !== undefined) break;
    }
    const extruder = Number(value);
    if (value !== undefined && Number.isFinite(extruder) && extruder >= 1) {
      out.set(id, Math.round(extruder));
    }
  });
  return out;
}

/** Object id -> the name the file gives it, for reporting to the user. */
function readConfigNames(configXml: string, selector: string): Map<string, string> {
  const $ = cheerio.load(configXml, { xmlMode: true });
  const out = new Map<string, string>();
  $("object").each((_i, el) => {
    const id = (el as { attribs?: Record<string, string> }).attribs?.id;
    if (!id) return;
    const name = $(el).find(selector).first().attr("value");
    if (name) out.set(id, name);
  });
  return out;
}

/** A "#A;#B;#C" (or comma-separated) list from a config line. */
function readSemicolonList(text: string | undefined, pattern: RegExp): string[] {
  if (!text) return [];
  const m = text.match(pattern);
  if (!m) return [];
  return m[1]
    .split(/[;,]/)
    .map((c) => hex6(c))
    .filter((c): c is string => !!c);
}

/** Stamp what the config said onto the objects the model document listed. */
function apply(
  objects: WorkingObject[],
  extruders: Map<string, number>,
  names: Map<string, string>,
  palette: string[],
): void {
  for (const obj of objects) {
    const extruder = extruders.get(obj.objectId);
    if (extruder !== undefined) {
      obj.extruder = extruder;
      // Extruders are 1-based; the palette is a plain list in extruder order.
      obj.colourHex = palette[extruder - 1];
    }
    obj.name ??= names.get(obj.objectId);
  }
}

/** Drop the working-only fields so callers see the published shape. */
function strip(objects: WorkingObject[]): ImportedObject[] {
  return objects.map(({ objectId, name, extruder, colourHex }) => {
    const out: ImportedObject = { objectId };
    if (name !== undefined) out.name = name;
    if (extruder !== undefined) out.extruder = extruder;
    if (colourHex !== undefined) out.colourHex = colourHex;
    return out;
  });
}

/** Normalize any of "#RGB", "#RRGGBB", "#RRGGBBAA" to "#rrggbb".
 *  Alpha is dropped: a filament has no opacity, and keeping it would make two
 *  spellings of the same colour compare unequal. */
export function hex6(input?: string): string | undefined {
  if (!input) return undefined;
  let h = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-f]{8}$/.test(h)) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : undefined;
}
