// ─────────────────────────────────────────────────────────────────────────────
// Per-browser session identity for the zero-install web server.
//
// WHY THIS EXISTS: the Electron app is single-user/single-window, so
// main/config.ts happily keeps one global on-disk workdir and main/agent/
// state.ts keeps one global in-memory "current model/printer" singleton. A
// hosted server serves MANY browsers from ONE process, so every request must
// be tied to an isolated session: its own signed cookie, its own directory on
// disk (so uploads/downloads/slices never collide or leak between users), and
// its own SlicelyAgent conversation history.
//
// FILE ISOLATION: every upload, model download, and sliced G-code is moved
// (not merely named uniquely) into `<workdir>/sessions/<id>/{uploads,
// downloads, slices}` immediately after the underlying main/* module produces
// it — even when that module's own writes land in a shared global directory
// first (uploads.ts and prusaslicer.ts predate multi-tenancy and know nothing
// of sessions). See routes/upload.ts and routes/slice.ts for the relocation
// step. Nothing is ever served back to a browser by a client-supplied raw
// path — see `isInsideDir` and the gcode-token registry below.
//
// Per-visitor isolation of the AGENT's own state (the last imported model, the
// chosen printer, slice defaults) is handled one level down, by
// main/session-context.ts: `sessionMiddleware` runs each request inside that
// session's AsyncLocalStorage context, so main/agent/state.ts's `sessionState`
// and main/settings.ts both resolve to this visitor's own record. Concurrent
// chat turns from different browsers are therefore safe and genuinely parallel;
// only turns from the SAME session are serialized, via `SessionRecord.busy`.
//
// The session table itself lives in memory only. That is fine for a
// single-process deployment; a multi-instance deployment would need a shared
// store (Redis, a database, sticky sessions) — out of scope for P1.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AgentEvent } from "../shared/types";
import { getConfig } from "../main/config";
import { runInSession, sessionContext } from "../main/session-context";
import { disposeSessionState } from "../main/agent/state";
import { disposeSessionSettings } from "../main/settings";
import { disposeSessionUserKey } from "../main/userkey";
import { disposeSessionPrinters } from "../main/printers/registry";
import { clientIp, TokenBuckets } from "./security";

// Augment Express's Request with the session this middleware attaches. Scoped
// to this codebase only — harmless if another module never imports it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionRecord;
      /** True when `session` was created FOR THIS REQUEST because it arrived
       *  without a valid cookie — i.e. the client has not yet proved it holds
       *  a session this server issued. security.ts's rate-limit key treats
       *  those as anonymous and charges them to the caller's IP, so dropping
       *  the cookie can't buy a fresh budget. */
      sessionMinted?: boolean;
    }
  }
}

const COOKIE_NAME = "slicely_sid";
/**
 * How long a session RECORD (and its cookie) survives without a request.
 *
 * Thirty days, not the two hours this used to be: coming back tomorrow to the
 * printer you set up yesterday is the whole point of a hosted workspace, and
 * the record is a few hundred bytes plus a handful of paths. What actually
 * costs a server money is the FILES, and those are swept separately and far
 * more aggressively — see `sweepFiles` and `DEFAULT_FILE_IDLE_MS`.
 */
const DEFAULT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** How long an untouched upload / download / sliced G-code file is kept. The
 *  session keeps living; only its scratch files age out. */
const DEFAULT_FILE_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // check every 10m
/** Brand-new sessions one IP address may mint per hour (spec §2). A workspace
 *  is a directory on disk and an entry in a process-global map, so "anyone can
 *  have one for free" has to stop somewhere short of thousands. */
const DEFAULT_MINT_PER_HOUR = 20;

/** The per-session directories whose contents are disposable — regenerable by
 *  re-uploading, re-downloading or re-slicing. */
const SCRATCH_DIRS = ["uploadsDir", "downloadsDir", "slicesDir"] as const;

/** Names a file sweep must never touch even if one turned up inside a scratch
 *  directory: the encrypted API key, the session's settings, and its chat
 *  history are the session's MEMORY, not its scratch space. */
const KEEP_FOREVER = new Set(["secrets.json", "settings.json", "chats"]);

/** One G-code file this session owns, addressable only by an opaque token
 *  (never by the raw filesystem path — see routes/slice.ts and printers.ts). */
export interface GcodeEntry {
  path: string;
  label: string;
}

/**
 * The minimal shape routes/chat.ts needs from an agent. main/agent/agent.ts's
 * `SlicelyAgent` satisfies this structurally (same `send`/`cancel` shape), so
 * the real class is assignable here with no cast — but routes/chat.ts also
 * accepts an injectable factory typed to return a `ChatAgent`, so tests can
 * hand it a stub that never touches the Anthropic SDK or the network.
 */
export interface ChatAgent {
  send(message: string, emit: (event: AgentEvent) => void): Promise<void>;
  cancel(): void;
  /** Clear the model's memory. Optional so a test stub need not implement it. */
  reset?(): void;
  exportHistory?(): unknown[];
  importHistory?(history: unknown[]): void;
}

export interface SessionRecord {
  id: string;
  /** `<workdir>/sessions/<id>` — everything this browser touches lives here. */
  dir: string;
  uploadsDir: string;
  downloadsDir: string;
  slicesDir: string;
  createdAt: number;
  lastActiveAt: number;
  /** Absolute mesh paths the session has uploaded/imported, most-recent last.
   *  Used as the default target for /api/slice when the client omits `paths`. */
  activeModelPaths: string[];
  /** Opaque token -> file, so gcode is only ever fetched/sent by id. */
  gcodeFiles: Map<string, GcodeEntry>;
  /** Ids of jobs planned by THIS session. main/jobs/store.ts is a single
   *  process-wide store, so without this every visitor could list and read
   *  every other visitor's jobs. */
  jobIds: Set<string>;
  /** Lazily created on first chat message (constructing it opens an Anthropic
   *  client and reads settings — no point paying that cost for a session that
   *  only searches/slices via the REST endpoints). */
  agent?: ChatAgent;
  /** True while a chat turn is streaming, so a second POST /api/chat from the
   *  same tab is rejected instead of racing the first. */
  busy: boolean;
  /** Id of the conversation being added to. Chats live on disk (see chats.ts);
   *  this is just which one new turns belong to. */
  activeChatId?: string;
}

/** True when `target` resolves to a path inside (or equal to) `root`. Used
 *  everywhere a client-suppliable path must be proven to belong to the
 *  caller's own session directory before it's read, written, or handed to
 *  PrusaSlicer/a printer driver. */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── Cookie plumbing (no `cookie`/`cookie-parser` dependency is installed, so
//    this is the small, dependency-free subset Slicely actually needs) ──────

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name: string, value: string, opts: { maxAgeMs: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

// ── Signed session ids ───────────────────────────────────────────────────────
// The id itself is random and unguessable; the HMAC signature only proves the
// cookie was ISSUED by this server (defense against forging an id that maps
// to someone else's session directory). The secret is generated once and
// persisted to disk so restarting the server doesn't silently invalidate
// every open tab.

function loadOrCreateSecret(workdir: string): Buffer {
  const secretPath = join(workdir, ".session-secret");
  try {
    if (existsSync(secretPath)) {
      const hex = readFileSync(secretPath, "utf8").trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
    }
  } catch {
    /* fall through to generating a fresh one */
  }
  const secret = randomBytes(32);
  try {
    mkdirSync(workdir, { recursive: true });
    writeFileSync(secretPath, secret.toString("hex"), { mode: 0o600 });
  } catch {
    /* worst case: a fresh secret per process start, which just means
       existing cookies stop verifying — sessions self-heal on next request */
  }
  return secret;
}

function sign(id: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(id).digest("hex");
}

function verify(cookieValue: string, secret: Buffer): string | undefined {
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return undefined;
  const id = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expected = sign(id, secret);
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return id;
}

// ── The session store ────────────────────────────────────────────────────────

export interface SessionStoreOptions {
  /** Root directory sessions live under. Default `<workdir>/sessions`. */
  sessionsRoot?: string;
  /** Directory the cookie-signing secret is persisted under. Default the
   *  global workdir — overridable so tests never touch the real one. */
  secretDir?: string;
  idleMs?: number;
  /** How long an untouched scratch file is kept (default 2h). */
  fileIdleMs?: number;
  sweepIntervalMs?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly root: string;
  private readonly secret: Buffer;
  private readonly idleMs: number;
  private readonly fileIdleMs: number;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(opts: SessionStoreOptions = {}) {
    this.root = opts.sessionsRoot ?? join(getConfig().workdir, "sessions");
    mkdirSync(this.root, { recursive: true });
    this.secret = loadOrCreateSecret(opts.secretDir ?? getConfig().workdir);
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.fileIdleMs = opts.fileIdleMs ?? DEFAULT_FILE_IDLE_MS;

    const interval = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (interval > 0) {
      // Two sweeps on one timer, deliberately different in aggressiveness:
      // records age out in 30 days, their scratch files in 2 hours.
      this.timer = setInterval(() => {
        void this.sweep();
        void this.sweepFiles();
      }, interval);
      this.timer.unref(); // never keep the process alive on its own
    }
  }

  /** Read the session cookie off `req`, verify it, and return the matching
   *  record — or mint a fresh one and set its cookie on `res`. Always
   *  returns a usable record; never throws. `minted` says which of the two
   *  happened, because a caller that hasn't proved it holds a server-issued
   *  cookie is still anonymous as far as rate limiting goes (see
   *  security.ts's `defaultRateLimitKey`). */
  getOrCreate(req: Request, res: Response): { session: SessionRecord; minted: boolean } {
    const existing = this.lookup(req);
    if (existing) return { session: existing, minted: false };

    const record = this.create();
    const cookieValue = `${record.id}.${sign(record.id, this.secret)}`;
    const secure = (req.headers["x-forwarded-proto"] ?? req.protocol) === "https";
    res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, cookieValue, { maxAgeMs: this.idleMs, secure }));
    return { session: record, minted: true };
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /** True when `req` already carries a cookie THIS server signed whose session
   *  is still alive — i.e. `getOrCreate` would return it rather than mint.
   *  `sessionMiddleware` asks first, so the per-IP mint cap can refuse a
   *  request before a workspace directory has been created for it. */
  hasValidSession(req: Request): boolean {
    return this.lookup(req) !== undefined;
  }

  /** The live session `req`'s cookie proves ownership of, if any. Touches
   *  `lastActiveAt`, since finding a session IS the session being used. */
  private lookup(req: Request): SessionRecord | undefined {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const id = raw ? verify(raw, this.secret) : undefined;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) session.lastActiveAt = Date.now();
    return session;
  }

  count(): number {
    return this.sessions.size;
  }

  private create(): SessionRecord {
    const id = randomBytes(16).toString("hex");
    const dir = join(this.root, id);
    const uploadsDir = join(dir, "uploads");
    const downloadsDir = join(dir, "downloads");
    const slicesDir = join(dir, "slices");
    for (const d of [dir, uploadsDir, downloadsDir, slicesDir]) mkdirSync(d, { recursive: true });
    const now = Date.now();
    const record: SessionRecord = {
      id,
      dir,
      uploadsDir,
      downloadsDir,
      slicesDir,
      createdAt: now,
      lastActiveAt: now,
      activeModelPaths: [],
      gcodeFiles: new Map(),
      jobIds: new Set(),
      busy: false,
    };
    this.sessions.set(id, record);
    return record;
  }

  /** Remove sessions idle longer than `idleMs`, deleting their on-disk
   *  workspace so the server's disk doesn't grow forever. Best-effort —
   *  a failed delete just gets retried on the next sweep. */
  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.idleMs;
    const toEvict = [...this.sessions.values()].filter((s) => s.lastActiveAt < cutoff);
    for (const s of toEvict) {
      this.sessions.delete(s.id);
      forgetSession(s);
      await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return toEvict.length;
  }

  /**
   * Delete every scratch file (uploads, downloads, sliced G-code) that hasn't
   * been touched for `fileIdleMs`, WITHOUT evicting the session itself.
   *
   * This is the sweep that actually keeps a hosted server's disk from filling
   * up: a single visitor can leave hundreds of megabytes of meshes and G-code
   * behind in an afternoon, and none of it is worth keeping once they've
   * downloaded it. What the session is FOR — its encrypted API key, its
   * settings, its chat history — is never touched, so a visitor coming back
   * next week still finds their workspace, just not last week's files.
   *
   * STILL-REFERENCED FILES ARE KEPT regardless of age. A visitor who uploads a
   * mesh, goes to lunch, and comes back to slice it still holds a live
   * `activeModelPaths` entry / G-code token for it; deleting the file under
   * them because its mtime aged out would turn "slice my model" into a 500 with
   * nothing to re-try. Age alone is not evidence that nobody wants the file —
   * only age AND no live reference is.
   *
   * Best-effort: a file that vanishes (or is being written) under us is simply
   * left for the next sweep. Returns how many entries were removed.
   */
  async sweepFiles(): Promise<number> {
    const cutoff = Date.now() - this.fileIdleMs;
    let removed = 0;
    for (const session of this.sessions.values()) {
      const inUse = [
        ...session.activeModelPaths,
        ...[...session.gcodeFiles.values()].map((g) => g.path),
      ];
      /** True when `target` IS a live file, or a directory holding one (an
       *  unpacked zip's folder, whose mesh inside it is the referenced path). */
      const isInUse = (target: string) => inUse.some((p) => isInsideDir(target, p));

      for (const key of SCRATCH_DIRS) {
        const dir = session[key];
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue; // never created, or already gone
        }
        for (const entry of entries) {
          if (KEEP_FOREVER.has(entry)) continue;
          const target = join(dir, entry);
          if (isInUse(target)) continue;
          try {
            const info = await stat(target);
            if (info.mtimeMs > cutoff) continue;
            await rm(target, { recursive: true, force: true });
            removed += 1;
          } catch {
            /* raced with a live request — the next sweep will get it */
          }
        }
      }
      // Don't leave the browser holding tokens for files that are now gone:
      // a download of one would 500 rather than saying "that's expired".
      for (const [id, entry] of session.gcodeFiles) {
        if (!existsSync(entry.path)) session.gcodeFiles.delete(id);
      }
      session.activeModelPaths = session.activeModelPaths.filter((p) => existsSync(p));
    }
    return removed;
  }

  /** Force-evict one session (used by tests, and available for an explicit
   *  "log out / delete my data" affordance). */
  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    forgetSession(s);
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Drop every IN-MEMORY trace of a session.
 *
 * Deleting the directory is not enough: the ambient-session caches
 * (main/agent/state.ts, main/settings.ts, main/userkey.ts,
 * main/printers/registry.ts) are process-global Maps keyed by session id. Left
 * alone they grow without bound on a busy server, and — worse — the visitor's
 * decrypted API key and printer credentials would sit in memory long after
 * they pressed "Delete my data".
 */
function forgetSession(session: SessionRecord): void {
  session.agent?.cancel();
  disposeSessionState(session.id);
  disposeCalls.state += 1;
  disposeSessionSettings(session.id);
  disposeCalls.settings += 1;
  disposeSessionUserKey(session.id);
  disposeCalls.userKey += 1;
  disposeSessionPrinters(session.id);
  disposeCalls.printers += 1;
}

/** How many times each ambient cache has been disposed. A counter rather than
 *  a spy because node:test has no module mocking for CommonJS requires, and
 *  "did destroy() really drop the decrypted key?" is worth a test. */
const disposeCalls = { state: 0, settings: 0, userKey: 0, printers: 0 };

/** Test-only read side of `disposeCalls`. Never called by the server. */
export function __disposeCallsForTests(): { state: number; settings: number; userKey: number; printers: number } {
  return { ...disposeCalls };
}

/** Expire the session cookie in the browser (DELETE /api/session). Lives here
 *  so the cookie's name and attributes are defined in exactly one place. */
export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export interface SessionMiddlewareOptions {
  /** Brand-new sessions one address may mint per hour. Default 20. */
  mintPerHour?: number;
}

/**
 * Attach this request's session — MOUNTED ON THE `/api` ROUTER ONLY.
 *
 * Nothing else needs one: static files, /healthz and the legal pages are the
 * same bytes for everybody, and minting a session for them meant a crawler (or
 * an uptime check) left a directory on disk behind every hit.
 *
 * A request that arrives without a valid cookie gets a workspace created for
 * it, which is why the per-IP mint cap lives HERE, ahead of the store: by the
 * time `getOrCreate` returns, the directory exists. Checking the cap in a
 * separate `rateLimiter` further down the chain would be too late, and one
 * further up couldn't tell a returning visitor from a brand-new one.
 */
export function sessionMiddleware(store: SessionStore, opts: SessionMiddlewareOptions = {}): RequestHandler {
  const mintPerHour = opts.mintPerHour ?? DEFAULT_MINT_PER_HOUR;
  const mintBudget = new TokenBuckets({ capacity: mintPerHour, refillPerSec: mintPerHour / 3600 });

  return (req: Request, res: Response, next: NextFunction) => {
    if (!store.hasValidSession(req)) {
      const retryAfter = mintBudget.take(`mint:${clientIp(req)}`);
      if (retryAfter !== undefined) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          error: "Too many new sessions from this address. Try again later.",
          code: "rate_limited",
        });
        return;
      }
    }

    const { session, minted } = store.getOrCreate(req, res);
    req.session = session;
    req.sessionMinted = minted;
    // Run the ENTIRE request inside this session's ambient context. Everything
    // downstream — routes, the agent loop, tool execution, settings reads —
    // then resolves to this visitor's own state with no per-route plumbing,
    // and AsyncLocalStorage carries it across every await.
    // Pass the session's OWN directory: the store's root is configurable (a
    // temp dir under test), so letting sessionContext recompute it would both
    // diverge from session.dir and litter the default workdir.
    runInSession(sessionContext(session.id, session.dir), () => next());
  };
}

/** Move a just-produced G-code file into `session`'s own slices directory and
 *  register it under a fresh opaque token. Used by both /api/slice and the
 *  job-run SSE stream so a plate's output is addressable only via
 *  `GET /api/gcode/:id` (and only from the session that made it) — never by
 *  the raw path main/prusaslicer.ts wrote it to (which is a GLOBAL shared
 *  directory; see prusaslicer.ts's `cfg.slicesDir`). Idempotent-ish: if the
 *  source file is already gone (e.g. relocated by a concurrent call), the
 *  original path is returned unchanged rather than throwing. */
export async function adoptGcodeFile(
  session: SessionRecord,
  sourcePath: string,
): Promise<{ path: string; id: string }> {
  await mkdir(session.slicesDir, { recursive: true });
  const dest = join(session.slicesDir, basename(sourcePath));

  // IDEMPOTENCE: a plate's G-code is adopted once on `plate_done` and the
  // job-level event carries the same path again. Re-adopting used to call
  // rename() on a file that had already moved, throw, and then register the
  // OLD path under a fresh token — handing the browser a live gcodeId whose
  // download 500s. If this file is already ours, reuse its existing token.
  if (resolve(sourcePath) === resolve(dest)) {
    for (const [existingId, entry] of session.gcodeFiles) {
      if (resolve(entry.path) === resolve(dest)) {
        return { path: dest, id: existingId };
      }
    }
    const id = randomBytes(8).toString("hex");
    session.gcodeFiles.set(id, { path: dest, label: basename(dest) });
    return { path: dest, id };
  }

  try {
    await rename(sourcePath, dest);
  } catch {
    // The source vanished (or is on another device). Only hand back a token
    // if something is actually readable there — never register a dead path.
    if (!existsSync(sourcePath)) {
      throw new Error(`G-code no longer exists at ${sourcePath}`);
    }
    const id = randomBytes(8).toString("hex");
    session.gcodeFiles.set(id, { path: sourcePath, label: basename(sourcePath) });
    return { path: sourcePath, id };
  }
  const id = randomBytes(8).toString("hex");
  session.gcodeFiles.set(id, { path: dest, label: basename(dest) });
  return { path: dest, id };
}

// NOTE: an earlier revision serialized every chat turn server-wide with a
// promise-chain mutex, because main/agent/state.ts was a process-global
// singleton and concurrent turns would interleave writes to it. state.ts is now
// session-keyed (see main/session-context.ts), so that lock has been removed —
// concurrent visitors each run in their own context. Per-session serialization
// is still enforced by `SessionRecord.busy`, which is the correct granularity.
