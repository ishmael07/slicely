// Shared helpers for every printer driver: a hard-timeout fetch wrapper (a
// hung socket must never hang the app), small formatting/parsing helpers, and
// id/clock utilities. Pure Node — this whole directory runs inside both the
// Electron main process and the headless web server, so nothing here may
// import "electron".
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { isHosted } from "../mode";
import { isLocalOrLinkLocalAddress, isPrivateAddress } from "../sourcing/net";
import { WireError } from "../../server/errors";

/** Default network timeout applied to a driver call, in ms. Every driver
 *  method (test/status/send/pause/resume/cancel) must bound its network calls
 *  to roughly this so an unreachable printer fails fast instead of hanging. */
export const DEFAULT_TIMEOUT_MS = 8000;

// ── Where a driver may point (Task D4) ───────────────────────────────────────
//
// A printer's `host` is typed by whoever is using Slicely, and every driver
// turns it straight into a URL that the SERVER requests, from inside the
// server's own network. "Test my printer" pointed at 127.0.0.1 reads whatever
// else listens on this machine; pointed at 169.254.169.254 on a cloud host it
// reads the instance's credentials. So the host is checked, not trusted.
//
// The check is in TWO places on purpose, and they are not the same check:
//
//   • `assertPrinterHostAllowed` runs when a printer is SAVED (addPrinter /
//     updatePrinter). It is the full rule: it resolves hostnames, and in hosted
//     mode it refuses every private range as well. That is the only way a host
//     gets into the registry, so it is the right place for the expensive,
//     mode-dependent policy — and it covers the transports that never use
//     `fetch` at all (Bambu LAN dials MQTT and FTPS).
//   • `fetchTimeout` re-checks on every driver call, synchronously and with no
//     DNS: only the addresses that are never a printer in ANY mode (loopback,
//     0.0.0.0, link-local, multicast, the "localhost" names). It is on the
//     status-polling hot path — a DNS round-trip per printer per poll is real
//     cost — and its job is to stop a URL a driver built from reaching this
//     machine, not to re-litigate the LAN policy the saved record already
//     passed. A LAN printer must keep working here in both modes.

/** Hostnames that always mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/** The refusal every host check owes a client: the same message and code
 *  whichever rule matched, so no probe can tell "blocked because loopback"
 *  from "blocked because private" and map the network that way. */
function hostBlocked(): never {
  throw new WireError(400, "That address isn't a printer we can reach from here.", "host_blocked");
}

/** Strip the brackets of an IPv6 literal and normalise case. */
function bareHost(host: string): string {
  return (host ?? "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/** True for a host that is never a printer, in any mode: it names this very
 *  machine, the local link, or a group. Hostname forms included. */
function isNeverAPrinter(host: string): boolean {
  const h = bareHost(host);
  if (h.length === 0) return true;
  if (LOOPBACK_HOSTNAMES.has(h) || h.endsWith(".localhost")) return true;
  if (isIP(h) !== 0) return isLocalOrLinkLocalAddress(h);
  return false;
}

/** Every address a printer hostname resolves to. */
async function resolveAll(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Throws `WireError(400, …, "host_blocked")` unless `host` could plausibly be a
 * printer reachable from here.
 *
 * Always refused: loopback (127/8, ::1, the "localhost" names), 0.0.0.0,
 * link-local (169.254/16 — the cloud metadata address — and fe80::/10), and
 * multicast. In HOSTED mode every private range goes too: a shared server has
 * no LAN, so a request to a private address is a request to somebody else's
 * network or to the deploy's own internals. In DESKTOP mode private ranges are
 * ALLOWED, because that is where printers actually live — as are `.local` mDNS
 * names, which is how a printer announces itself.
 *
 * A hostname is resolved and EVERY record checked. If it will not resolve,
 * hosted mode refuses (a name we cannot check is a name we will not dial) while
 * desktop mode allows it: a LAN printer's name is often not in DNS at all, and
 * turning that into "blocked address" would hide the real "couldn't connect".
 */
export async function assertPrinterHostAllowed(
  host: string,
  opts: { lookup?: (h: string) => Promise<string[]> } = {},
): Promise<void> {
  const h = bareHost(host);
  if (isNeverAPrinter(h)) hostBlocked();

  if (isIP(h) !== 0) {
    if (isHosted() && isPrivateAddress(h)) hostBlocked();
    return;
  }

  // A hostname. mDNS names resolve on a local link the hosted server hasn't got.
  if (isHosted() && h.endsWith(".local")) hostBlocked();

  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? resolveAll)(h);
  } catch {
    if (isHosted()) hostBlocked();
    return;
  }
  if (addresses.length === 0) {
    if (isHosted()) hostBlocked();
    return;
  }
  for (const address of addresses) {
    if (isLocalOrLinkLocalAddress(address)) hostBlocked();
    if (isHosted() && isPrivateAddress(address)) hostBlocked();
  }
}

/**
 * fetch() with a hard timeout via AbortSignal.timeout, and a synchronous check
 * that the URL is not pointed at this machine (see the block comment above). A
 * printer that's powered off but still holds a DHCP lease (connection just
 * hangs, no RST) is the common case the timeout guards against — without it, a
 * single stale printer could freeze the whole status-polling loop.
 *
 * Every driver's HTTP call goes through here, so there is one place that decides
 * what a driver may dial. A bare `fetch(` anywhere in drivers/ is a bug.
 */
export async function fetchTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    hostBlocked();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") hostBlocked();
  if (isNeverAPrinter(parsed.hostname)) hostBlocked();

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

/** Where macOS mounts every disk that isn't the boot volume — external SSDs,
 *  disk images, and (the point of this rule) SD cards. It is the ONE place
 *  outside `$HOME` a person can plausibly mean by "save my prints here": the
 *  transport's own label is "Folder / SD card", and a card reader mounts
 *  exactly here, never under a user's home.
 *
 *  `/Volumes/Macintosh HD` is itself a symlink to `/` on every real Mac — a
 *  fact this module's containment check must survive — which is exactly why
 *  tests need a fake root of their own rather than pointing at the real one.
 *  A `let` (not `const`) so `setVolumesRootForTests` below can swap it. */
let VOLUMES_ROOT = `${sep}Volumes`;

/** Tests only: point the /Volumes containment check at a fake root (e.g. a
 *  temp dir standing in for the real, unwritable-in-CI /Volumes) so symlink
 *  and traversal scenarios can be built without touching real hardware. Pass
 *  `undefined` to restore the real `/Volumes`. */
export function setVolumesRootForTests(root: string | undefined): void {
  VOLUMES_ROOT = root ?? `${sep}Volumes`;
}

/**
 * Assert that `dir` is somewhere a person could plausibly have chosen to save a
 * G-code file, and return it resolved.
 *
 *  1. HOSTED MODE HAS NO FOLDERS. On a shared server the "folder" is the
 *     server's own disk, which the visitor cannot see and does not own, so the
 *     whole transport is refused with a message that points at the Mac app.
 *  2. ABSOLUTE, AND SOMEWHERE A PERSON COULD MEAN. A relative path would
 *     resolve against whatever cwd the process happens to have. What's left
 *     is either inside `homedir()` (Desktop, Documents, …) or under
 *     `/Volumes` (a mounted drive) — anything else (`/etc`,
 *     `/usr/local/bin`, another account's home) is refused.
 *  3. NO DOT SEGMENTS. `~/.ssh`, `~/.config`, `~/.aws` — and, on a mounted
 *     volume, `.Trashes`, `.fseventsd` — hold credentials, app config, or
 *     filesystem bookkeeping that make writing into them dangerous. Excluding
 *     every dot-prefixed segment costs the user nothing (nobody keeps their
 *     prints in a hidden folder) and removes the entire class at once.
 *  4. A MOUNTED VOLUME MUST ACTUALLY BE THERE. `$HOME` gets its safety from
 *     containment; `/Volumes` has no such property (anything could be
 *     mounted, or unmounted, at any name), so a real, currently-existing
 *     directory stands in for it instead. An SD card that was removed (or a
 *     path for one that was never inserted) resolves to nothing, same as
 *     picking a folder that was never there.
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
  const insideHome = !rel.startsWith("..") && !isAbsolute(rel);
  const insideVolumes = target.startsWith(`${VOLUMES_ROOT}${sep}`);

  if (!insideHome && !insideVolumes) {
    throw new WireError(
      403,
      "Pick a folder inside your home folder, or on a mounted drive under /Volumes.",
      "not_in_workspace",
    );
  }

  const relSegments = (insideHome ? rel : relative(VOLUMES_ROOT, target)).split(sep);
  if (relSegments.some((segment) => segment.startsWith("."))) {
    throw new WireError(
      403,
      "That's a hidden system folder. Pick somewhere like your Desktop or a folder in Documents.",
      "not_in_workspace",
    );
  }

  if (insideVolumes) {
    // The unresolved-string check above (`insideVolumes`) is not enough:
    // `/Volumes/Macintosh HD` IS a path under /Volumes, but on every real Mac
    // it's a symlink to `/` — so the path a person typed can be contained
    // while the file it actually names is not. Resolve every symlink with
    // realpathSync and re-check containment on THAT, or a mount that's just a
    // symlink elsewhere on the boot disk (or off it) sails straight through.
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      throw new WireError(403, "That drive isn't connected. Plug it in and try again.", "not_in_workspace");
    }
    const resolvedInsideVolumes = resolved === VOLUMES_ROOT || resolved.startsWith(`${VOLUMES_ROOT}${sep}`);
    let isDir = false;
    if (resolvedInsideVolumes) {
      try {
        isDir = statSync(resolved).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!resolvedInsideVolumes || !isDir) {
      throw new WireError(403, "That drive isn't connected. Plug it in and try again.", "not_in_workspace");
    }
  }

  return target;
}
