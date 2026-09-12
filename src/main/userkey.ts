// ─────────────────────────────────────────────────────────────────────────────
// The user's own Anthropic API key — bring-your-own, one per session.
//
// WHY BYO: Anthropic's terms prohibit routing third-party traffic through a
// Pro/Max subscription, and the owner is not paying for strangers' tokens. So
// every visitor supplies a personal API key (`sk-ant-api…`), it bills their
// account, and Slicely holds it only for the life of their session.
//
// Subscription tokens (`sk-ant-oat…`, what `claude setup-token` prints) are
// DELIBERATELY refused by the format check: they are Claude.ai credentials, not
// API keys, and using them here would breach those terms. The regex demanding
// `sk-ant-api` is the enforcement, not an accident of pattern-writing.
//
// AT REST: the key is encrypted with keyvault.ts (AES-256-GCM under
// `SLICELY_MASTER_KEY`) and written to `<session>/secrets.json` at 0600. The
// plaintext exists only in this process's memory, in the per-session cache
// below. It is never logged, never returned to a client, and never put in an
// error message — the client only ever learns `{ hasKey, keyHint }`.
//
// PER SESSION, NOT PER PROCESS: the cache is keyed by `currentSessionId()`
// (the same pattern as settings.ts), so one visitor can never read another's
// key, and dropping a session drops its key from memory
// (`disposeSessionUserKey`).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { currentSessionId, sessionFile } from "./session-context";
import { decryptSecret, encryptSecret } from "./keyvault";
import { isDesktop } from "./mode";

/**
 * A personal Anthropic API key: `sk-ant-api` + a two-digit version + the
 * secret body. Nothing else is accepted — notably not `sk-ant-oat…`
 * subscription tokens (see the header comment).
 */
export const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;

/** No key is connected for this session. Carries a stable `code` so the HTTP
 *  layer can answer 409 `no_key` and the UI can show the "connect your key"
 *  card instead of a generic failure. */
export class NoApiKeyError extends Error {
  readonly code = "no_key" as const;
}

/** The supplied string isn't shaped like an Anthropic API key. Thrown before
 *  anything is encrypted or written, so a bad paste leaves no trace. */
export class KeyFormatError extends Error {
  readonly code = "key_invalid_format" as const;
}

/** Shape of `<session>/secrets.json`. `anthropicKey` is a keyvault blob, never
 *  a plaintext key. Versioned so a future format change can migrate. */
interface SecretsFile {
  version: 1;
  anthropicKey?: string;
  [other: string]: unknown;
}

const SECRETS_FILE = () => sessionFile("secrets.json");

/** One entry per session: the decrypted key, or `undefined` meaning "disk has
 *  been read and there is no key". Presence of the entry (not its value) is
 *  what makes this a cache — `has()`, not a truthiness check. */
const cache = new Map<string, string | undefined>();

function readSecrets(): SecretsFile {
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>), version: 1 };
    }
  } catch {
    /* no file yet, or unreadable/corrupt — treated as "no secrets" */
  }
  return { version: 1 };
}

function writeSecrets(next: SecretsFile): void {
  // 0600: on a hosted box the workspace directory is shared with nothing, but
  // the ciphertext still shouldn't be world-readable — defence in depth behind
  // the encryption itself.
  writeFileSync(SECRETS_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

/**
 * This session's Anthropic key, or `undefined` when none is connected.
 *
 * Reads (and decrypts) disk at most once per session, then serves from memory.
 * A decryption failure — wrong master key, tampered file — is treated as "no
 * key" rather than an exception: the user can simply paste theirs again, which
 * is a better outcome than every request in the session throwing.
 *
 * Desktop dev convenience: `SLICELY_DEV_ANTHROPIC_KEY` stands in when no key
 * has been stored. Only in desktop mode — a hosted server must never fall back
 * to an operator-supplied key, because that would bill the owner for a
 * visitor's chat.
 */
export function getUserApiKey(): string | undefined {
  const sid = currentSessionId();
  if (!cache.has(sid)) {
    const blob = readSecrets().anthropicKey;
    let key: string | undefined;
    if (typeof blob === "string" && blob.length > 0) {
      try {
        key = decryptSecret(blob);
      } catch {
        key = undefined;
      }
    }
    cache.set(sid, key);
  }
  const stored = cache.get(sid);
  if (stored) return stored;

  if (isDesktop()) {
    const dev = process.env.SLICELY_DEV_ANTHROPIC_KEY?.trim();
    // Not cached: it's an env var a developer flips between runs, and caching
    // it would also let it outlive a `clearUserApiKey()`.
    if (dev) return dev;
  }
  return undefined;
}

/**
 * Store `key` for this session: validate the format, encrypt, write 0600,
 * update the cache. Throws `KeyFormatError` before touching disk when the
 * string isn't an API key.
 */
export function setUserApiKey(key: string): void {
  const trimmed = key.trim();
  if (!ANTHROPIC_KEY_RE.test(trimmed)) {
    throw new KeyFormatError(
      "That doesn't look like an Anthropic API key. Create one at console.anthropic.com — it starts with \"sk-ant-api\". Claude Pro/Max subscription tokens can't be used here.",
    );
  }
  const next = readSecrets();
  // Encrypt BEFORE writing: if the vault can't produce a blob (no master key),
  // the existing file is left exactly as it was.
  next.anthropicKey = encryptSecret(trimmed);
  writeSecrets(next);
  cache.set(currentSessionId(), trimmed);
}

/** Forget this session's key, on disk and in memory. */
export function clearUserApiKey(): void {
  const next = readSecrets();
  delete next.anthropicKey;
  try {
    writeSecrets(next);
  } catch {
    /* the in-memory drop below still takes effect this run */
  }
  cache.set(currentSessionId(), undefined);
}

/** The only thing a client is ever told about the key itself: its last four
 *  characters, so a user can tell which key is connected. */
export function userKeyHint(): string | undefined {
  const key = getUserApiKey();
  return key ? "…" + key.slice(-4) : undefined;
}

/** Drop a session's cached key (called when a session is destroyed or swept,
 *  so a key never outlives the session that owns it). */
export function disposeSessionUserKey(id: string): void {
  cache.delete(id);
}
