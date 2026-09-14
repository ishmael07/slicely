// ─────────────────────────────────────────────────────────────────────────────
// Session scoping.
//
// Slicely began as a single-window Electron app, so its per-conversation state
// (agent/state.ts) and its user preferences (settings.ts) were module-level
// singletons. That is exactly right for one window and exactly wrong for a web
// server, where every visitor needs their own active model, preferences, and
// workspace.
//
// Rather than thread a session id through ~40 call sites, this module carries
// it in an AsyncLocalStorage. Anything running inside runInSession() sees its
// own state; anything outside (i.e. Electron, and any startup code) transparently
// gets the DEFAULT session. So the Electron app is unchanged and unaware, while
// the server wraps each request and gets isolation for free.
// ─────────────────────────────────────────────────────────────────────────────
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { getConfig } from "./config";
import { isDesktop } from "./mode";

/** The single implicit session used by Electron and by any code outside a
 *  request. Its files live directly in the workdir, exactly where v1 put them,
 *  so an existing install keeps its settings.json without migration. */
export const DEFAULT_SESSION_ID = "__default__";

export interface SessionContext {
  /** Opaque session id. Stable for the life of a browser session. */
  id: string;
  /** Absolute directory holding this session's files. The default session uses
   *  the plain workdir; web sessions get <workdir>/sessions/<id>. */
  dir: string;
}

const storage = new AsyncLocalStorage<SessionContext>();

/**
 * Build the context for a session id, creating its directory on first use.
 *
 * Pass `dir` when the caller already owns the session's directory — the web
 * SessionStore does, and its root is configurable (and is a temp dir under
 * test). Recomputing it here instead would silently diverge from the real
 * session directory and scatter stray folders under the default workdir.
 */
export function sessionContext(id: string, dir?: string): SessionContext {
  if (id === DEFAULT_SESSION_ID) {
    return { id, dir: dir ?? getConfig().workdir };
  }
  const resolved = dir ?? join(getConfig().workdir, "sessions", id);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch {
    /* surfaced later if we actually fail to write */
  }
  return { id, dir: resolved };
}

/**
 * Run `fn` with `ctx` as the ambient session. Everything the callback awaits
 * inherits it, so `sessionState` and the settings accessors resolve to this
 * session without any explicit plumbing.
 */
export function runInSession<T>(ctx: SessionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The ambient session, or the default when called outside runInSession(). */
export function currentSession(): SessionContext {
  return storage.getStore() ?? sessionContext(DEFAULT_SESSION_ID);
}

/** The ambient session's id. */
export function currentSessionId(): string {
  return currentSession().id;
}

/**
 * Where slicer output for the ambient session belongs.
 *
 * PrusaSlicer names its output after the plate ("plate-1.gcode"), so every
 * visitor slicing at the same time wants the same filename. Writing those into
 * one shared directory meant one visitor's slice could overwrite another's
 * between the moment PrusaSlicer wrote it and the moment the server adopted
 * it — the second visitor would then download the first's part. Giving each
 * session its own directory removes the collision instead of racing it.
 *
 * For the default session (Electron, and anything outside a request) this is
 * `<workdir>/slices` — exactly where v1 wrote, so nothing moves.
 */
export function sessionSlicesDir(): string {
  return ensured(join(currentSession().dir, "slices"));
}

/** Resolve a filename inside the ambient session's directory. */
export function sessionFile(name: string): string {
  return join(currentSession().dir, name);
}

/** Where a model DOWNLOADED for the ambient session belongs. Same shape and
 *  same reasoning as `sessionSlicesDir()`: for the default session this is
 *  `<workdir>/downloads`, exactly where v1 wrote, so Electron doesn't move. */
export function sessionDownloadsDir(): string {
  return ensured(join(currentSession().dir, "downloads"));
}

/** Where a model UPLOADED (or expanded out of a zip) for the ambient session
 *  belongs — `<workdir>/uploads` for the default session. */
export function sessionUploadsDir(): string {
  return ensured(join(currentSession().dir, "uploads"));
}

function ensured(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* surfaced later if we actually fail to write */
  }
  return dir;
}

// ── The workspace boundary (Task D5) ─────────────────────────────────────────
//
// Every agent tool that touches a file takes its path from the MODEL, which
// takes it from the conversation. `inspect_model {"path": "/etc/passwd"}` is
// one token away at all times, and on a hosted server the more interesting
// target is the next directory along: sessions live side by side under
// `<workdir>/sessions/<id>`, so a guessed or leaked id would otherwise be a
// readable path into somebody else's uploads.
//
// So a path is checked, not trusted. What counts as "mine" differs by mode,
// because the two modes have genuinely different owners:
//
//   • HOSTED — only this session's own directory. The server's disk is
//     nobody's personal computer; there is no file on it a visitor is
//     entitled to beyond the ones they put there.
//   • DESKTOP — the session directory plus the app's downloads folder and the
//     user's home directory. It is their machine and their files; refusing
//     `~/Desktop/bracket.stl` there would be a bug, not a protection.
//
// Containment is decided on the REAL path (symlinks resolved), not the
// lexically normalised one. A writer inside the workspace — an extracted zip
// entry, most plausibly — can leave a symlink behind, and `resolve()` alone
// happily reports `<workspace>/uploads/link.stl` as contained while the file
// it names is `/etc/passwd`. Resolving first also makes the macOS `/var` →
// `/private/var` pair (and any bind-mounted deploy root) compare equal instead
// of spuriously "outside".

/** True when `target` is `root` or sits underneath it. Both must already be
 *  resolved; `relative()` is used rather than `startsWith` so `/a/bc` is not
 *  mistaken for a child of `/a/b`. */
function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The path with every symlink resolved. A path that doesn't exist yet (a slice
 * about to be written) resolves as far up as it can and keeps the rest
 * literally, so a not-yet-created file is judged by the directory it will land
 * in rather than being rejected for not existing.
 */
function realPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p); // nothing on this path exists
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/** The directories the ambient session may read and write. Hosted: its own
 *  workspace, nothing else. Desktop: also the app's downloads folder and the
 *  user's home directory, because those files are the user's own. */
function workspaceRoots(): string[] {
  const roots = [currentSession().dir];
  if (isDesktop()) {
    try {
      roots.push(getConfig().downloadsDir);
    } catch {
      /* config unavailable — the session directory still applies */
    }
    roots.push(homedir());
  }
  return roots.filter((r) => typeof r === "string" && r.length > 0);
}

/**
 * True when `p` names a file the ambient session is allowed to touch.
 *
 * See the block comment above for what counts as allowed in each mode. Note
 * that this answers a question about a PATH, not about permission to perform
 * an operation: callers still decide what they do with a contained path.
 */
export function isInsideSessionWorkspace(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false;
  const target = realPath(p);
  return workspaceRoots().some((root) => isInsideDir(realPath(root), target));
}
