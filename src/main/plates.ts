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
  /** Where the packer put it: the footprint's lower-left corner, in mm from
   *  the bed's origin. Set by packPlates.
   *
   *  This exists so ONE algorithm decides layout. Previously the packer chose
   *  which parts shared a plate and the 3MF writer independently chose where
   *  they sat, so the two could disagree about whether a plate actually fit. */
  x?: number;
  y?: number;
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

/** Clearance kept between the outermost part and the bed edge, in mm.
 *  PrusaSlicer draws the skirt and brim outside the objects, so a part flush
 *  against the edge puts that outline off the bed. */
const BED_MARGIN_MM = 10;

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

  // Try several orderings and keep whichever needs the fewest plates.
  //
  // The shelf packer's result depends entirely on the order parts arrive in,
  // and no single ordering is best. On a real job — two 255x99 stand halves and
  // one 24x269 bar on a 325x320 bed — longest-side-first put the long bar on a
  // shelf with one stand half, leaving a shelf too shallow for the second, and
  // split a job that fits ONE plate across two. Sorting by depth groups the two
  // equal-depth halves onto the same shelf and everything fits.
  //
  // Each ordering is a linear pass over a handful of parts, so trying four
  // costs nothing measurable and removes the worst outcomes.
  const ORDERINGS: Array<(a: PlatePart, b: PlatePart) => number> = [
    (a, b) => b.d - a.d || b.w - a.w, // deepest first — groups equal depths
    (a, b) => b.w - a.w || b.d - a.d, // widest first
    (a, b) => b.w * b.d - a.w * a.d, // biggest area first
    (a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d), // longest side first
  ];

  let best: Plate[] | undefined;
  for (const compare of ORDERINGS) {
    const attempt = packWithOrder([...fits].sort(compare), bed, spacing);
    if (!best || attempt.length < best.length) best = attempt;
    if (best.length === 1) break; // cannot do better than one plate
  }

  return { plates: best ?? [], oversized };
}

/** True if the part fits the bed in its AS-IMPORTED orientation. Parts are
 *  never rotated here — the pose is the orientation pass's decision, and
 *  re-spinning a part to make it fit would contradict what was reported to the
 *  user and what the geometry handed to the slicer actually is. */
function fitsAsImported(p: PlatePart, bedW: number, bedD: number): boolean {
  // Against the USABLE area, since that is where a part can actually be placed.
  return p.w <= bedW - 2 * BED_MARGIN_MM && p.d <= bedD - 2 * BED_MARGIN_MM;
}

/**
 * One packing pass over parts in the order given, placing each at a concrete
 * position.
 *
 * Uses a free-rectangle model rather than shelves. Shelves force parts into
 * full-width rows, which fails badly on mixed shapes: two 255x99 stand halves
 * and one 24x269 bar fit easily side by side on a 325x320 bed, but any shelf
 * ordering wastes a whole row on the deep bar and splits the job across two
 * plates. Free rectangles let a tall narrow part sit BESIDE a stack of short
 * wide ones, which is what a person would do.
 *
 * Parts are never rotated, matching the rest of this module: the pose is the
 * orientation pass's decision, and re-spinning a part here would contradict it.
 */
function packWithOrder(sorted: PlatePart[], bed: BedArea, spacing: number): Plate[] {
  const plates: Plate[] = [];
  const freeLists: Rect[][] = [];

  for (const part of sorted) {
    let placed = false;
    for (let i = 0; i < plates.length && !placed; i++) {
      placed = placeInFree(freeLists[i], plates[i], part, spacing);
    }
    if (!placed) {
      const plate: Plate = { parts: [] };
      // Keep clear of the bed edge. Parts are now placed at explicit
      // coordinates rather than left to PrusaSlicer's arranger, and the slicer
      // draws a skirt/brim AROUND the objects — packing flush to (0,0) pushed
      // the toolpath to X-7 Y-7, i.e. off the bed.
      const free: Rect[] = [
        {
          x: BED_MARGIN_MM,
          y: BED_MARGIN_MM,
          w: Math.max(0, bed.w - 2 * BED_MARGIN_MM),
          d: Math.max(0, bed.d - 2 * BED_MARGIN_MM),
        },
      ];
      plates.push(plate);
      freeLists.push(free);
      // A part that fits the bed at all must fit an empty plate; if it somehow
      // does not, drop it rather than loop forever.
      if (!placeInFree(free, plate, part, spacing)) {
        plates.pop();
        freeLists.pop();
      }
    }
  }
  return plates;
}

/** A free area on the bed. */
interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

/**
 * Place a part in the best free rectangle, then split what remains.
 *
 * "Best" is the tightest fit by leftover area, which keeps large open regions
 * intact for the parts still to come.
 *
 * `spacing` is reserved on the part's top and right, so neighbours never touch:
 * the gap belongs to whichever part is placed first, and the bed edge needs no
 * margin (PrusaSlicer's arranger uses distance_from_bed = 0).
 */
function placeInFree(
  free: Rect[],
  plate: Plate,
  part: PlatePart,
  spacing: number,
): boolean {
  let best = -1;
  let bestWaste = Infinity;
  for (let i = 0; i < free.length; i++) {
    const r = free[i];
    // A part fits if the part fits. Spacing is a gap BETWEEN parts, so it is
    // taken out of the remainder when the rectangle is split — not demanded up
    // front. Requiring part + spacing to fit rejected a 198.6mm part from a
    // 200mm space for a gap no neighbour was ever going to use.
    if (part.w > r.w || part.d > r.d) continue;

    const waste = r.w * r.d - part.w * part.d;
    if (waste < bestWaste) {
      bestWaste = waste;
      best = i;
    }
  }
  if (best < 0) return false;

  const r = free[best];
  const placedPart: PlatePart = { ...part, x: r.x, y: r.y };
  plate.parts.push(placedPart);

  // Guillotine split: the strip to the right, and the strip above.
  const usedW = Math.min(r.w, part.w + spacing);
  const usedD = Math.min(r.d, part.d + spacing);
  const remainder: Rect[] = [];
  if (r.w - usedW > 0) {
    remainder.push({ x: r.x + usedW, y: r.y, w: r.w - usedW, d: r.d });
  }
  if (r.d - usedD > 0) {
    remainder.push({ x: r.x, y: r.y + usedD, w: usedW, d: r.d - usedD });
  }
  free.splice(best, 1, ...remainder);
  return true;
}

