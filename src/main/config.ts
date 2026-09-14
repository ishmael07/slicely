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

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(envStr(name), 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Owner-supplied, environment-only configuration.
 *
 * Deliberately ABSENT: any Anthropic or OpenAI credential. AI access is
 * bring-your-own, per session (see userkey.ts), so chat bills the user who
 * pasted the key rather than whoever deployed the server. The owner's own
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are read in exactly two places —
 * userkey.ts's desktop-only fallback, and agent/funding.ts, where a signed-in
 * account with a metered balance is what makes them spendable — and neither
 * ever becomes part of this config. The numbers below BOUND that spending; they
 * are not the credential.
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
  /** How many PrusaSlicer processes may run at once (`SLICELY_MAX_SLICES`).
   *  Two is the shipped default: enough to keep a second visitor from waiting
   *  behind a long slice, few enough that a 2-core host still answers HTTP. */
  maxSlices: number;

  // ── The free tier's bounds (hosted mode only; see main/accounts/) ──────────
  // Every one of these is a CEILING on what a stranger can cost the owner. They
  // are whole cents / whole counts on purpose, so the .env reads like money and
  // the conversion to µ¢ happens exactly once, at the edge (`centsToMicros`).

  /** `SLICELY_FREE_CREDIT_CENTS` — the one-time grant per person, in cents. */
  freeCreditCents: number;
  /** `SLICELY_FREE_MODEL` — overrides the free-tier model choice. Empty means
   *  "pick from whichever owner key exists" (see agent/funding.ts). */
  freeModel: string;
  /** `SLICELY_FREE_MAX_OUTPUT_TOKENS` — per-call output ceiling on free credit,
   *  well under the provider's own, so one runaway answer cannot eat a grant. */
  freeMaxOutputTokens: number;
  /** `SLICELY_FREE_CHATS_PER_DAY` — turns one account may start per UTC day. */
  freeChatsPerDay: number;
  /** `SLICELY_SIGNUPS_PER_IP_PER_DAY` — new accounts one hashed address may
   *  create per UTC day, so a grant cannot be farmed from one machine. */
  signupsPerIpPerDay: number;
  /** `SLICELY_DAILY_SPEND_CAP_CENTS` — the global kill switch: free credit
   *  across ALL users stops for the day once this much has been spent. */
  dailySpendCapCents: number;
  /** `SLICELY_MAX_HISTORY_TURNS` — how many turns of conversation are resent as
   *  input. Applies to paid and free turns alike; it is a pure win. */
  maxHistoryTurns: number;
  /** `SLICELY_PUBLIC_URL` — this app's own origin, e.g.
   *  `https://app.slicely.example`. Required for OAuth: redirect URIs are built
   *  from it and never from a request's `Host` header. */
  publicUrl: string;
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
    maxSlices: envInt("SLICELY_MAX_SLICES", 2),
    freeCreditCents: envInt("SLICELY_FREE_CREDIT_CENTS", 50),
    freeModel: envStr("SLICELY_FREE_MODEL"),
    freeMaxOutputTokens: envInt("SLICELY_FREE_MAX_OUTPUT_TOKENS", 4000),
    freeChatsPerDay: envInt("SLICELY_FREE_CHATS_PER_DAY", 40),
    signupsPerIpPerDay: envInt("SLICELY_SIGNUPS_PER_IP_PER_DAY", 3),
    dailySpendCapCents: envInt("SLICELY_DAILY_SPEND_CAP_CENTS", 500),
    maxHistoryTurns: envInt("SLICELY_MAX_HISTORY_TURNS", 12),
    publicUrl: envStr("SLICELY_PUBLIC_URL"),
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
