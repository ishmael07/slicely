// ─────────────────────────────────────────────────────────────────────────────
// The user's own AI API keys — bring-your-own, one per provider per session.
//
// WHY BYO: neither provider lets a third party route traffic through a personal
// subscription (Claude Pro/Max, ChatGPT Plus), and the owner is not paying for
// strangers' tokens. So every visitor supplies a personal API key, it bills
// their account, and Slicely holds it only for the life of their session.
//
// Subscription credentials are DELIBERATELY refused by the format check:
// `sk-ant-oat…` (what `claude setup-token` prints) is a Claude.ai credential,
// and a ChatGPT OAuth token is a Codex credential. Each provider's `keyPattern`
// (main/agent/provider-*.ts) is the enforcement, not an accident of
// pattern-writing.
//
// AT REST: each key is encrypted with keyvault.ts (AES-256-GCM under
// `SLICELY_MASTER_KEY`) and written to `<session>/secrets.json` at 0600. The
// plaintext exists only in this process's memory, in the per-session cache
// below. It is never logged, never returned to a client, and never put in an
// error message — the client only ever learns `{ hasKey, keyHint }`.
//
// PER SESSION AND PER PROVIDER, NOT PER PROCESS: the cache is keyed by
// `currentSessionId()` (the same pattern as settings.ts) plus the provider, so
// one visitor can never read another's key, connecting an OpenAI key cannot
// disturb an Anthropic one, and dropping a session drops both from memory
// (`disposeSessionUserKey`).
// ─────────────────────────────────────────────────────────────────────────────
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { currentSessionId, sessionFile } from "./session-context";
import { decryptSecret, encryptSecret } from "./keyvault";
import { isDesktop } from "./mode";
import { getProvider, PROVIDERS } from "./agent/provider";
import type { ProviderId } from "../shared/types";

/** No key is connected for this session. Carries a stable `code` so the HTTP
 *  layer can answer 409 `no_key` and the UI can show the "connect your key"
 *  card instead of a generic failure. */
export class NoApiKeyError extends Error {
  readonly code = "no_key" as const;
}

/** The supplied string isn't shaped like that provider's API key. Thrown before
 *  anything is encrypted or written, so a bad paste leaves no trace. */
export class KeyFormatError extends Error {
  readonly code = "key_invalid_format" as const;
}

/**
 * Shape of `<session>/secrets.json`.
 *
 * One pair of fields per provider — `anthropicKey` / `anthropicKeyCleared`,
 * `openaiKey` / `openaiKeyCleared` — so a file written before OpenAI existed
 * still reads correctly and a user with two keys keeps both. Every `*Key` is a
 * keyvault blob, never a plaintext key. Versioned so a future format change can
 * migrate.
 */
interface SecretsFile {
  version: number;
  [other: string]: unknown;
}

/** The two field names one provider owns in secrets.json. */
function fields(provider: ProviderId): { key: string; cleared: string } {
  return { key: `${provider}Key`, cleared: `${provider}KeyCleared` };
}

/** The operator's own environment variable for a provider — the standard name
 *  each provider's SDK reads. Only consulted behind `operatorKeyAllowed()`. */
const OPERATOR_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const SECRETS_FILE = () => sessionFile("secrets.json");

/**
 * What this session's stored state says, which is NOT simply "a key or not".
 *
 * `cleared` is a tombstone: the user pressed Disconnect. It has to be recorded,
 * because there is a fallback to the OPERATOR'S key when none is stored (see
 * `operatorKey`) — so without a tombstone, DELETE /api/key would answer
 * `{hasKey: false}`, the very next /api/config would answer `{hasKey: true}`
 * again, and chat would keep spending the operator's key after the user asked
 * it to stop. Per provider, because disconnecting one must not disconnect the
 * other.
 */
interface KeyState {
  key?: string;
  cleared?: boolean;
}

/** One entry per session PER PROVIDER, keyed `<sid>:<provider>`. Presence of the
 *  entry (not its contents) is what makes this a cache — an absent entry means
 *  "disk not read yet". */
const cache = new Map<string, KeyState>();

function cacheKey(sid: string, provider: ProviderId): string {
  return `${sid}:${provider}`;
}

function readSecrets(): SecretsFile {
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // The file's OWN version wins (hence the spread last). Stamping 1 over it
      // would silently downgrade a file written by a newer Slicely on the first
      // key change — and a future migration keyed on that number would then skip
      // the very file that needed migrating.
      return { version: 1, ...(parsed as Record<string, unknown>) } as SecretsFile;
    }
  } catch {
    /* no file yet, or unreadable/corrupt — treated as "no secrets" */
  }
  return { version: 1 };
}

/**
 * Replace `secrets.json` atomically: write a sibling temp file, then rename.
 *
 * A plain `writeFileSync` truncates first, so a crash (or a full disk) between
 * truncate and write leaves a zero-length or half-written file — and the user's
 * key silently gone. `rename` within a directory is atomic, so a reader sees
 * either the old file or the new one. Same pattern as printers/registry.ts.
 *
 * 0600 throughout: on a hosted box the workspace is shared with nothing, but
 * the ciphertext still shouldn't be world-readable — defence in depth behind
 * the encryption itself.
 */
function writeSecrets(next: SecretsFile): void {
  const path = SECRETS_FILE();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    // writeFileSync's `mode` only applies when it CREATES the file; a leftover
    // temp from a previous run would keep its old permissions.
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a stray `.secrets.json.*.tmp` behind in the user's workspace.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** This session's stored state for one provider, read from disk. */
function readState(provider: ProviderId): KeyState {
  const secrets = readSecrets();
  const f = fields(provider);
  const blob = secrets[f.key];
  if (typeof blob === "string" && blob.length > 0) {
    try {
      return { key: decryptSecret(blob) };
    } catch {
      // Wrong master key or a tampered file. Treated as "no key stored" rather
      // than an error: the user can simply paste theirs again.
      return {};
    }
  }
  return secrets[f.cleared] === true ? { cleared: true } : {};
}

/**
 * This session's key for `provider`, or `undefined` when none is connected.
 *
 * Reads (and decrypts) disk at most once per session per provider, then serves
 * from memory. A decryption failure — wrong master key, tampered file — is
 * treated as "no key" rather than an exception: the user can simply paste theirs
 * again, which is a better outcome than every request in the session throwing.
 *
 * Falls back to the OPERATOR'S OWN key for that provider (`ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY`) when none is stored — but only in DESKTOP MODE, where the
 * operator and the user are the same human on their own machine.
 *
 * A HOSTED SERVER NEVER FALLS BACK HERE. A deployment that merely happens to
 * have one of those variables in its environment — for a script, a sibling
 * service, a copied .env — must not start spending it on strangers. The owner's
 * key IS spendable in hosted mode, but only through a signed-in account with a
 * metered balance: see `agent/funding.ts`, which is where that decision lives
 * now. `SLICELY_ALLOW_OPERATOR_KEY`, which used to open this door for everyone
 * at once, is gone.
 */
export function getUserApiKey(provider: ProviderId = "anthropic"): string | undefined {
  return resolveKey(provider).key;
}

/** True when ANY provider has a usable key — what /api/config's `hasKey` means,
 *  since a user with only an OpenAI key is not a user without a key. */
export function hasAnyUserApiKey(): boolean {
  return PROVIDERS.some((p) => Boolean(getUserApiKey(p.id)));
}

/** Where the key in play came from — the distinction `userKeyHint` needs. */
type KeySource = "session" | "operator" | "none";

function resolveKey(provider: ProviderId): { key?: string; source: KeySource } {
  const sid = currentSessionId();
  const ck = cacheKey(sid, provider);
  let state = cache.get(ck);
  if (!state) {
    state = readState(provider);
    cache.set(ck, state);
  }
  if (state.key) return { key: state.key, source: "session" };
  // An explicit disconnect wins over the fallback — "no" has to mean no.
  if (state.cleared) return { source: "none" };

  const operator = operatorKey(provider);
  return operator ? { key: operator, source: "operator" } : { source: "none" };
}

/**
 * True when this deployment may spend the operator's own key here — which now
 * means DESKTOP, and nothing else.
 *
 * `SLICELY_ALLOW_OPERATOR_KEY` is retired. It was the one door through which a
 * stranger could spend the owner's key, with no per-user limit, no accounting
 * and no way to close it again short of a redeploy. The safe version of what it
 * did is the free tier: in hosted mode the owner's keys are reachable only
 * through a signed-in, metered account with a balance — see
 * `agent/funding.ts`, which is the only other place in `src/main` that reads
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
 *
 * Desktop needs no flag and never did: the operator and the user are the same
 * human, on their own machine, paying their own bill.
 */
function operatorKeyAllowed(): boolean {
  return isDesktop();
}

/** The operator's key for one provider, if configured AND allowed to be used.
 *  Not cached: it is an env var an operator flips between runs. */
function operatorKey(provider: ProviderId): string | undefined {
  if (!operatorKeyAllowed()) return undefined;
  return process.env[OPERATOR_ENV[provider]]?.trim() || undefined;
}

/**
 * Store `key` for this session and provider: validate the format, encrypt, write
 * 0600, update the cache. Throws `KeyFormatError` before touching disk when the
 * string isn't an API key for that provider.
 */
export function setUserApiKey(provider: ProviderId, key: string): void {
  const trimmed = key.trim();
  const spec = getProvider(provider);
  if (!spec.keyPattern.test(trimmed)) {
    throw new KeyFormatError(spec.keyHelp.formatMessage(trimmed));
  }
  const next = readSecrets();
  const f = fields(provider);
  // Encrypt BEFORE writing: if the vault can't produce a blob (no master key),
  // the existing file is left exactly as it was.
  next[f.key] = encryptSecret(trimmed);
  // Connecting a key lifts an earlier disconnect — for THIS provider only.
  delete next[f.cleared];
  writeSecrets(next);
  cache.set(cacheKey(currentSessionId(), provider), { key: trimmed });
}

/** Forget this session's key for one provider, on disk and in memory, and record
 *  that the user asked for that — so no fallback quietly reinstates one. The
 *  other provider's key is untouched. */
export function clearUserApiKey(provider: ProviderId = "anthropic"): void {
  const next = readSecrets();
  const f = fields(provider);
  delete next[f.key];
  next[f.cleared] = true;
  try {
    writeSecrets(next);
  } catch {
    /* the in-memory drop below still takes effect this run */
  }
  cache.set(cacheKey(currentSessionId(), provider), { cleared: true });
}

/**
 * The only thing a client is ever told about a key itself: its last four
 * characters, so a user can tell which key is connected.
 *
 * The operator's fallback key is NEVER described that way. Four characters of
 * it are four characters of a credential the visitor has no business seeing,
 * and "…a4f2" would also read as "the key I pasted" to someone who pasted
 * nothing. They are told whose key is paying instead.
 */
export function userKeyHint(provider: ProviderId = "anthropic"): string | undefined {
  const { key, source } = resolveKey(provider);
  if (!key) return undefined;
  if (source === "operator") return "this server's key";
  return "…" + key.slice(-4);
}

/** Drop a session's cached keys (called when a session is destroyed or swept,
 *  so a key never outlives the session that owns it). */
export function disposeSessionUserKey(id: string): void {
  for (const p of PROVIDERS) cache.delete(cacheKey(id, p.id));
}
