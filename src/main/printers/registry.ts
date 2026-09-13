// Persistence for printer connections. Two files per SESSION, deliberately
// separate:
//
//   <session>/printers.json         — PrinterConnection records (no secrets),
//                                      plus the active-printer selection and
//                                      which printers have auto-start armed.
//   <session>/printer-secrets.json  — PrinterSecrets, one ENCRYPTED blob per
//                                      printer id (keyvault.ts, AES-256-GCM),
//                                      written with mode 0600 (owner-only).
//
// ── ONE REGISTRY PER VISITOR ────────────────────────────────────────────────
// This module used to hold a single module-level cache over
// `<workdir>/printers.json`, which is exactly right for a one-window Electron
// app and exactly wrong for a hosted server: every web visitor shared one
// printer list, so anyone could see, rename, delete or ARM (i.e. start prints
// on) anybody else's printer, and every visitor's credentials sat in one
// plaintext file. Both files are now resolved through `sessionFile()` and both
// caches are Maps keyed by `currentSessionId()` — the same pattern as
// settings.ts and userkey.ts.
//
// Electron and any code outside a request run in the DEFAULT session, whose
// directory *is* the workdir, so a desktop install keeps using exactly the
// paths it always did. No migration needed for the connection file; the
// secrets file is upgraded in place from v1 plaintext to v2 ciphertext the
// first time it is read (see `readSecretsFile`).
//
// Secrets never leave this module except through `resolve()`, which is what
// drivers call to get a ResolvedPrinter (connection + secrets merged). Every
// other export deals in PrinterConnection, which structurally cannot carry a
// secret (see shared/printers.ts) — so "secrets stripped from the public
// listing" isn't a filter Slicely has to remember to apply, it's the type.
//
// Writes are atomic (write to a temp file in the same directory, then
// rename) so a crash mid-write can't leave either file half-written. Reads
// tolerate a missing or corrupt file by starting from an empty store rather
// than throwing — losing a malformed printers.json should mean "reconfigure
// your printers", not "Slicely won't start".
import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { PrinterConnection, PrinterSecrets, ResolvedPrinter } from "../../shared/printers";
import { currentSessionId, sessionFile } from "../session-context";
import { decryptSecret, encryptSecret } from "../keyvault";
import { newId } from "./util";

const SECRET_KEYS: ReadonlyArray<keyof PrinterSecrets> = [
  "apiKey",
  "username",
  "password",
  "accessCode",
  "token",
];

interface ConnectionsStore {
  version: 1;
  printers: PrinterConnection[];
  activeId?: string;
  /** Ids of printers the user has explicitly armed for unattended
   *  auto-start. See the safety comment in index.ts — this list is the ONLY
   *  thing that can make sendToPrinter's startImmediately actually start a
   *  print, and the ONLY source for the `autoStart` flag on a listed
   *  connection. */
  autoStart: string[];
}

/** Decrypted, in-memory secrets: printer id -> credentials. */
type SecretsStore = Record<string, PrinterSecrets>;

/** On-disk shape of printer-secrets.json. Each value is a keyvault blob of the
 *  JSON of one printer's PrinterSecrets — never plaintext. v1 (no `version`
 *  field, plaintext values) is read once and rewritten as v2. */
interface SecretsFileV2 {
  version: 2;
  printers: Record<string, string>;
}

function emptyStore(): ConnectionsStore {
  return { version: 1, printers: [], autoStart: [] };
}

function printersFile(): string {
  return sessionFile("printers.json");
}
function secretsFile(): string {
  return sessionFile("printer-secrets.json");
}

function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    // Missing file, unreadable, or corrupt JSON — all treated the same: start
    // empty rather than crashing Slicely over a printers.json problem.
    return fallback;
  }
}

/** Write `data` atomically: temp file in the same directory, then rename
 *  (rename is atomic on the same filesystem, which a sibling temp file
 *  guarantees). `mode`, when given, is applied to the temp file before the
 *  rename so the final file never has a window at the wrong permissions. */
function atomicWriteJson(path: string, data: unknown, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* best-effort on platforms without POSIX permission bits */
    }
  }
  renameSync(tmp, path);
}

// One cache entry per session, so visitors never read each other's printers
// (and so a swept session's credentials don't linger in memory — see
// `disposeSessionPrinters`).
const storeCache = new Map<string, ConnectionsStore>();
const secretsCache = new Map<string, SecretsStore>();

/** Accept whatever was on disk as a usable store: a hand-edited (or older)
 *  printers.json may be missing `autoStart` entirely, and `.includes` on
 *  undefined would take the app down. */
function normalizeStore(raw: unknown): ConnectionsStore {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Partial<ConnectionsStore>;
  return {
    version: 1,
    printers: Array.isArray(obj.printers) ? obj.printers.filter((p) => p && typeof p.id === "string") : [],
    activeId: typeof obj.activeId === "string" ? obj.activeId : undefined,
    autoStart: Array.isArray(obj.autoStart) ? obj.autoStart.filter((x) => typeof x === "string") : [],
  };
}

function loadStore(): ConnectionsStore {
  const sid = currentSessionId();
  const hit = storeCache.get(sid);
  if (hit) return hit;
  const loaded = normalizeStore(readJsonSafe<unknown>(printersFile(), emptyStore()));
  storeCache.set(sid, loaded);
  return loaded;
}

function saveStore(store: ConnectionsStore): void {
  storeCache.set(currentSessionId(), store);
  atomicWriteJson(printersFile(), store);
}

/**
 * Parse printer-secrets.json into plaintext secrets, saying whether it was the
 * legacy v1 format (so the caller can rewrite it encrypted).
 *
 * A blob that won't decrypt — wrong master key, tampered file — is dropped
 * rather than thrown: "this printer's credentials are gone, re-enter them" is
 * a recoverable state, "every call in this session throws" is not. Same
 * judgement as userkey.ts makes for the API key.
 */
function readSecretsFile(): { secrets: SecretsStore; legacy: boolean } {
  const raw = readJsonSafe<unknown>(secretsFile(), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { secrets: {}, legacy: false };
  const obj = raw as Record<string, unknown>;

  if (obj.version === 2) {
    const out: SecretsStore = {};
    const blobs = obj.printers;
    if (blobs && typeof blobs === "object" && !Array.isArray(blobs)) {
      for (const [id, blob] of Object.entries(blobs as Record<string, unknown>)) {
        if (typeof blob !== "string" || blob.length === 0) continue;
        try {
          const parsed = JSON.parse(decryptSecret(blob)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            out[id] = parsed as PrinterSecrets;
          }
        } catch {
          /* undecryptable or unparseable — treat as "no credentials saved" */
        }
      }
    }
    return { secrets: out, legacy: false };
  }

  // v1: a bare map of printer id -> plaintext PrinterSecrets.
  const out: SecretsStore = {};
  for (const [id, value] of Object.entries(obj)) {
    if (id === "version") continue;
    if (value && typeof value === "object" && !Array.isArray(value)) out[id] = value as PrinterSecrets;
  }
  return { secrets: out, legacy: true };
}

function loadSecrets(): SecretsStore {
  const sid = currentSessionId();
  const hit = secretsCache.get(sid);
  if (hit) return hit;

  const { secrets, legacy } = readSecretsFile();
  secretsCache.set(sid, secrets);
  if (legacy && Object.keys(secrets).length > 0) {
    try {
      // Upgrade in place, once: the plaintext file never survives a read.
      saveSecrets(secrets);
    } catch {
      /* no master key available right now — serve from memory and retry on the
         next write rather than failing the read that triggered this */
    }
  }
  return secrets;
}

function saveSecrets(secrets: SecretsStore): void {
  // Encrypt EVERYTHING first: if the vault can't produce a blob (no master
  // key configured), the existing file and cache are left exactly as they were
  // instead of being replaced by a half-written one.
  const printers: Record<string, string> = {};
  try {
    for (const [id, value] of Object.entries(secrets)) {
      if (!value || Object.keys(value).length === 0) continue;
      printers[id] = encryptSecret(JSON.stringify(value));
    }
  } catch (err) {
    // Almost always "hosted mode with no SLICELY_MASTER_KEY". That is an
    // OPERATOR problem, and its message names env vars and scripts, so it goes
    // to the server log; the caller (and any browser behind it) gets a sentence
    // that says what happened without describing the deployment.
    console.error("[printers] could not encrypt printer credentials:", err);
    throw new Error("Couldn't store this printer's credentials securely — the server has no encryption key configured.");
  }
  const file: SecretsFileV2 = { version: 2, printers };
  secretsCache.set(currentSessionId(), secrets);
  atomicWriteJson(secretsFile(), file, 0o600);
}

/** Split a combined connection+secrets object into its two halves, by key —
 *  PrinterConnection and PrinterSecrets share no field names, so this is an
 *  exact partition, not a heuristic.
 *
 *  `autoStart` is dropped from the connection half on purpose: it is DERIVED
 *  from the store's arming list (see `publicConnection`), so letting a caller
 *  write it onto a record would let the listing claim a printer is armed when
 *  it isn't — the one flag the UI must never be wrong about. Arming goes
 *  through `setAutoStart` and nowhere else. */
function splitInput<T extends Record<string, unknown>>(
  input: T,
): { connectionPatch: Partial<PrinterConnection>; secretsPatch: Partial<PrinterSecrets> } {
  const connectionPatch: Record<string, unknown> = {};
  const secretsPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "autoStart") continue;
    if ((SECRET_KEYS as readonly string[]).includes(k)) secretsPatch[k] = v;
    else connectionPatch[k] = v;
  }
  return {
    connectionPatch: connectionPatch as Partial<PrinterConnection>,
    secretsPatch: secretsPatch as Partial<PrinterSecrets>,
  };
}

/** A stored record plus its derived `autoStart` flag — what every reader of
 *  this module sees. */
function publicConnection(store: ConnectionsStore, printer: PrinterConnection): PrinterConnection {
  return { ...printer, autoStart: store.autoStart.includes(printer.id) };
}

/** All configured printers for THIS session, secrets stripped (the type
 *  guarantees it — a PrinterConnection has no field a secret could hide in). */
export function listConnections(): PrinterConnection[] {
  const store = loadStore();
  return store.printers.map((p) => publicConnection(store, p));
}

export function getConnection(id: string): PrinterConnection | undefined {
  const store = loadStore();
  const found = store.printers.find((p) => p.id === id);
  return found ? publicConnection(store, found) : undefined;
}

export function addConnection(input: Omit<PrinterConnection, "id"> & PrinterSecrets): PrinterConnection {
  const { connectionPatch, secretsPatch } = splitInput(input as unknown as Record<string, unknown>);
  const id = newId();
  const connection: PrinterConnection = { id, enabled: true, ...connectionPatch } as PrinterConnection;

  // Secrets first: encryption is the step that can fail (a hosted deploy with
  // no SLICELY_MASTER_KEY), and failing it must not leave behind a connection
  // whose credentials were never stored.
  if (Object.keys(secretsPatch).length > 0) {
    const secrets = loadSecrets();
    secrets[id] = secretsPatch;
    saveSecrets(secrets);
  }

  const store = loadStore();
  store.printers.push(connection);
  saveStore(store);

  return publicConnection(store, connection);
}

export function updateConnection(id: string, patch: Partial<PrinterConnection & PrinterSecrets>): PrinterConnection {
  const store = loadStore();
  const idx = store.printers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Printer not found: ${id}`);

  const { connectionPatch, secretsPatch } = splitInput(patch as Record<string, unknown>);

  if (Object.keys(secretsPatch).length > 0) {
    const secrets = loadSecrets();
    secrets[id] = { ...secrets[id], ...secretsPatch };
    saveSecrets(secrets);
  }

  const updated: PrinterConnection = { ...store.printers[idx], ...connectionPatch, id };
  // Never persist the derived flag, even if an older file already carried it.
  delete updated.autoStart;
  store.printers[idx] = updated;
  saveStore(store);

  return publicConnection(store, updated);
}

export function removeConnection(id: string): void {
  const store = loadStore();
  store.printers = store.printers.filter((p) => p.id !== id);
  if (store.activeId === id) store.activeId = undefined;
  store.autoStart = store.autoStart.filter((x) => x !== id);
  saveStore(store);

  const secrets = loadSecrets();
  if (id in secrets) {
    delete secrets[id];
    saveSecrets(secrets);
  }
}

/** Connection + secrets merged — what a driver actually receives. Throws for
 *  an id this session doesn't own (callers resolve ids from
 *  listConnections/addConnection; the HTTP layer turns this into a 404). */
export function resolve(id: string): ResolvedPrinter {
  const connection = getConnection(id);
  if (!connection) throw new Error(`Printer not found: ${id}`);
  const secrets = loadSecrets()[id] ?? {};
  return { ...connection, ...secrets };
}

export function getActiveId(): string | undefined {
  return loadStore().activeId;
}

export function setActiveId(id: string | undefined): void {
  if (id !== undefined && !getConnection(id)) throw new Error(`Printer not found: ${id}`);
  const store = loadStore();
  store.activeId = id;
  saveStore(store);
}

export function isAutoStartArmed(id: string): boolean {
  return loadStore().autoStart.includes(id);
}

export function setAutoStart(id: string, armed: boolean): void {
  if (!getConnection(id)) throw new Error(`Printer not found: ${id}`);
  const store = loadStore();
  const has = store.autoStart.includes(id);
  if (armed && !has) store.autoStart = [...store.autoStart, id];
  else if (!armed && has) store.autoStart = store.autoStart.filter((x) => x !== id);
  else return; // no-op, don't write
  saveStore(store);
}

/**
 * Forget a session's cached registry — both the connection store and the
 * DECRYPTED secrets. Called when a web session is destroyed or swept
 * (server/session.ts): without it the caches grow without bound on a busy
 * server, and a visitor's printer credentials would sit in this process's
 * memory long after they pressed "Delete my data". The files on disk are the
 * session directory's business, not this module's.
 */
export function disposeSessionPrinters(id: string): void {
  storeCache.delete(id);
  secretsCache.delete(id);
}
