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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { getConfig } from "./config";
import { isDesktop } from "./mode";
import { hasHiddenSegment, volumesRoot } from "./paths";

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
//   • DESKTOP — the session directory plus the app's downloads folder, the
//     user's home directory, and `/Volumes` (an SD card or external drive). It
//     is their machine and their files; refusing `~/Desktop/bracket.stl` there
//     would be a bug, not a protection. Hidden components are still refused,
//     though: `~/.ssh/id_rsa` is not a model the user wants sliced, and
//     `<workdir>/.session-secret` signs every session cookie.
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
 *
 * Exported for its own test: the walk up to an existing ancestor and back down
 * is the part of the workspace guard with the most ways to be subtly wrong, and
 * a test that goes through `isInsideSessionWorkspace` can only see the verdict,
 * not the path the verdict was reached about.
 */
export function realPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p); // nothing on this path exists
      // `basename`, not `head.slice(parent.length + 1)`: when the parent is the
      // ROOT, `parent.length + 1` is 2, so `/x` sliced from index 2 is `""` —
      // an empty segment that `join` drops, and `realPath("/x")` came back as
      // `"/"`. A not-yet-created path one level down from the root then judged
      // as the root itself, which is inside nothing and outside nothing.
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * The directories the ambient session may read and write.
 *
 * HOSTED: its own workspace, nothing else — and NOTHING AT ALL for the default
 * session. `currentSession()` falls back to the default session whenever it is
 * called outside `runInSession`, and the default session's directory is the
 * whole workdir, which CONTAINS `sessions/*` and `.session-secret`. So a code
 * path that forgot to establish a session would not have failed; it would have
 * been handed every visitor's workspace and the cookie-signing key. On a shared
 * server there is no legitimate caller in that position (sessionMiddleware
 * wraps every request), so the empty list is the honest answer: every path is
 * rejected, loudly, instead of every path being allowed, silently.
 *
 * DESKTOP: also the app's downloads folder, the user's home directory, and
 * `/Volumes` (an SD card or external drive is where prints often live), because
 * those files are the user's own. Dot-prefixed components are still refused
 * below — see `hasHiddenSegment`.
 */
function workspaceRoots(): string[] {
  const session = currentSession();
  if (!isDesktop() && session.id === DEFAULT_SESSION_ID) return [];
  const roots = [session.dir];
  if (isDesktop()) {
    try {
      roots.push(getConfig().downloadsDir);
    } catch {
      /* config unavailable — the session directory still applies */
    }
    roots.push(homedir());
    // A mounted drive is reached the same way assertAllowedOutputDir reaches
    // it: name it as a root and let the realpath containment below do the
    // work. `/Volumes/Macintosh HD/etc/passwd` therefore fails, because that
    // path's REAL location is `/etc/passwd`, which is under no root at all.
    roots.push(volumesRoot());
  }
  return roots.filter((r) => typeof r === "string" && r.length > 0);
}

/**
 * The real path of `p` when the ambient session is allowed to touch it, or
 * `undefined` when it isn't.
 *
 * Returns the REAL path rather than the caller's string so a caller opens the
 * very file that was checked. `resolve(p)` and `realPath(p)` can name the same
 * file through different routes (a symlink inside the workspace pointing at
 * another file inside it; `/var` vs `/private/var` on macOS), and handing back
 * the unresolved one leaves a second, unchecked resolution to happen later at
 * open() time.
 *
 * Note this answers a question about a PATH, not about permission to perform an
 * operation: callers still decide what they do with a contained path.
 */
/**
 * The only subtrees a RELATIVE workspace reference may name.
 *
 * A relative path arrives from somewhere untrusted by definition — the browser
 * (a `relPath` it was handed, or one it made up) or the MODEL (a tool argument
 * one token away from anything). The session directory's own top level is not
 * scratch space: it holds `secrets.json` (the encrypted Anthropic key),
 * `printer-secrets.json`, `settings.json`, and on the desktop `master.key` and
 * `.session-secret` as well. `scratch/` is left out too — nothing is ever handed
 * out from multer's landing strip, so naming it is never legitimate.
 */
export const WORKSPACE_REL_ROOTS = ["uploads", "downloads", "slices"] as const;

/**
 * True when `p` is a relative reference safe to join to a session directory.
 *
 * WHY A SEPARATE CHECK, when everything is containment-checked afterwards
 * anyway: join-then-contain proves only that the result is INSIDE the session,
 * and `uploads/../secrets.json` is inside the session. It passed, and with it a
 * client- or model-supplied `relPath` reached the encrypted key through
 * GET /api/preview, POST /api/slice's `paths`, POST /api/jobs' `parts[].path`
 * and `send_to_printer`'s `gcodePath`. Containment was the wrong question for a
 * relative path; this is the right one, and it is asked BEFORE the join.
 *
 * Rejected: anything absolute (the caller handles those separately, with their
 * own containment check), a `..` or `.` segment anywhere, an empty segment, a
 * bare filename with no subtree at all, and any first segment that is not one of
 * `WORKSPACE_REL_ROOTS`. Backslash counts as a separator too, so a Windows-style
 * `uploads\..\secrets.json` cannot slip past a POSIX-only split.
 */
export function isSafeWorkspaceRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.trim().length === 0) return false;
  if (isAbsolute(p)) return false;
  const segments = p.split(/[/\\]/);
  if (segments.length < 2) return false;
  if (!(WORKSPACE_REL_ROOTS as readonly string[]).includes(segments[0])) return false;
  return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * How a file inside the ambient session is NAMED to the model — and therefore,
 * once the model quotes it in its reply, to the user's browser.
 *
 * The rule "absolute filesystem paths never reach a client" was enforced on the
 * wire (routes/chat.ts runs every agent frame through `toClientPaths`), but the
 * model's own prose is not a field anyone can rewrite: a tool RESULT that said
 * "downloaded to /data/sessions/ab12/downloads/cube.stl" got echoed into the
 * chat verbatim, deployment layout, session id and all. So the tool results
 * speak the same workspace-relative form the wire does, and this is the one
 * place that spelling is decided.
 *
 * The answer is deliberately ROUND-TRIPPABLE: what comes out of here is exactly
 * what `resolveInsideSessionWorkspace` (and the server's `resolveSessionPath`)
 * accept back, so the model can hand a path it was just told straight to the
 * next tool — `import_from_url` → `plan_job` → `run_job` without ever seeing an
 * absolute path.
 *
 *   • inside `uploads/`, `downloads/` or `slices/` → "uploads/cube.stl".
 *   • DESKTOP, anywhere else the user is allowed (their home folder, an SD
 *     card) → the path unchanged. There is no relative spelling for a file
 *     outside the session directory, the machine belongs to the person reading
 *     the reply, and "bracket.stl" would be a name no tool could resolve again.
 *   • HOSTED, anywhere else (`scratch/`, the session's own top level) → the
 *     basename. Nothing is ever handed out from there, so this is the
 *     fail-quiet branch rather than a supported shape.
 */
export function workspaceRef(absolute: string): string {
  if (typeof absolute !== "string" || absolute.length === 0) return "";
  const dir = currentSession().dir;
  const relIn = (root: string, target: string): string | undefined => {
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel.split(/[/\\]/).join("/");
  };
  // Asked twice, because the two strings can be different spellings of the same
  // place: `assertWorkspacePath` hands the tools the REAL path (symlinks
  // resolved), while `session.dir` is whatever SLICELY_WORKDIR said — and on
  // macOS `/var` is a symlink to `/private/var`, so a plain `relative()` between
  // them yields `../../…`. Left at one comparison, every reference on a
  // deployment whose root sits behind a link would have degraded to a basename.
  // The cheap comparison first; the filesystem only when it does not agree.
  const inside = relIn(dir, absolute) ?? relIn(realPath(dir), realPath(absolute));
  if (inside !== undefined) {
    // Inside Slicely's own directory. A subtree we actually hand out gets its
    // relative spelling; anything else gets its basename and nothing more —
    // `secrets.json` and `master.key` live at that top level, and naming them is
    // the disclosure this function exists to prevent, desktop or not.
    return isSafeWorkspaceRelPath(inside) ? inside : basename(absolute);
  }
  // Outside it. On the desktop that is one of the USER'S OWN files (their home
  // folder, an SD card): the path is the only name that resolves again, and the
  // machine belongs to the person reading the reply. Hosted, no such file is
  // reachable at all, so the basename is the fail-quiet answer.
  return isDesktop() ? absolute : basename(absolute);
}

export function resolveInsideSessionWorkspace(p: string): string | undefined {
  if (typeof p !== "string" || p.trim().length === 0) return undefined;
  // A RELATIVE path means "inside my workspace", never "inside whatever
  // directory this process happens to have been started in".
  //
  // This matters now that the wire carries workspace-relative references
  // ("uploads/cube.stl" — see WorkspaceFile): the client puts that in the chat
  // prompt, the model passes it to a tool, and the tool asks here. Left to
  // `resolve()`, it would have been joined to `process.cwd()` — the repo root in
  // dev, `/` for a packaged app — and then refused for being outside the
  // workspace, so the agent could not open the file the user had just attached.
  // Resolving against the session's own directory also keeps `../` honest:
  // `../other-session/uploads/x.stl` still lands outside every root below and is
  // still refused.
  // Not just "does it land inside" — a relative reference must be one of the
  // shapes we actually hand out. See isSafeWorkspaceRelPath: `uploads/cube.stl`
  // yes, `uploads/../secrets.json` and a bare `secrets.json` no.
  if (!isAbsolute(p) && !isSafeWorkspaceRelPath(p)) return undefined;
  const absolute = isAbsolute(p) ? p : join(currentSession().dir, p);
  const target = realPath(absolute);
  const desktop = isDesktop();
  const roots = workspaceRoots();
  if (roots.length === 0) return undefined;

  // ── The subtree rule applies to an ABSOLUTE path too ──────────────────────
  //
  // `isSafeWorkspaceRelPath` above confines a RELATIVE reference to
  // uploads/downloads/slices. Spelled absolutely, the very same file skipped it
  // and only had to clear containment — and `<session>/secrets.json` (the
  // encrypted Anthropic key), `<session>/printer-secrets.json`, and on the
  // desktop `<workdir>/master.key` are all inside the session directory. So the
  // rule is applied to the RESOLVED path instead of to the caller's spelling,
  // which is the only place both forms meet.
  //
  // It also has to be FINAL rather than one root's opinion: the desktop's roots
  // include `$HOME`, and the workdir (`~/Library/Application Support/Slicely`)
  // sits inside it — so merely skipping to the next root would have let the home
  // root re-admit the file the session root had just refused. Being inside
  // Slicely's own directory is never a licence; it is the stricter rule.
  const realSessionDir = realPath(currentSession().dir);
  if (isInsideDir(realSessionDir, target)) {
    const rel = relative(realSessionDir, target);
    if (!isSafeWorkspaceRelPath(rel)) return undefined;
    if (desktop && hasHiddenSegment(rel)) return undefined;
    return target;
  }

  for (const root of roots) {
    const realRoot = realPath(root);
    if (!isInsideDir(realRoot, target)) continue;
    // The user's own machine is where the hidden-folder rule earns its keep:
    // `$HOME` is a root there, and `$HOME/.ssh/id_rsa` is inside it. The
    // default session's directory IS the workdir on the desktop, so this is
    // also what keeps `.session-secret` out of the model's reach.
    if (desktop && hasHiddenSegment(relative(realRoot, target))) continue;
    return target;
  }
  return undefined;
}

/**
 * True when `p` names a file the ambient session is allowed to touch.
 *
 * See the block comment above for what counts as allowed in each mode.
 */
export function isInsideSessionWorkspace(p: string): boolean {
  return resolveInsideSessionWorkspace(p) !== undefined;
}
