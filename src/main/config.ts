// Loads runtime configuration from environment / .env. Centralizes every tunable
// so the rest of the app reads typed values instead of poking at process.env.
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import type { ConfigState } from "../shared/types";

loadDotenv();

const DEFAULT_PRUSA_MAC =
  "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer";

function envStr(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

export interface SlicelyConfig {
  anthropicApiKey: string;
  thingiverseToken: string;
  model: string;
  effort: string;
  prusaSlicerPath: string;
  prusaConfigIni: string;
  workdir: string;
  downloadsDir: string;
  slicesDir: string;
}

let cached: SlicelyConfig | null = null;

export function getConfig(): SlicelyConfig {
  if (cached) return cached;

  const workdirRaw = envStr("SLICELY_WORKDIR", join(homedir(), "Slicely"));
  const workdir = isAbsolute(workdirRaw)
    ? workdirRaw
    : join(homedir(), workdirRaw);

  const downloadsDir = join(workdir, "downloads");
  const slicesDir = join(workdir, "slices");

  // Ensure the working directories exist up front; cheap and idempotent.
  for (const dir of [workdir, downloadsDir, slicesDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* surfaced later when we actually try to write */
    }
  }

  cached = {
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    thingiverseToken: envStr("THINGIVERSE_APP_TOKEN"),
    model: envStr("SLICELY_MODEL", "claude-opus-4-8"),
    effort: envStr("SLICELY_EFFORT", "high"),
    prusaSlicerPath: envStr("PRUSASLICER_PATH", DEFAULT_PRUSA_MAC),
    prusaConfigIni: envStr("PRUSASLICER_CONFIG_INI"),
    workdir,
    downloadsDir,
    slicesDir,
  };
  return cached;
}

export function configState(): ConfigState {
  const c = getConfig();
  return {
    hasAnthropicKey: c.anthropicApiKey.length > 0,
    hasThingiverseToken: c.thingiverseToken.length > 0,
    model: c.model,
    workdir: c.workdir,
  };
}
