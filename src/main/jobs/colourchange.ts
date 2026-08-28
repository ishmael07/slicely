// ─────────────────────────────────────────────────────────────────────────────
// Colour changes partway up a print — how ONE part gets more than one colour.
//
// Assigning whole parts to different filaments (threemf.ts) only helps a model
// that ships as several files. A single mesh needs a different mechanism, and
// there are exactly two: paint its triangles (a GUI job — you are choosing
// regions by eye), or change filament at a height. The second covers most of
// what people actually want — a two-tone keychain, a dark base under a light
// body, a banded vase — and works on EVERY printer, including a single-extruder
// machine with no AMS, because it is just a pause-and-swap.
//
// PrusaSlicer stores these in a project as `custom_gcode_per_print_z`. Its CLI
// ignores that file entirely (verified against 2.9.5: a project carrying one
// slices happily and emits no M600), so this post-processes the G-code instead
// — which is what the GUI feature ultimately produces anyway.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";

/** A filament swap at a height, with the colour that begins there. */
export interface HeightColourChange {
  /** Height in mm at which the new colour starts. */
  atZ: number;
  /** Colour that begins at this height, "#RRGGBB". */
  colourHex: string;
}

export interface ColourChangeResult {
  /** How many swaps were actually inserted. */
  inserted: number;
  /** The Z heights where they landed — the real layer height, which is
   *  quantised to a layer boundary and so rarely exactly what was asked for. */
  atZ: number[];
  /** Requested changes that fell outside the model and were skipped. */
  skipped: HeightColourChange[];
}

/** The command that pauses for a manual filament swap. Understood by Marlin,
 *  Klipper (with a matching macro), and Prusa firmware. */
const SWAP_COMMAND = "M600";

/**
 * Insert filament-swap commands into a sliced G-code file.
 *
 * Each requested change lands at the FIRST layer whose top is at or above the
 * requested height, because a swap has to happen on a layer boundary: stopping
 * mid-layer would leave a visible seam and a blob where the nozzle sat.
 *
 * A change above the model's top layer is skipped rather than appended — it
 * would pause at the end of a finished print, which is confusing and wastes
 * filament on a purge nobody sees.
 *
 * Returns what actually happened so the caller can tell the user the real
 * heights instead of the requested ones.
 */
export function insertColourChanges(
  gcodePath: string,
  changes: HeightColourChange[],
): ColourChangeResult {
  if (changes.length === 0) return { inserted: 0, atZ: [], skipped: [] };

  const source = readFileSync(gcodePath, "utf8");
  const lines = source.split("\n");

  // Ordered by height; two swaps at the same layer would fight each other, so
  // only the first survives (tracked via `usedLayers`).
  const wanted = [...changes].sort((a, b) => a.atZ - b.atZ);

  const out: string[] = [];
  const insertedAt: number[] = [];
  const usedLayers = new Set<number>();
  let next = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // PrusaSlicer marks each new layer with ;LAYER_CHANGE then ;Z:<height>.
    // Insert BEFORE the marker so the swap happens between layers.
    if (line.startsWith(";LAYER_CHANGE") && next < wanted.length) {
      const zLine = lines[i + 1] ?? "";
      const m = zLine.match(/^;Z:([\d.]+)/);
      const z = m ? Number(m[1]) : NaN;

      if (Number.isFinite(z)) {
        while (next < wanted.length && z >= wanted[next].atZ) {
          const change = wanted[next];
          next++;
          if (usedLayers.has(z)) continue; // one swap per layer
          usedLayers.add(z);
          out.push(
            `; Slicely: filament change to ${change.colourHex.toUpperCase()} ` +
              `at ${z} mm (requested ${change.atZ} mm)`,
          );
          out.push(`;COLOR_CHANGE,T0,${change.colourHex.toUpperCase()}`);
          out.push(SWAP_COMMAND);
          insertedAt.push(z);
        }
      }
    }
    out.push(line);
  }

  const skipped = wanted.slice(next);
  if (insertedAt.length > 0) writeFileSync(gcodePath, out.join("\n"), "utf8");

  return { inserted: insertedAt.length, atZ: insertedAt, skipped };
}

/**
 * Turn "make the bottom third red and the rest blue" into concrete heights.
 *
 * Bands are equal fractions of the model's height. The first colour starts at
 * the bed and so needs no swap — only the transitions do — which is why this
 * returns one fewer change than there are colours.
 */
export function bandsToChanges(
  modelHeightMm: number,
  colours: string[],
): HeightColourChange[] {
  if (colours.length < 2 || modelHeightMm <= 0) return [];
  const band = modelHeightMm / colours.length;
  return colours.slice(1).map((colourHex, i) => ({
    atZ: Number((band * (i + 1)).toFixed(2)),
    colourHex,
  }));
}
