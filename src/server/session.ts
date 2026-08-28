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
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AgentEvent } from "../shared/types";
import { getConfig } from "../main/config";
import { runInSession, sessionContext } from "../main/session-context";

// Augment Express's Request with the session this middleware attaches. Scoped
// to this codebase only — harmless if another module never imports it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionRecord;
    }
  }
}

const COOKIE_NAME = "slicely_sid";
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000; // 2h of inactivity evicts a session
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // check every 10m

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
  sweepIntervalMs?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly root: string;
  private readonly secret: Buffer;
  private readonly idleMs: number;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(opts: SessionStoreOptions = {}) {
    this.root = opts.sessionsRoot ?? join(getConfig().workdir, "sessions");
    mkdirSync(this.root, { recursive: true });
    this.secret = loadOrCreateSecret(opts.secretDir ?? getConfig().workdir);
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;

    const interval = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => void this.sweep(), interval);
      this.timer.unref(); // never keep the process alive on its own
    }
  }

  /** Read the session cookie off `req`, verify it, and return the matching
   *  record — or mint a fresh one and set its cookie on `res`. Always
   *  returns a usable record; never throws. */
  getOrCreate(req: Request, res: Response): SessionRecord {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[COOKIE_NAME];
    const id = raw ? verify(raw, this.secret) : undefined;
    const existing = id ? this.sessions.get(id) : undefined;
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const record = this.create();
    const cookieValue = `${record.id}.${sign(record.id, this.secret)}`;
    const secure = (req.headers["x-forwarded-proto"] ?? req.protocol) === "https";
    res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, cookieValue, { maxAgeMs: this.idleMs, secure }));
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
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
      await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return toEvict.length;
  }

  /** Force-evict one session (used by tests, and available for an explicit
   *  "log out / delete my data" affordance). */
  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export function sessionMiddleware(store: SessionStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = store.getOrCreate(req, res);
    req.session = session;
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
