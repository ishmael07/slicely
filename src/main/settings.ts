// User-selectable runtime settings (model + reasoning effort), persisted to
// disk so they survive restarts. The .env values seed the defaults; the UI can
// override them live without editing files.
//
// Critically, this module also owns the MODEL CAPABILITY CATALOG — which model
// supports the `effort` parameter, the `xhigh`/`max` effort tiers, and adaptive
// thinking. The agent uses it to build a request the chosen model will ACCEPT,
// instead of blindly sending params that 400 on some models (e.g. `effort` is
// rejected on Haiku 4.5; `xhigh` is Opus 4.7+ only).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config";
import { KNOWN_PRINTERS } from "./profiles";
import type {
  PrintPreferences,
  PrinterPref,
  PrintGoal,
  PrintMaterial,
  FeatureMode,
  SupportStyle,
} from "../shared/types";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  id: string;
  label: string;
  /** One-line UI description. */
  blurb: string;
  /** Does this model accept output_config.effort at all? */
  supportsEffort: boolean;
  /** Does it support the "xhigh" tier (Opus 4.7+)? */
  supportsXHigh: boolean;
  /** Does it support the "max" tier (Opus 4.5+ / Sonnet 4.6 — not Haiku)? */
  supportsMax: boolean;
  /** Does it support adaptive thinking (4.6+ family)? */
  supportsAdaptiveThinking: boolean;
}

/**
 * The models Slicely offers in its picker. Capability flags are from the
 * Anthropic model catalog (effort errors on Haiku; xhigh is Opus 4.7+; max is
 * Opus 4.5+/Sonnet 4.6; adaptive thinking is the 4.6+ family).
 */
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    blurb: "Most capable — best for nuanced search & reasoning",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    blurb: "Balanced — fast and smart for everyday use",
    supportsEffort: true,
    supportsXHigh: false,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    blurb: "Fastest & cheapest — snappy, lighter reasoning",
    supportsEffort: false,
    supportsXHigh: false,
    supportsMax: false,
    supportsAdaptiveThinking: false,
  },
];

export const EFFORT_LEVELS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface Settings {
  model: string;
  effort: EffortLevel;
  /** The user's persistent printing preferences (printer + slice defaults).
   *  Empty object = nothing saved yet. */
  preferences: PrintPreferences;
}

const SETTINGS_FILE = () => join(getConfig().workdir, "settings.json");

let cached: Settings | null = null;

function defaults(): Settings {
  const cfg = getConfig();
  const effort = (EFFORT_LEVELS as string[]).includes(cfg.effort)
    ? (cfg.effort as EffortLevel)
    : "high";
  const model = MODEL_CATALOG.some((m) => m.id === cfg.model)
    ? cfg.model
    : "claude-opus-4-8";
  return { model, effort, preferences: {} };
}

const GOALS = ["draft", "quality", "functional"];
const MATERIALS = ["PLA", "PETG", "ABS"];
const FEATURE_MODES = ["auto", "on", "off"];
const SUPPORT_STYLES = ["grid", "organic", "snug"];

/** Validate + normalize a stored/incoming preferences object, dropping anything
 *  malformed so a hand-edited or stale settings.json can't poison a slice. */
function sanitizePreferences(raw: unknown): PrintPreferences {
  const out: PrintPreferences = {};
  if (!raw || typeof raw !== "object") return out;
  const p = raw as Record<string, unknown>;

  // Printer: a known catalog key, or "custom" with explicit bed + nozzle.
  if (p.printer && typeof p.printer === "object") {
    const pr = p.printer as Record<string, unknown>;
    const key = typeof pr.key === "string" ? pr.key : "";
    if (key === "custom") {
      const bed = pr.bed as Record<string, unknown> | undefined;
      const nozzle = num(pr.nozzleMm);
      const printer: PrinterPref = { key: "custom" };
      if (typeof pr.label === "string") printer.label = pr.label;
      // Bed dims must be finite and POSITIVE — a 0/negative bed would poison the
      // synthesized config and the plate-fit math (everything reads "oversized").
      const bx = pos(bed?.x),
        by = pos(bed?.y),
        bz = pos(bed?.z);
      if (bx !== undefined && by !== undefined && bz !== undefined) {
        printer.bed = { x: bx, y: by, z: bz };
      }
      if (nozzle !== undefined && nozzle > 0) printer.nozzleMm = nozzle;
      // A custom printer is only useful with at least a bed; else drop it.
      if (printer.bed) out.printer = printer;
    } else if (KNOWN_PRINTERS[key]) {
      out.printer = { key, label: KNOWN_PRINTERS[key].label };
    }
  }

  if (typeof p.material === "string" && MATERIALS.includes(p.material)) {
    out.material = p.material as PrintMaterial;
  }
  if (typeof p.goal === "string" && GOALS.includes(p.goal)) {
    out.goal = p.goal as PrintGoal;
  }
  const fill = num(p.fillDensityPct);
  if (fill !== undefined) out.fillDensityPct = clampPct(fill);
  if (typeof p.fillPattern === "string" && p.fillPattern) {
    out.fillPattern = p.fillPattern;
  }
  if (typeof p.supports === "string" && FEATURE_MODES.includes(p.supports)) {
    out.supports = p.supports as FeatureMode;
  }
  if (
    typeof p.supportStyle === "string" &&
    SUPPORT_STYLES.includes(p.supportStyle)
  ) {
    out.supportStyle = p.supportStyle as SupportStyle;
  }
  if (typeof p.brim === "string" && FEATURE_MODES.includes(p.brim)) {
    out.brim = p.brim as FeatureMode;
  }
  const brimW = num(p.brimWidthMm);
  if (brimW !== undefined && brimW >= 0) out.brimWidthMm = brimW;

  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** A finite, strictly-positive number, or undefined. */
function pos(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}
function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Resolve the effective bed + nozzle for a saved printer preference. A custom
 *  printer uses its typed geometry; a known key uses the catalog. Returns
 *  undefined when no printer is saved. */
export function printerGeometry(
  pref: PrinterPref | undefined,
): { bed: { x: number; y: number; z: number }; nozzleMm: number } | undefined {
  if (!pref) return undefined;
  if (pref.key === "custom") {
    if (!pref.bed) return undefined;
    return { bed: pref.bed, nozzleMm: pref.nozzleMm ?? 0.4 };
  }
  const known = KNOWN_PRINTERS[pref.key];
  return known ? { bed: known.bed, nozzleMm: known.nozzleMm } : undefined;
}

export function getSettings(): Settings {
  if (cached) return cached;
  const base = defaults();
  try {
    const raw = readFileSync(SETTINGS_FILE(), "utf8");
    const saved = JSON.parse(raw) as Partial<Settings>;
    cached = {
      model:
        saved.model && MODEL_CATALOG.some((m) => m.id === saved.model)
          ? saved.model
          : base.model,
      effort:
        saved.effort && (EFFORT_LEVELS as string[]).includes(saved.effort)
          ? (saved.effort as EffortLevel)
          : base.effort,
      preferences: sanitizePreferences(saved.preferences),
    };
  } catch {
    cached = base;
  }
  return cached;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  const next: Settings = { ...cur };

  if (patch.model && MODEL_CATALOG.some((m) => m.id === patch.model)) {
    next.model = patch.model;
  }
  if (patch.effort && (EFFORT_LEVELS as string[]).includes(patch.effort)) {
    next.effort = patch.effort;
  }

  return persist(next);
}

/**
 * Merge a partial preferences patch into the saved preferences and persist.
 * Each field is validated; a field set to `null` is CLEARED (so the user can
 * un-set a saved default from the UI). Returns the full updated settings.
 */
export function updatePreferences(
  patch: Partial<Record<keyof PrintPreferences, unknown>>,
): Settings {
  const cur = getSettings();
  // Build a candidate object: start from current, apply nulls as deletions and
  // everything else through the sanitizer (which silently drops bad values).
  const merged: Record<string, unknown> = { ...cur.preferences };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const next: Settings = {
    ...cur,
    preferences: sanitizePreferences(merged),
  };
  return persist(next);
}

function persist(next: Settings): Settings {
  cached = next;
  try {
    writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* non-fatal — settings just won't persist this session */
  }
  return next;
}

/** The user's saved printing preferences (printer + slice defaults). */
export function getPreferences(): PrintPreferences {
  return getSettings().preferences;
}

export function modelOption(id: string): ModelOption | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Given a chosen model + desired effort, return the request fields that model
 * will actually accept:
 *   - effort is clamped to the model's supported tiers (xhigh→high, max→high
 *     where unsupported), and dropped entirely on models without effort support.
 *   - thinking uses adaptive on the 4.6+ family; omitted otherwise.
 */
export function buildModelRequestParams(
  model: string,
  effort: EffortLevel,
): {
  outputConfig?: { effort: EffortLevel };
  thinking?: { type: "adaptive" };
} {
  const opt = modelOption(model);
  const out: {
    outputConfig?: { effort: EffortLevel };
    thinking?: { type: "adaptive" };
  } = {};

  if (opt?.supportsEffort) {
    let e = effort;
    if (e === "xhigh" && !opt.supportsXHigh) e = "high";
    if (e === "max" && !opt.supportsMax) e = "high";
    out.outputConfig = { effort: e };
  }

  if (opt?.supportsAdaptiveThinking) {
    out.thinking = { type: "adaptive" };
  }

  return out;
}
