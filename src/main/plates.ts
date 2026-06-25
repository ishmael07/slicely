// Bin-pack parts across one or more print plates when they don't all fit on a
// single bed. PrusaSlicer's CLI arranges only onto ONE plate (it slices bed 0
// and silently drops anything off-bed), so Slicely does the plate-splitting
// itself: each plate is sliced separately.
//
// The packer is a simple, conservative shelf/skyline bin-pack on the parts'
// XY footprints. It MIRRORS what PrusaSlicer's CLI arranger actually does, so a
// plate the packer accepts is one PrusaSlicer can place without dropping a part:
//   • NO part rotation, anywhere. The CLI arranger is built with rotations=false
//     (verified vs PrusaSlicer source, version_2.9.5) and centers each part in
//     its imported orientation, so it never spins a part to make it fit. Both
//     the packing decision AND the oversized check use the as-imported footprint
//     — a part that would fit only rotated is genuinely oversized (the slicer
//     won't turn it), and a multi-part fit that needs rotation would overflow.
//   • No bed-edge margin (the arranger uses distance_from_bed = 0); `spacing` is
//     only the gap left BETWEEN parts.
//   • Object gap defaults to min_object_distance = duplicate_distance (6 mm), and
//     grows under sequential printing (complete_objects). The caller passes the
//     profile-derived spacing (and the footprints already include scale/rotate)
//     so the packer matches the slicer's real arrange.

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

/** Default gap left between parts, in mm. Matches PrusaSlicer's
 *  min_object_distance default (duplicate_distance = 6 mm). Callers should pass
 *  the profile-derived spacing instead of relying on this. */
export const DEFAULT_SPACING = 6;

/**
 * Pack parts onto as few plates as possible using a first-fit shelf algorithm.
 * Parts are sorted tallest-footprint first; each is placed on the current shelf
 * if it fits, else a new shelf, else a new plate. Parts are NOT rotated — the
 * grouping must match PrusaSlicer's un-rotated arrange so a packed plate never
 * overflows and drops a part. `spacing` is the gap left BETWEEN parts in mm
 * (the slicer's min_object_distance for the active profile); there is no
 * bed-edge margin, matching the arranger's distance_from_bed = 0.
 */
export function packPlates(
  parts: PlatePart[],
  bed: BedArea,
  spacing: number = DEFAULT_SPACING,
): PackResult {
  const oversized: PlatePart[] = [];
  const fits = parts.filter((p) => {
    // Oversized ONLY if the part exceeds the bed in its AS-IMPORTED orientation.
    // PrusaSlicer's CLI arranger is rotations=false and centers a part WITHOUT
    // spinning it (distance_from_bed = 0), so a part that would only fit rotated
    // is genuinely oversized — the slicer won't turn it to make it fit. No
    // spacing here: spacing is the gap BETWEEN parts, not a bed-edge margin.
    const ok = fitsAsImported(p, bed.w, bed.d);
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
      if (placeOnPlate(plate, part, bed.w, bed.d, spacing)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      const plate: Plate = { parts: [] };
      placeOnPlate(plate, part, bed.w, bed.d, spacing); // fits (passed `fits`)
      plates.push(plate);
    }
  }

  return { plates, oversized };
}

/** True if the part fits the bed in its AS-IMPORTED orientation. PrusaSlicer's
 *  CLI arranger does not rotate parts, so we must NOT credit a 90° turn the
 *  slicer would never make — a part that fits only rotated is oversized. No
 *  inter-part spacing applies to the oversized check (it's a bed-fit test). */
function fitsAsImported(p: PlatePart, bedW: number, bedD: number): boolean {
  return p.w <= bedW && p.d <= bedD;
}

/**
 * Try to add `part` to `plate` using a shelf model: track shelves as rows that
 * grow downward. `spacing` is the gap left BETWEEN parts on a shelf and BETWEEN
 * shelves (not against the bed edge). Parts are placed WITHOUT rotation so the
 * grouping matches PrusaSlicer's un-rotated arrange (which would otherwise drop
 * a part that only "fit" rotated).
 */
function placeOnPlate(
  plate: Plate,
  part: PlatePart,
  bedW: number,
  bedD: number,
  spacing: number,
): boolean {
  // Reconstruct shelves from already-placed parts (small N, so recompute).
  const shelves = buildShelves(plate.parts, bedW, spacing);

  for (const shelf of shelves) {
    // Add to this shelf if there's room widthwise (gap before this part) and the
    // part is no taller than the shelf band.
    const needW = shelf.usedW > 0 ? spacing + part.w : part.w;
    if (shelf.usedW + needW <= bedW && part.d <= shelf.height) {
      plate.parts.push(part);
      return true;
    }
  }

  // New shelf below the existing ones (gap before the new shelf if any exist).
  const occupiedH =
    shelves.reduce((s, sh) => s + sh.height, 0) +
    Math.max(0, shelves.length - 1) * spacing;
  const needH = shelves.length > 0 ? spacing + part.d : part.d;
  if (occupiedH + needH <= bedD && part.w <= bedW) {
    plate.parts.push(part);
    return true;
  }

  return false;
}

interface Shelf {
  usedW: number;
  height: number;
}

/** Greedily reconstruct shelves for the parts already on a plate. `usedW` is the
 *  occupied width including inter-part gaps; `height` is the tallest part on the
 *  shelf (its depth band). */
function buildShelves(parts: PlatePart[], bedW: number, spacing: number): Shelf[] {
  const shelves: Shelf[] = [];
  for (const p of parts) {
    const shelf = shelves[shelves.length - 1];
    const needW = shelf && shelf.usedW > 0 ? spacing + p.w : p.w;
    if (shelf && shelf.usedW + needW <= bedW) {
      shelf.usedW += needW;
      shelf.height = Math.max(shelf.height, p.d);
    } else {
      shelves.push({ usedW: p.w, height: p.d });
    }
  }
  return shelves;
}
