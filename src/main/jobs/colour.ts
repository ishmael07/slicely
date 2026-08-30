// Resolve each part's requested colour against what's ACTUALLY loaded on the
// printer. v1 only ever set `filamentColour` for the PrusaSlicer preview
// (prusaslicer.ts says so explicitly: "on a single-extruder FDM print this
// is PREVIEW-ONLY"). This module is the real multi-colour logic: given the
// printer's FilamentSlot list (its AMS/MMU spools), map every part to a
// physical extruder index PrusaSlicer's config actually has loaded.
//
// Colour matching is done in CIE Lab space (Delta-E, CIE76 — the simple
// Euclidean-in-Lab metric, not the more elaborate CIEDE2000). CIE76 is not
// perceptually perfect, but it is vastly closer to human colour perception
// than Euclidean distance in raw sRGB, which badly under-weights how
// noticeable a change in a dark/saturated channel is relative to a bright
// one. No colour-management dependency exists in this repo, so the
// sRGB -> linear -> XYZ -> Lab pipeline below is implemented directly
// against the standard formulas (D65 white point).

import type { ColourAssignment, ColourPlan, JobPart } from "../../shared/jobs";
import type { FilamentSlot } from "../../shared/printers";

/** Grams purged on a typical AMS/MMU tool change. A rough constant, not a
 *  per-printer measurement — flagged as an estimate wherever it's surfaced. */
const PURGE_G_PER_TOOL_CHANGE = 3;

export function planColours(parts: JobPart[], slots: FilamentSlot[]): ColourPlan {
  const usable = slots.filter((s) => s.loaded !== false && !!s.colourHex);
  const singleExtruder = usable.length < 2;

  const warnings: string[] = [];
  if (singleExtruder) {
    // Deliberately NOT claiming "preview-only" here.
    //
    // Whether a requested colour actually prints depends on something this
    // function cannot see: the planner groups a single-extruder job so each
    // colour gets its OWN PLATE, and then the colours are entirely real — you
    // load red, print plate 1, load blue, print plate 2. Saying "preview-only"
    // told users their colours had been ignored moments after Slicely arranged
    // the whole job around them. The planner explains the outcome instead,
    // because only it knows the grouping.
    // With a SINGLE requested colour there is nothing to resolve or warn about:
    // the user loads that filament and prints. Saying "colours can't be matched
    // to specific spools" made the simplest, most common request — "print this
    // in black" — read like a failure.
    const requested = [...new Set(parts.map((p) => p.colourHex).filter(Boolean))];
    if (requested.length > 1) {
      warnings.push(
        usable.length === 0
          ? "No filament is reported loaded, so colours can't be matched to specific spools."
          : "Only one filament slot is loaded, so this printer prints one colour at a time.",
      );
    }
  }

  const assignments: ColourAssignment[] = parts.map((part) => resolveOne(part, usable, singleExtruder));

  // A substituted colour must never be silent: the user asked for one colour
  // and will get another, and they can only fix that by loading the spool they
  // wanted. Grouped by requested colour so one swap doesn't produce ten
  // near-identical lines.
  const substituted = new Map<string, string>();
  assignments.forEach((a, i) => {
    if (a.reason !== "nearest-colour") return;
    const requested = parts[i]?.colourHex;
    if (requested) substituted.set(requested.toLowerCase(), a.colourHex);
  });
  for (const [requested, got] of substituted) {
    warnings.push(
      `No ${requested} filament is loaded — using the closest loaded colour, ${got}. ` +
        `Load ${requested} in a slot if you want an exact match.`,
    );
  }

  // Tool-change estimate: count colour changes between CONSECUTIVE parts in
  // the given order (a proxy for print order — the planner is responsible
  // for actually grouping by colour before this list is finalized per
  // plate). Distinct extruders back-to-back cost one change each transition.
  let toolChanges = 0;
  for (let i = 1; i < assignments.length; i++) {
    if (assignments[i].extruder !== assignments[i - 1].extruder) toolChanges++;
  }

  return {
    slots,
    assignments,
    toolChanges,
    wasteG: toolChanges > 0 ? toolChanges * PURGE_G_PER_TOOL_CHANGE : undefined,
    warnings,
    singleExtruder,
  };
}

function resolveOne(
  part: JobPart,
  usable: FilamentSlot[],
  singleExtruder: boolean,
): ColourAssignment {
  const requested = normalizeHex(part.colourHex);

  // Fewer than 2 real slots (or none reported): nothing meaningful to
  // resolve against — pass the request straight through as a preview
  // colour. This is also the path taken when the caller didn't supply any
  // slot info at all (e.g. printer status hasn't been polled yet).
  if (singleExtruder) {
    return {
      partPath: part.path,
      extruder: usable.length === 1 ? usable[0].index + 1 : 1,
      colourHex: requested ?? usable[0]?.colourHex ?? "#ffffff",
      reason: "user",
    };
  }

  // No colour requested at all: assign a slot round-robin-free default (the
  // first usable slot) rather than inventing a preference.
  if (!requested) {
    const slot = usable[0];
    return { partPath: part.path, extruder: slot.index + 1, colourHex: slot.colourHex!, reason: "default" };
  }

  // Exact match against a loaded slot.
  const exact = usable.find((s) => normalizeHex(s.colourHex) === requested);
  if (exact) {
    return { partPath: part.path, extruder: exact.index + 1, colourHex: exact.colourHex!, reason: "matched-slot" };
  }

  // No exact match: nearest loaded colour by Delta-E (CIE76) in Lab space.
  const reqLab = hexToLab(requested);
  let best = usable[0];
  let bestDist = Infinity;
  for (const s of usable) {
    const dist = deltaE76(reqLab, hexToLab(normalizeHex(s.colourHex)!));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return {
    partPath: part.path,
    extruder: best.index + 1,
    colourHex: best.colourHex!,
    reason: "nearest-colour",
  };
}

// ── Colour math ──────────────────────────────────────────────────────────

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Normalize to "#rrggbb" lowercase; accepts "#rgb"/"rgb" short forms too.
 *  Returns undefined for anything that isn't recognizably a hex colour. */
export function normalizeHex(input?: string): string | undefined {
  if (!input) return undefined;
  let h = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) {
    h = h.split("").map((c) => c + c).join("");
  }
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : undefined;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB (D65) -> CIE XYZ, standard matrix. */
function rgbToXyz(r: number, g: number, b: number): { x: number; y: number; z: number } {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  return {
    x: rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375,
    y: rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175,
    z: rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041,
  };
}

const WHITE_D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

function xyzToLab(x: number, y: number, z: number): Lab {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / WHITE_D65.x);
  const fy = f(y / WHITE_D65.y);
  const fz = f(z / WHITE_D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function hexToLab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const { x, y, z } = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** CIE76 Delta-E: plain Euclidean distance in Lab space. Simpler than
 *  CIEDE2000 and not perceptually uniform at the margins, but a large
 *  improvement over sRGB-Euclidean, and adequate for "which of a handful of
 *  loaded spools looks closest". */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}
