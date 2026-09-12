// Encryption for secrets at rest — right now that's the user's own,
// bring-your-own Anthropic API key (Task B3 wires that up); this module only
// provides the primitive. AES-256-GCM: a fresh random IV per call so two
// encryptions of the same plaintext never look alike, and an auth tag that
// turns "wrong key" or "someone edited the ciphertext on disk" into a loud
// KeyVaultError instead of silently returning garbage bytes.
//
// The master key itself never touches the secrets it protects: in hosted
// mode it comes from `SLICELY_MASTER_KEY` (base64, set once via
// `scripts/gen-master-key.mjs` and handed to the deploy's secrets manager —
// never committed); in desktop mode there's no operator to set an env var,
// so it's a random key written once to `<workdir>/master.key` (0600) and
// reused after that.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, masterKeyEnv } from "./config";
import { isHosted } from "./mode";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BLOB_VERSION = "v1";

export class KeyVaultError extends Error {}

let cachedKey: Buffer | null = null;

/** The 32-byte AES key, loaded once per process and cached. Hosted mode
 *  requires a real `SLICELY_MASTER_KEY`; desktop mode reads-or-creates
 *  `<workdir>/master.key`. */
export function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  if (isHosted()) {
    const raw = masterKeyEnv();
    if (!raw) {
      throw new Error(
        "SLICELY_MASTER_KEY is required in hosted mode. Generate one with `node scripts/gen-master-key.mjs` and set it in the environment.",
      );
    }
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SLICELY_MASTER_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with \`node scripts/gen-master-key.mjs\`.`,
      );
    }
    cachedKey = key;
    return cachedKey;
  }

  const path = join(getConfig().workdir, "master.key");
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) {
      throw new Error(`${path.split("/").pop()} does not hold a 32-byte key — delete it to have a new one generated.`);
    }
    cachedKey = key;
    return cachedKey;
  }

  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

/** Encrypts `plain` under `key` (defaults to `loadMasterKey()`), returning
 *  `"v1:<iv b64>:<tag b64>:<ciphertext b64>"`. */
export function encryptSecret(plain: string, key: Buffer = loadMasterKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BLOB_VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Decrypts a blob produced by `encryptSecret`. Throws `KeyVaultError` — never
 *  returns silently-wrong bytes — for the wrong key, a tampered blob, or one
 *  that isn't shaped like a blob at all. */
export function decryptSecret(blob: string, key: Buffer = loadMasterKey()): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== BLOB_VERSION) {
    throw new KeyVaultError("Malformed secret blob.");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new KeyVaultError("Malformed secret blob.");
  }
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new KeyVaultError("Secret could not be decrypted — wrong master key or tampered data.");
  }
}

/** Tests only: forget the cached master key so env/file changes are re-read. */
export function resetKeyVaultForTests(): void {
  cachedKey = null;
}
