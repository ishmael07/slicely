// Bin-pack parts across one or more print plates when they don't all fit on a
// single bed. PrusaSlicer's CLI arranges only onto ONE plate, so Slicely does
// the plate-splitting itself: each plate is sliced separately.
//
// The packer is a simple, conservative shelf/skyline bin-pack on the parts'
// XY footprints (with 90° rotation allowed). It deliberately over-estimates
// spacing so a packed plate won't overflow once PrusaSlicer re-arranges it.

/** A part to place, identified by its file path + footprint in mm. */
export interface PlatePart {
  path: string;
  /** Footprint width/depth in mm (the larger two of the bounding box). */
  w: number;
  d: number;
}

/** A usable bed area in mm (build volume minus a safety margin). */
export interface BedArea {
  w: number;
  d: number;
}

/** One plate's worth of parts. */
export interface Plate {
  parts: PlatePart[];
}

export interface PackResult {
  plates: Plate[];
  /** Parts too large to fit any plate even alone (caller should warn + scale). */
  oversized: PlatePart[];
}

/** Gap left between parts and around the bed edge, in mm. */
const SPACING = 6;

/**
 * Pack parts onto as few plates as possible using a first-fit shelf algorithm.
 * Parts are sorted tallest-footprint first; each is placed on the current shelf
 * if it fits, else a new shelf, else a new plate. Rotation by 90° is tried when
 * the part doesn't fit in its original orientation.
 */
export function packPlates(parts: PlatePart[], bed: BedArea): PackResult {
  const usableW = bed.w - SPACING;
  const usableD = bed.d - SPACING;

  const oversized: PlatePart[] = [];
  const fits = parts.filter((p) => {
    const ok = orientFits(p, usableW, usableD);
    if (!ok) oversized.push(p);
    return ok;
  });

  // Largest footprint first packs more tightly.
  const sorted = [...fits].sort(
    (a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d),
  );

  const plates: Plate[] = [];
  for (const part of sorted) {
    let placed = false;
    for (const plate of plates) {
      if (placeOnPlate(plate, part, usableW, usableD)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      const plate: Plate = { parts: [] };
      placeOnPlate(plate, part, usableW, usableD); // always fits (passed `fits`)
      plates.push(plate);
    }
  }

  return { plates, oversized };
}

/** True if the part fits the bed in either orientation. */
function orientFits(p: PlatePart, w: number, d: number): boolean {
  return (
    (p.w + SPACING <= w && p.d + SPACING <= d) ||
    (p.d + SPACING <= w && p.w + SPACING <= d)
  );
}

/**
 * Try to add `part` to `plate` using a shelf model: track shelves as rows that
 * grow downward. We approximate occupancy with running shelf widths/heights —
 * good enough to decide grouping (PrusaSlicer does the real arrange per plate).
 */
function placeOnPlate(
  plate: Plate,
  part: PlatePart,
  bedW: number,
  bedD: number,
): boolean {
  // Reconstruct shelves from already-placed parts (small N, so recompute).
  const shelves = buildShelves(plate.parts, bedW, bedD);
  const fw = part.w + SPACING;
  const fd = part.d + SPACING;

  for (const shelf of shelves) {
    // Fits on this shelf without rotation?
    if (shelf.usedW + fw <= bedW && fd <= shelf.height) {
      plate.parts.push(part);
      return true;
    }
    // Try rotated.
    if (shelf.usedW + fd <= bedW && fw <= shelf.height) {
      plate.parts.push({ path: part.path, w: part.d, d: part.w });
      return true;
    }
  }

  // New shelf below the existing ones?
  const usedHeight = shelves.reduce((s, sh) => s + sh.height, 0);
  if (usedHeight + fd <= bedD && fw <= bedW) {
    plate.parts.push(part);
    return true;
  }
  if (usedHeight + fw <= bedD && fd <= bedW) {
    plate.parts.push({ path: part.path, w: part.d, d: part.w });
    return true;
  }

  return false;
}

interface Shelf {
  usedW: number;
  height: number;
}

/** Greedily reconstruct shelves for the parts already on a plate. */
function buildShelves(parts: PlatePart[], bedW: number, _bedD: number): Shelf[] {
  const shelves: Shelf[] = [];
  for (const p of parts) {
    const fw = p.w + SPACING;
    const fd = p.d + SPACING;
    const shelf = shelves[shelves.length - 1];
    if (shelf && shelf.usedW + fw <= bedW) {
      shelf.usedW += fw;
      shelf.height = Math.max(shelf.height, fd);
    } else {
      shelves.push({ usedW: fw, height: fd });
    }
  }
  return shelves;
}
