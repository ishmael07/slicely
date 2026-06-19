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
  return { model, effort };
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

  cached = next;
  try {
    writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* non-fatal — settings just won't persist this session */
  }
  return next;
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
