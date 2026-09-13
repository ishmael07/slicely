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
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Set once the user has explicitly disconnected their key. See `KeyState`. */
  anthropicKeyCleared?: boolean;
  [other: string]: unknown;
}

const SECRETS_FILE = () => sessionFile("secrets.json");

/**
 * What this session's stored state says, which is NOT simply "a key or not".
 *
 * `cleared` is a tombstone: the user pressed Disconnect. It has to be recorded,
 * because there is a fallback to the OPERATOR'S key when none is stored (see
 * `operatorKey`) — so without a tombstone, DELETE /api/key would answer
 * `{hasKey: false}`, the very next /api/config would answer `{hasKey: true}`
 * again, and chat would keep spending the operator's key after the user asked
 * it to stop.
 */
interface KeyState {
  key?: string;
  cleared?: boolean;
}

/** One entry per session. Presence of the entry (not its contents) is what
 *  makes this a cache — an absent entry means "disk not read yet". */
const cache = new Map<string, KeyState>();

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

/** This session's stored state, read from disk. */
function readState(): KeyState {
  const secrets = readSecrets();
  const blob = secrets.anthropicKey;
  if (typeof blob === "string" && blob.length > 0) {
    try {
      return { key: decryptSecret(blob) };
    } catch {
      // Wrong master key or a tampered file. Treated as "no key stored" rather
      // than an error: the user can simply paste theirs again.
      return {};
    }
  }
  return secrets.anthropicKeyCleared === true ? { cleared: true } : {};
}

/**
 * This session's Anthropic key, or `undefined` when none is connected.
 *
 * Reads (and decrypts) disk at most once per session, then serves from memory.
 * A decryption failure — wrong master key, tampered file — is treated as "no
 * key" rather than an exception: the user can simply paste theirs again, which
 * is a better outcome than every request in the session throwing.
 *
 * Falls back to the OPERATOR'S OWN `ANTHROPIC_API_KEY` when no key is stored —
 * but only where that cannot quietly bill one person for another's chat:
 *
 *   • desktop mode, where the operator and the user are the same human, and
 *   • a hosted server whose operator set `SLICELY_ALLOW_OPERATOR_KEY=1`, an
 *     explicit, documented decision to pay for every visitor's chat.
 *
 * Anywhere else, no stored key means no key. A hosted deployment that merely
 * happens to have `ANTHROPIC_API_KEY` in its environment — for a script, a
 * sibling service, a copied .env — must not start spending it on strangers.
 * That is what makes the standard variable name safe to read here: the name is
 * not the permission, the flag is.
 */
export function getUserApiKey(): string | undefined {
  return resolveKey().key;
}

/** Where the key in play came from — the distinction `userKeyHint` needs. */
type KeySource = "session" | "operator" | "none";

function resolveKey(): { key?: string; source: KeySource } {
  const sid = currentSessionId();
  let state = cache.get(sid);
  if (!state) {
    state = readState();
    cache.set(sid, state);
  }
  if (state.key) return { key: state.key, source: "session" };
  // An explicit disconnect wins over the fallback — "no" has to mean no.
  if (state.cleared) return { source: "none" };

  const operator = operatorKey();
  return operator ? { key: operator, source: "operator" } : { source: "none" };
}

/** True when this deployment has opted into spending the operator's own key. */
function operatorKeyAllowed(): boolean {
  if (isDesktop()) return true;
  return process.env.SLICELY_ALLOW_OPERATOR_KEY?.trim() === "1";
}

/** The operator's key, if one is configured AND allowed to be used. Not cached:
 *  it is an env var an operator flips between runs. */
function operatorKey(): string | undefined {
  if (!operatorKeyAllowed()) return undefined;
  return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
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
  // Connecting a key lifts an earlier disconnect.
  delete next.anthropicKeyCleared;
  writeSecrets(next);
  cache.set(currentSessionId(), { key: trimmed });
}

/** Forget this session's key, on disk and in memory, and record that the user
 *  asked for that — so no fallback quietly reinstates one. */
export function clearUserApiKey(): void {
  const next = readSecrets();
  delete next.anthropicKey;
  next.anthropicKeyCleared = true;
  try {
    writeSecrets(next);
  } catch {
    /* the in-memory drop below still takes effect this run */
  }
  cache.set(currentSessionId(), { cleared: true });
}

/**
 * The only thing a client is ever told about the key itself: its last four
 * characters, so a user can tell which key is connected.
 *
 * The operator's fallback key is NEVER described that way. Four characters of
 * it are four characters of a credential the visitor has no business seeing,
 * and "…a4f2" would also read as "the key I pasted" to someone who pasted
 * nothing. They are told whose key is paying instead.
 */
export function userKeyHint(): string | undefined {
  const { key, source } = resolveKey();
  if (!key) return undefined;
  if (source === "operator") return "this server's key";
  return "…" + key.slice(-4);
}

/** Drop a session's cached key (called when a session is destroyed or swept,
 *  so a key never outlives the session that owns it). */
export function disposeSessionUserKey(id: string): void {
  cache.delete(id);
}
