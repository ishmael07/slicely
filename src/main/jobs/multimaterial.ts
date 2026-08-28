// ─────────────────────────────────────────────────────────────────────────────
// Turning a colour plan into G-code that actually changes filament.
//
// Before this, Slicely resolved colours against the printer's loaded spools,
// reported the plan, and then threw it away: every plate was sliced from plain
// STLs, which PrusaSlicer prints entirely on extruder 1. The colours were
// cosmetic.
//
// PrusaSlicer's CLI has no flag for "this file prints in blue" — per-object
// extruder assignment lives inside a 3MF project (see threemf.ts). Slicing one
// also needs a printer config that HAS more than one extruder, which is what
// this module synthesizes.
//
// Verified end to end against PrusaSlicer 2.9.5: a two-object 3MF plus the
// config below produces real tool changes (T0/T1) and per-extruder filament
// totals, rather than one colour and a wipe tower that never runs.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PrintMaterial } from "../../shared/types";

/** Filament physical properties, mirroring the single-material synthesis in
 *  profiles.ts so weight and cost estimates stay comparable. */
const FILAMENT: Record<PrintMaterial, { densityGCm3: number; costPerKg: number; nozzleC: number; bedC: number }> = {
  PLA: { densityGCm3: 1.24, costPerKg: 25, nozzleC: 210, bedC: 60 },
  PETG: { densityGCm3: 1.27, costPerKg: 30, nozzleC: 240, bedC: 85 },
  ABS: { densityGCm3: 1.04, costPerKg: 25, nozzleC: 250, bedC: 100 },
};

export interface MultiMaterialConfigInput {
  bed: { x: number; y: number; z: number };
  nozzleMm: number;
  material: PrintMaterial;
  /** One entry per extruder, in extruder order. "#RRGGBB". */
  colours: string[];
  /** Where to write the .ini. Defaults to a temp file. */
  destPath?: string;
}

/**
 * Synthesize a PrusaSlicer config with one extruder per colour.
 *
 * Several of these settings are not optional decoration:
 *
 *  - Per-extruder values must be repeated for EVERY extruder. PrusaSlicer reads
 *    `nozzle_diameter` and friends as vectors; supplying one value for a
 *    two-extruder printer leaves the second undefined.
 *  - `use_relative_e_distances = 1` is REQUIRED whenever the wipe tower is on.
 *    PrusaSlicer refuses to slice otherwise ("The Wipe Tower is currently only
 *    supported with the relative extruder addressing"), which is a hard failure,
 *    not a warning.
 *  - Explicit speeds and temperatures matter: without them the time estimator
 *    overflowed and reported a print time of 2147483647 days.
 */
export function synthesizeMultiMaterialConfig(input: MultiMaterialConfigInput): string {
  const { bed, nozzleMm, material } = input;
  const fil = FILAMENT[material] ?? FILAMENT.PLA;
  const n = Math.max(2, input.colours.length);

  /** Repeat a per-extruder value once per extruder. */
  const per = (value: string | number): string => Array(n).fill(String(value)).join(",");
  const colours = input.colours
    .slice(0, n)
    .map((c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : "#FFFFFF"));
  while (colours.length < n) colours.push("#FFFFFF");

  const lines = [
    `# Synthesized by Slicely for a ${n}-extruder ${material} print`,
    `printer_technology = FFF`,
    `bed_shape = 0x0,${bed.x}x0,${bed.x}x${bed.y},0x${bed.y}`,
    `max_print_height = ${bed.z}`,
    // Plaintext G-code so the metrics parser can read the summary comments.
    `binary_gcode = 0`,

    // ── Per-extruder geometry and filament ───────────────────────────────
    `nozzle_diameter = ${per(nozzleMm)}`,
    `filament_diameter = ${per(1.75)}`,
    `filament_density = ${per(fil.densityGCm3)}`,
    `filament_cost = ${per(fil.costPerKg)}`,
    `filament_colour = ${colours.join(";")}`,
    `extruder_colour = ${colours.join(";")}`,
    `temperature = ${per(fil.nozzleC)}`,
    `first_layer_temperature = ${per(fil.nozzleC + 5)}`,
    `bed_temperature = ${per(fil.bedC)}`,
    `first_layer_bed_temperature = ${per(fil.bedC)}`,

    // ── Multi-material behaviour ─────────────────────────────────────────
    // One hot end fed by several spools (AMS/MMU), which is what consumer
    // multi-colour printers are. The wipe tower purges the old colour.
    `single_extruder_multi_material = 1`,
    `wipe_tower = 1`,
    `wipe_tower_x = ${Math.max(10, bed.x - 60)}`,
    `wipe_tower_y = ${Math.max(10, bed.y - 60)}`,
    `wipe_tower_width = 60`,
    // Required by the wipe tower; PrusaSlicer hard-fails without it.
    `use_relative_e_distances = 1`,
    // With a wipe tower, supports must print on whichever extruder is already
    // active — 0 means "current extruder". Any other value makes PrusaSlicer
    // refuse: "The Wipe Tower currently supports the non-soluble supports only
    // if they are printed with the current extruder without triggering a tool
    // change."
    `support_material_extruder = 0`,
    `support_material_interface_extruder = 0`,
    // Same rule for the skirt and brim.
    `skirt_distance = 2`,
    `ooze_prevention = 0`,

    // ── Per-extruder retraction and tool-change behaviour ────────────────
    // These are VECTORS too. Leaving them to defaults worked with two
    // extruders but made the time estimator overflow at three (it reported
    // 2147483647 days), because the tool-change cost is computed from
    // per-extruder values that were shorter than the extruder count.
    `retract_length = ${per(0.8)}`,
    `retract_speed = ${per(35)}`,
    `deretract_speed = ${per(25)}`,
    `retract_before_travel = ${per(1)}`,
    `retract_layer_change = ${per(1)}`,
    `retract_lift = ${per(0.2)}`,
    `wipe = ${per(1)}`,
    `extruder_offset = ${Array(n).fill("0x0").join(",")}`,
    `filament_loading_speed = ${per(28)}`,
    `filament_loading_speed_start = ${per(3)}`,
    `filament_unloading_speed = ${per(90)}`,
    `filament_unloading_speed_start = ${per(100)}`,
    `filament_toolchange_delay = ${per(0)}`,
    `filament_cooling_moves = ${per(4)}`,
    `filament_cooling_initial_speed = ${per(2.2)}`,
    `filament_cooling_final_speed = ${per(3.4)}`,
    `filament_minimal_purge_on_wipe_tower = ${per(15)}`,
    `filament_max_volumetric_speed = ${per(15)}`,

    // ── Speeds and accelerations ─────────────────────────────────────────
    // Present so the time estimator has real numbers to work with.
    `perimeter_speed = 45`,
    `external_perimeter_speed = 25`,
    `infill_speed = 80`,
    `solid_infill_speed = 80`,
    `top_solid_infill_speed = 40`,
    `travel_speed = 180`,
    `first_layer_speed = 20`,
    `bridge_speed = 25`,
    `gap_fill_speed = 40`,
    `support_material_speed = 50`,
    `max_print_speed = 200`,
    `default_acceleration = 1000`,
    `first_layer_acceleration = 800`,
    `perimeter_acceleration = 800`,
    `infill_acceleration = 1000`,
    `travel_acceleration = 1500`,
    `machine_max_acceleration_extruding = 1500,1250`,
    `machine_max_acceleration_travel = 1500,1250`,
    `machine_max_feedrate_x = 200,100`,
    `machine_max_feedrate_y = 200,100`,
    `machine_max_feedrate_z = 12,12`,
    `machine_max_feedrate_e = 120,120`,
  ];

  const path =
    input.destPath ?? join(tmpdir(), `slicely-mm-${n}x-${material}-${Date.now()}.ini`);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

/**
 * The distinct extruders a set of parts uses, in ascending order.
 *
 * Used to decide whether a plate needs the multi-material path at all: one
 * extruder means the ordinary STL route, which is simpler and avoids a wipe
 * tower the print doesn't need.
 */
export function distinctExtruders(parts: Array<{ extruder?: number }>): number[] {
  return [...new Set(parts.map((p) => p.extruder ?? 1))].sort((a, b) => a - b);
}
