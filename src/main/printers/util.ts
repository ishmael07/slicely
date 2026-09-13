// Shared helpers for every printer driver: a hard-timeout fetch wrapper (a
// hung socket must never hang the app), small formatting/parsing helpers, and
// id/clock utilities. Pure Node — this whole directory runs inside both the
// Electron main process and the headless web server, so nothing here may
// import "electron".
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { isHosted } from "../mode";
import { WireError } from "../../server/errors";

/** Default network timeout applied to a driver call, in ms. Every driver
 *  method (test/status/send/pause/resume/cancel) must bound its network calls
 *  to roughly this so an unreachable printer fails fast instead of hanging. */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * fetch() with a hard timeout via AbortSignal.timeout. A printer that's
 * powered off but still holds a DHCP lease (connection just hangs, no RST) is
 * the common case this guards against — without it, a single stale printer
 * could freeze the whole status-polling loop.
 */
export function fetchTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/** A fresh id for a new registry record. */
export function newId(): string {
  return randomUUID();
}

/** Current time as an ISO string — the timestamp format every status/record
 *  in shared/printers.ts uses. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize a printer-reported colour to "#RRGGBB". Accepts a bare 6-hex
 * string ("00AE42") or an 8-hex RRGGBBAA string (Bambu's AMS report format,
 * e.g. "00AE42FF") and drops the alpha channel. Returns undefined for
 * anything that doesn't parse as hex, so a garbled report degrades to "no
 * colour" instead of a wrong one.
 */
export function normalizeColourHex(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const hex = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex) && !/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

/** Render any thrown value as a plain-language message. Network errors from
 *  fetch/AbortSignal.timeout are Error instances, but defend against the rest
 *  (thrown strings, MQTT's occasional non-Error rejects). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError";
    // its default message ("The operation was aborted due to timeout") is
    // already clear enough to show a user as-is.
    return err.message || String(err);
  }
  return String(err);
}

/** Best-effort read of a Response body for an error message, capped so a
 *  misbehaving server can't dump megabytes into a status message. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

// ── Where a "print" may actually land (Task D2) ──────────────────────────────
//
// Both helpers below exist because two pieces of a print job are chosen by the
// CALLER — the job's filename and, for the "file" transport, the destination
// folder — and both used to be passed through untouched. `path.join(dir,
// "../../../.ssh/authorized_keys")` is all it took to write a file wherever the
// server process could write, and a hosted deploy has no business writing into
// a folder at all.

/** Extensions a printer (or an SD card) will actually accept. Anything else
 *  gets ".gcode" appended rather than being rejected, so a user's odd name
 *  still produces a usable file. */
const ALLOWED_JOB_EXTS = [".gcode", ".bgcode", ".3mf"] as const;
/** Filename length cap. Long enough for any real model name, short enough to
 *  stay under every filesystem's and printer firmware's own limit. */
const MAX_JOB_NAME = 120;

/**
 * Reduce a caller-supplied job name to a safe FILENAME.
 *
 * A job name is stored on a printer or written into a folder, so it must never
 * be able to describe a path: every directory separator (both kinds — the
 * destination may not be POSIX) is dropped by keeping only the last segment,
 * control characters are stripped (they can forge CLI/HTTP boundaries and
 * produce unopenable files), the result must end in a printable extension, and
 * it is capped in length. A name that sanitises down to nothing — "", "..",
 * "/" — becomes `fallback`, which callers derive from the G-code file itself.
 */
export function safeJobName(name: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // Last path segment only: "../../x" and "..\\..\\x" both reduce to "x".
  const segments = cleaned.split(/[\\/]+/);
  let base = segments[segments.length - 1].trim();
  // A name made only of dots is a directory reference, not a filename.
  if (base.length === 0 || /^\.+$/.test(base)) return fallback;

  const lower = base.toLowerCase();
  if (!ALLOWED_JOB_EXTS.some((ext) => lower.endsWith(ext))) base += ".gcode";

  if (base.length > MAX_JOB_NAME) {
    // Truncate the STEM, never the extension — a ".gco" tail would be rejected
    // by the very firmware this cap exists to satisfy.
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    base = base.slice(0, Math.max(1, MAX_JOB_NAME - ext.length)) + ext;
  }
  return base;
}

/**
 * Assert that `dir` is somewhere a person could plausibly have chosen to save a
 * G-code file, and return it resolved.
 *
 * Three rules, in order:
 *
 *  1. HOSTED MODE HAS NO FOLDERS. On a shared server the "folder" is the
 *     server's own disk, which the visitor cannot see and does not own, so the
 *     whole transport is refused with a message that points at the Mac app.
 *  2. ABSOLUTE, AND INSIDE THE USER'S HOME. A relative path would resolve
 *     against whatever cwd the process happens to have; anything outside
 *     `homedir()` (`/etc`, `/usr/local/bin`, another account's home) is not a
 *     place a person means when they pick "save my prints here".
 *  3. NO DOT SEGMENTS. `~/.ssh`, `~/.config`, `~/.aws` and friends hold the
 *     credentials and configuration that make a home directory dangerous to
 *     write into. Excluding every dot-prefixed segment costs the user nothing
 *     (nobody keeps their prints in a hidden folder) and removes the entire
 *     class at once.
 */
export function assertAllowedOutputDir(dir: string): string {
  if (isHosted()) {
    throw new WireError(403, "Saving to a folder only works in the Mac app.", "forbidden_in_hosted_mode");
  }
  if (typeof dir !== "string" || dir.trim().length === 0 || !isAbsolute(dir)) {
    throw new WireError(400, "Pick a folder using its full path.", "not_in_workspace");
  }

  const home = resolvePath(homedir());
  const target = resolvePath(dir);
  const rel = relative(home, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WireError(403, "Pick a folder inside your home folder.", "not_in_workspace");
  }
  if (rel.split(sep).some((segment) => segment.startsWith("."))) {
    throw new WireError(
      403,
      "That's a hidden system folder. Pick somewhere like your Desktop or a folder in Documents.",
      "not_in_workspace",
    );
  }
  return target;
}
