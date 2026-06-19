// PrusaSlicer profile / printer awareness for macOS.
//
// Slicely must work for ANYONE — including someone who just installed
// PrusaSlicer and never ran the Configuration Wizard. This module detects what
// the user has set up and, when they have nothing, lets Slicely slice against a
// sensible synthesized printer config so results are realistic instead of
// silently wrong.
//
// Verified facts (PrusaSlicer source, 2026-06-19):
//   • Data dir (macOS): ~/Library/Application Support/PrusaSlicer
//   • App config:        <dataDir>/PrusaSlicer.ini  (missing ⇒ wizard never run)
//   • User presets are FLAT .ini files in <dataDir>/{printer,print,filament}/
//     (filename minus .ini = preset name). NOT under a presets/ subdir.
//   • PrusaSlicer.ini [presets] section records the last-selected preset names.
//   • A bare CLI slice with no --load succeeds against compiled defaults
//     (bed 200×200, nozzle 0.4); overrides (--nozzle-diameter, --bed-shape)
//     win over --load. So we synthesize the user's printer geometry as overrides.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "./config";

const DATA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "PrusaSlicer",
);
const APP_INI = join(DATA_DIR, "PrusaSlicer.ini");

export interface PrinterPreset {
  /** Printer key Slicely uses (display label). */
  label: string;
  /** Nozzle diameter in mm. */
  nozzleMm: number;
  /** Build volume in mm. */
  bed: { x: number; y: number; z: number };
}

/** A small built-in table of common printers so a first-timer can pick one
 *  without ever opening PrusaSlicer. Bed sizes are the published build volumes. */
export const KNOWN_PRINTERS: Record<string, PrinterPreset> = {
  "prusa-mk4": { label: "Prusa MK4 / MK3S", nozzleMm: 0.4, bed: { x: 250, y: 210, z: 220 } },
  "prusa-mini": { label: "Prusa MINI", nozzleMm: 0.4, bed: { x: 180, y: 180, z: 180 } },
  "ender-3": { label: "Creality Ender 3 / V2 / Pro", nozzleMm: 0.4, bed: { x: 220, y: 220, z: 250 } },
  "ender-3-s1": { label: "Creality Ender 3 S1", nozzleMm: 0.4, bed: { x: 220, y: 220, z: 270 } },
  "bambu-a1": { label: "Bambu A1 / P1 / X1", nozzleMm: 0.4, bed: { x: 256, y: 256, z: 256 } },
  generic: { label: "Generic 0.4 mm (220×220×250)", nozzleMm: 0.4, bed: { x: 220, y: 220, z: 250 } },
};

export interface ProfileState {
  /** Does PrusaSlicer's config dir + PrusaSlicer.ini exist? */
  configured: boolean;
  /** Installed user printer preset names (filenames minus .ini). */
  printerPresets: string[];
  /** Last-selected printer preset name from PrusaSlicer.ini, if any. */
  selectedPrinter?: string;
  /** Whether the user has a usable printer profile at all. */
  hasUsablePrinter: boolean;
  /** Path to a user-supplied exported config.ini (from .env), if set & exists. */
  userConfigIni?: string;
}

/** Inspect the macOS PrusaSlicer install for usable printer configuration. */
export function getProfileState(): ProfileState {
  const cfg = getConfig();
  const userConfigIni =
    cfg.prusaConfigIni && existsSync(cfg.prusaConfigIni)
      ? cfg.prusaConfigIni
      : undefined;

  const configured = existsSync(APP_INI);
  const printerPresets = listPresets("printer");
  const selectedPrinter = configured ? readSelectedPrinter() : undefined;

  // A usable printer = an explicit user config.ini, OR a real installed preset
  // (selected one present on disk, or any printer preset at all).
  const hasUsablePrinter =
    !!userConfigIni ||
    (!!selectedPrinter && printerPresets.includes(selectedPrinter)) ||
    printerPresets.length > 0;

  return {
    configured,
    printerPresets,
    selectedPrinter,
    hasUsablePrinter,
    userConfigIni,
  };
}

function listPresets(kind: "printer" | "print" | "filament"): string[] {
  const dir = join(DATA_DIR, kind);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".ini"))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

/** Read the last-selected printer preset name from PrusaSlicer.ini [presets]. */
function readSelectedPrinter(): string | undefined {
  try {
    const text = readFileSync(APP_INI, "utf8");
    let inPresets = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inPresets = line === "[presets]";
        continue;
      }
      if (inPresets) {
        const m = line.match(/^printer\s*=\s*(.+?)\s*$/);
        if (m) return m[1].replace(/\.ini$/i, "");
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Per-material filament properties that drive accurate weight/cost estimates.
 *  density g/cm³ converts the sliced volume → grams; cost is $/kg. Values are
 *  typical defaults for common filaments; a user's real exported config is more
 *  accurate and always wins (see resolveSliceConfig). */
const MATERIAL_FILAMENT: Record<
  string,
  { densityGCm3: number; costPerKg: number }
> = {
  PLA: { densityGCm3: 1.24, costPerKg: 20 },
  PETG: { densityGCm3: 1.27, costPerKg: 23 },
  ABS: { densityGCm3: 1.04, costPerKg: 20 },
};

/**
 * Synthesize a flat config.ini for a known printer + material and write it into
 * the workspace, returning its path. This is what makes a first-time user's
 * slice realistic: it pins bed size + nozzle (geometry) AND filament density +
 * cost (so grams and cost are believable, not generic defaults). Print specifics
 * still come from CLI overrides (the recommendation engine).
 */
export function synthesizeConfigForPrinter(
  printerKey: string,
  material = "PLA",
): {
  path: string;
  printer: PrinterPreset;
} {
  const printer = KNOWN_PRINTERS[printerKey] ?? KNOWN_PRINTERS.generic;
  const fil = MATERIAL_FILAMENT[material] ?? MATERIAL_FILAMENT.PLA;
  const cfg = getConfig();
  const dir = join(cfg.workdir, "configs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${printerKey}-${material}.ini`);

  // bed_shape is a comma-separated list of "XxY" rectangle vertices.
  const { x, y, z } = printer.bed;
  const bedShape = `0x0,${x}x0,${x}x${y},0x${y}`;

  // Printer geometry + filament density/cost so weight/cost estimates are
  // realistic. binary_gcode = 0 guarantees PLAINTEXT g-code comments so
  // parseMetrics can always read print time / filament / cost.
  const ini =
    `# Synthesized by Slicely for ${printer.label} (${material})\n` +
    `bed_shape = ${bedShape}\n` +
    `max_print_height = ${z}\n` +
    `nozzle_diameter = ${printer.nozzleMm}\n` +
    `printer_technology = FFF\n` +
    `binary_gcode = 0\n` +
    `filament_diameter = 1.75\n` +
    `filament_density = ${fil.densityGCm3}\n` +
    `filament_cost = ${fil.costPerKg}\n`;

  writeFileSync(path, ini, "utf8");
  return { path, printer };
}

/** Resolve the best config + printer geometry to slice with, given the user's
 *  optional printer choice + material. Order of preference:
 *    1. user's own exported config.ini (highest fidelity)
 *    2. a synthesized config for a chosen/known printer + material
 *    3. nothing (bare slice against PrusaSlicer defaults) */
export function resolveSliceConfig(
  printerKey?: string,
  material = "PLA",
): {
  configIni?: string;
  printer?: PrinterPreset;
  source: "user-config" | "synthesized" | "defaults";
} {
  const state = getProfileState();
  if (state.userConfigIni) {
    return { configIni: state.userConfigIni, source: "user-config" };
  }
  if (printerKey && KNOWN_PRINTERS[printerKey]) {
    const { path, printer } = synthesizeConfigForPrinter(printerKey, material);
    return { configIni: path, printer, source: "synthesized" };
  }
  return { source: "defaults" };
}
