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
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getConfig } from "./config";

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
  const dir = join(currentSession().dir, "slices");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* surfaced later if we actually fail to write */
  }
  return dir;
}

/** Resolve a filename inside the ambient session's directory. */
export function sessionFile(name: string): string {
  return join(currentSession().dir, name);
}
