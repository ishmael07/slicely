// Loads runtime configuration from environment / .env. Centralizes every tunable
// so the rest of the app reads typed values instead of poking at process.env.
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";

loadDotenv();

const DEFAULT_PRUSA_MAC =
  "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer";

function envStr(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/**
 * Owner-supplied, environment-only configuration.
 *
 * Deliberately ABSENT: any Anthropic credential. `ANTHROPIC_API_KEY` is no
 * longer read anywhere in Slicely — AI access is bring-your-own, per session
 * (see userkey.ts), so chat bills the user who pasted the key rather than
 * whoever deployed the server. The only Anthropic-shaped env var left is
 * `SLICELY_DEV_ANTHROPIC_KEY`, a desktop-mode developer convenience read by
 * userkey.ts.
 */
export interface SlicelyConfig {
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

  const workdirRaw = envStr("SLICELY_WORKDIR", join(homedir(), "Slicely-data"));
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

/** Tests only: forget the cached config so env changes are re-read. */
export function resetConfigForTests(): void {
  cached = null;
}

/** Raw `SLICELY_MASTER_KEY` (base64), read fresh on every call. Deliberately
 *  NOT part of the cached SlicelyConfig above: keyvault.ts caches the
 *  decoded key itself (see `resetKeyVaultForTests`), and its own tests flip
 *  this env var without going through `resetConfigForTests()`. */
export function masterKeyEnv(): string {
  return envStr("SLICELY_MASTER_KEY");
}
