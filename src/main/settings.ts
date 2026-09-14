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
import { getConfig } from "./config";
import { currentSessionId, sessionFile } from "./session-context";
import { KNOWN_PRINTERS } from "./profiles";
import type {
  PrintPreferences,
  PrinterPref,
  PrintGoal,
  PrintMaterial,
  FeatureMode,
  SupportStyle,
  ProviderId,
} from "../shared/types";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  id: string;
  /** Which provider answers for this model — i.e. which API key it needs. The
   *  catalog is the ONLY place that mapping is written down (see
   *  agent/provider.ts's `providerForModel`), so adding a model is a one-line
   *  data change and no request builder hardcodes a model name. */
  provider: ProviderId;
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
    provider: "anthropic",
    label: "Opus 4.8",
    blurb: "Most capable — best for nuanced search & reasoning",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Sonnet 5",
    blurb: "Balanced and cheap — the model free credit runs on",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Sonnet 4.6",
    blurb: "Balanced — fast and smart for everyday use",
    supportsEffort: true,
    supportsXHigh: false,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Haiku 4.5",
    blurb: "Fastest & cheapest — snappy, lighter reasoning",
    supportsEffort: false,
    supportsXHigh: false,
    supportsMax: false,
    supportsAdaptiveThinking: false,
  },
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // All three take the full effort range (none…max on the 5.6 family; astra
  // rejects only "none", which Slicely never sends). Adaptive thinking is an
  // Anthropic parameter and does not apply.
  //
  // Terra is the OpenAI default rather than the flagship: same 1.05M context and
  // 128K max output as astra, five times cheaper in and four times cheaper out.
  // In a tool loop, where the whole history is re-billed as input every turn,
  // that is the difference between a user's key lasting a month and a week.
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    blurb: "Balanced OpenAI pick — cheap enough for long tool loops",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: false,
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    blurb: "Cheapest OpenAI option — fast, lighter reasoning",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: false,
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    blurb: "OpenAI's most capable — for the hardest problems",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
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

/** Settings live in the AMBIENT SESSION's directory. Electron always runs in
 *  the default session, so it keeps using <workdir>/settings.json exactly as
 *  before; each web visitor gets their own file under <workdir>/sessions/<id>/. */
const SETTINGS_FILE = () => sessionFile("settings.json");

/** One cache entry per session, so visitors never read each other's settings. */
const cache = new Map<string, Settings>();

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
  const sid = currentSessionId();
  const hit = cache.get(sid);
  if (hit) return hit;
  const base = defaults();
  try {
    const raw = readFileSync(SETTINGS_FILE(), "utf8");
    const saved = JSON.parse(raw) as Partial<Settings>;
    const loaded: Settings = {
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
    cache.set(sid, loaded);
    return loaded;
  } catch {
    cache.set(sid, base);
    return base;
  }
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
  cache.set(currentSessionId(), next);
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

  const e = resolveEffort(model, effort);
  if (e) out.outputConfig = { effort: e };

  if (opt?.supportsAdaptiveThinking) {
    out.thinking = { type: "adaptive" };
  }

  return out;
}

/**
 * The effort tier the chosen model will actually accept, or undefined when it
 * takes none at all.
 *
 * Provider-neutral on purpose: both providers expose the same five tiers under
 * different field names, and both reject a tier the model does not have (effort
 * 400s on Haiku 4.5; `xhigh` is Opus 4.7+). Clamping in one place is what keeps
 * a model choice from turning into a mid-turn 400.
 */
export function resolveEffort(model: string, effort: EffortLevel): EffortLevel | undefined {
  const opt = modelOption(model);
  if (!opt?.supportsEffort) return undefined;
  let e = effort;
  if (e === "xhigh" && !opt.supportsXHigh) e = "high";
  if (e === "max" && !opt.supportsMax) e = "high";
  return e;
}

/** Drop a session's cached settings (called when a web session is evicted). */
export function disposeSessionSettings(id: string): void {
  cache.delete(id);
}
