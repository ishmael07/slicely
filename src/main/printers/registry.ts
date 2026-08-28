// Persistence for printer connections. Two files, deliberately separate:
//
//   <workdir>/printers.json         — PrinterConnection records (no secrets),
//                                      plus the active-printer selection and
//                                      which printers have auto-start armed.
//   <workdir>/printer-secrets.json  — PrinterSecrets, keyed by printer id,
//                                      written with mode 0600 (owner-only).
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
import { getConfig } from "../config";
import type { PrinterConnection, PrinterSecrets, ResolvedPrinter } from "../../shared/printers";
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
   *  print. */
  autoStart: string[];
}

type SecretsStore = Record<string, PrinterSecrets>;

function emptyStore(): ConnectionsStore {
  return { version: 1, printers: [], autoStart: [] };
}

function printersFile(): string {
  return join(getConfig().workdir, "printers.json");
}
function secretsFile(): string {
  return join(getConfig().workdir, "printer-secrets.json");
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

// Module-level cache, same pattern as settings.ts: this is a single-process
// app (Electron main, or the headless web server) so there's no other writer
// to race against, and re-reading on every call would be wasteful.
let storeCache: ConnectionsStore | null = null;
let secretsCache: SecretsStore | null = null;

function loadStore(): ConnectionsStore {
  if (!storeCache) storeCache = readJsonSafe(printersFile(), emptyStore());
  return storeCache;
}
function saveStore(store: ConnectionsStore): void {
  storeCache = store;
  atomicWriteJson(printersFile(), store);
}
function loadSecrets(): SecretsStore {
  if (!secretsCache) secretsCache = readJsonSafe(secretsFile(), {} as SecretsStore);
  return secretsCache;
}
function saveSecrets(secrets: SecretsStore): void {
  secretsCache = secrets;
  atomicWriteJson(secretsFile(), secrets, 0o600);
}

/** Split a combined connection+secrets object into its two halves, by key —
 *  PrinterConnection and PrinterSecrets share no field names, so this is an
 *  exact partition, not a heuristic. */
function splitInput<T extends Record<string, unknown>>(
  input: T,
): { connectionPatch: Partial<PrinterConnection>; secretsPatch: Partial<PrinterSecrets> } {
  const connectionPatch: Record<string, unknown> = {};
  const secretsPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) secretsPatch[k] = v;
    else connectionPatch[k] = v;
  }
  return {
    connectionPatch: connectionPatch as Partial<PrinterConnection>,
    secretsPatch: secretsPatch as Partial<PrinterSecrets>,
  };
}

/** All configured printers, secrets stripped (the type guarantees it — a
 *  PrinterConnection has no field a secret could hide in). */
export function listConnections(): PrinterConnection[] {
  return [...loadStore().printers];
}

export function getConnection(id: string): PrinterConnection | undefined {
  return loadStore().printers.find((p) => p.id === id);
}

export function addConnection(input: Omit<PrinterConnection, "id"> & PrinterSecrets): PrinterConnection {
  const { connectionPatch, secretsPatch } = splitInput(input as unknown as Record<string, unknown>);
  const id = newId();
  const connection: PrinterConnection = { id, enabled: true, ...connectionPatch } as PrinterConnection;

  const store = loadStore();
  store.printers.push(connection);
  saveStore(store);

  if (Object.keys(secretsPatch).length > 0) {
    const secrets = loadSecrets();
    secrets[id] = secretsPatch;
    saveSecrets(secrets);
  }

  return connection;
}

export function updateConnection(id: string, patch: Partial<PrinterConnection & PrinterSecrets>): PrinterConnection {
  const store = loadStore();
  const idx = store.printers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Unknown printer: ${id}`);

  const { connectionPatch, secretsPatch } = splitInput(patch as Record<string, unknown>);
  const updated: PrinterConnection = { ...store.printers[idx], ...connectionPatch, id };
  store.printers[idx] = updated;
  saveStore(store);

  if (Object.keys(secretsPatch).length > 0) {
    const secrets = loadSecrets();
    secrets[id] = { ...secrets[id], ...secretsPatch };
    saveSecrets(secrets);
  }

  return updated;
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
 *  an unknown id (callers resolve ids from listConnections/addConnection, so
 *  an unknown id here is a programmer error, not a runtime condition to
 *  degrade gracefully from). */
export function resolve(id: string): ResolvedPrinter {
  const connection = getConnection(id);
  if (!connection) throw new Error(`Unknown printer: ${id}`);
  const secrets = loadSecrets()[id] ?? {};
  return { ...connection, ...secrets };
}

export function getActiveId(): string | undefined {
  return loadStore().activeId;
}

export function setActiveId(id: string | undefined): void {
  if (id !== undefined && !getConnection(id)) throw new Error(`Unknown printer: ${id}`);
  const store = loadStore();
  store.activeId = id;
  saveStore(store);
}

export function isAutoStartArmed(id: string): boolean {
  return loadStore().autoStart.includes(id);
}

export function setAutoStart(id: string, armed: boolean): void {
  if (!getConnection(id)) throw new Error(`Unknown printer: ${id}`);
  const store = loadStore();
  const has = store.autoStart.includes(id);
  if (armed && !has) store.autoStart = [...store.autoStart, id];
  else if (!armed && has) store.autoStart = store.autoStart.filter((x) => x !== id);
  else return; // no-op, don't write
  saveStore(store);
}
