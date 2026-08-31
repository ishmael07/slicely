// ─────────────────────────────────────────────────────────────────────────────
// Making a downloaded model's own colours usable.
//
// threemfColour.ts reads what a 3MF says about colour. This turns that into
// something the rest of Slicely can act on, because the planner reasons about
// PARTS with colours: a multi-colour download has to become several coloured
// parts before it can be oriented, packed, plated and printed.
//
// The split is only right for a model whose author expressed colour by
// separating objects, which is how most multi-colour downloads are built. A
// model PAINTED in one mesh is deliberately left whole: its colours are regions
// inside a single solid, and cutting it up would destroy exactly the thing
// being preserved. Those survive by carrying the paint codes through the 3MF
// writer instead (see threemf.ts).
// ─────────────────────────────────────────────────────────────────────────────
import { join } from "node:path";
import { extname } from "node:path";
import { parse3mfObjects } from "./mesh";
import { writeShellStl } from "./shells";
import { readThreeMfColours } from "./threemfColour";

/** One object of a downloaded model, written out as its own printable part. */
export interface ColouredPart {
  /** Absolute path to the STL written for this object. */
  path: string;
  /** The name the source file gave it, for talking to the user. */
  name: string;
  /** The colour the source file assigned it, "#rrggbb". */
  colourHex?: string;
}

/** What a model already says about its own colours. */
export interface ImportedColourSummary {
  /** Filament colours the file uses, in extruder order. */
  palette: string[];
  /** Objects the file assigns a colour of their own. */
  colouredObjects: number;
  /** Objects carrying per-triangle painting. */
  paintedObjects: number;
  /** One line to relay to the user. */
  note: string;
}

/**
 * Describe the colours a model arrives with.
 *
 * Returns undefined when the file says nothing about colour — an STL, or a
 * plain 3MF export. That is not a failure; most models are one colour.
 */
export async function summariseModelColours(
  filePath: string,
): Promise<ImportedColourSummary | undefined> {
  if (extname(filePath).toLowerCase() !== ".3mf") return undefined;

  const found = await readThreeMfColours(filePath);
  const colouredObjects = found.objects.filter((o) => o.colourHex).length;
  const paintedObjects = found.objects.filter((o) => o.paint).length;
  if (found.palette.length === 0 && paintedObjects === 0) return undefined;

  const distinct = [...new Set(found.objects.map((o) => o.colourHex).filter(Boolean))];
  const parts: string[] = [];
  if (distinct.length > 1) {
    parts.push(
      `This model already carries ${distinct.length} colours (${distinct.join(", ")}) ` +
        `across ${colouredObjects} parts.`,
    );
  } else if (found.palette.length > 1) {
    parts.push(`This model ships a ${found.palette.length}-colour palette (${found.palette.join(", ")}).`);
  } else if (distinct.length === 1) {
    parts.push(`This model is coloured ${distinct[0]}.`);
  }
  if (paintedObjects > 0) {
    parts.push(
      `${paintedObjects} part${paintedObjects === 1 ? " is" : "s are"} painted — the colours are ` +
        `regions inside the mesh, and they are carried through as they are rather than split up.`,
    );
  }

  return { palette: found.palette, colouredObjects, paintedObjects, note: parts.join(" ") };
}

/**
 * Split a multi-colour 3MF into one coloured part per object.
 *
 * Each object is written as its own STL AT ITS PLACE IN THE ASSEMBLY — the
 * pieces of a model are only meaningful relative to each other, and re-centring
 * each one would scatter a board and its headers across the bed.
 *
 * Returns an empty list, and writes nothing, when splitting would gain
 * nothing: a file with fewer than two distinct object colours, a painted model
 * (whose colours are inside one mesh), or anything that isn't a 3MF.
 */
export async function expandColouredThreeMf(
  filePath: string,
  destDir: string,
): Promise<ColouredPart[]> {
  if (extname(filePath).toLowerCase() !== ".3mf") return [];

  const found = await readThreeMfColours(filePath);
  const distinct = new Set(found.objects.map((o) => o.colourHex).filter(Boolean));
  if (distinct.size < 2) return [];

  let objects;
  try {
    objects = await parse3mfObjects(filePath);
  } catch {
    // Colour is an enhancement. A mesh we can't re-read is still importable
    // whole, so say "nothing to split" rather than failing the import.
    return [];
  }

  // Line the geometry up with the colour metadata by object id. A build item
  // can place the same object twice, so an id may appear more than once; each
  // placement is a real instance and becomes its own part.
  const colourOf = new Map(found.objects.map((o) => [o.objectId, o]));
  const parts: ColouredPart[] = [];
  const used = new Map<string, number>();

  for (const object of objects) {
    const meta = colourOf.get(object.objectId);
    const seen = (used.get(object.objectId) ?? 0) + 1;
    used.set(object.objectId, seen);
    const suffix = seen > 1 ? `-${seen}` : "";
    const stem = safeStem(meta?.name ?? `object-${object.objectId}`);
    const path = writeShellStl(join(destDir, `${stem}${suffix}.stl`), {
      triangles: object.triangles,
    });
    parts.push({ path, name: meta?.name ?? `object ${object.objectId}`, colourHex: meta?.colourHex });
  }

  return parts;
}

/** A filename-safe stem from a name the file chose, which may be anything. */
function safeStem(name: string): string {
  const cleaned = name
    .replace(/\.(stl|3mf|obj|amf)$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "part";
}
