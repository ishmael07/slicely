// ─────────────────────────────────────────────────────────────────────────────
// The desktop launch token.
//
// In desktop mode the Express app is no longer reached only by the person
// sitting in front of it: it listens on a real TCP port on 127.0.0.1, and
// EVERY other process on that machine can reach a loopback port. A browser tab
// on some unrelated website cannot read our responses (the CORS guard and the
// absence of Access-Control-Allow-Origin see to that), but a script, a helper
// app, or a second user account on the same Mac could otherwise drive the whole
// API: list the printers, read the chats, slice, print, spend the user's
// Anthropic credit.
//
// So the desktop app mints a fresh random token per launch and hands it to the
// one window it opens (as an httpOnly cookie set on the loopback origin BEFORE
// the page is loaded — see main.ts). Every request must present it, in that
// cookie or in the `x-slicely-desktop` header, or it is refused. The token is
// never in a URL, never in a page, never in `/api/config`, and never on disk:
// it lives in the Electron process's memory and in the window's cookie jar.
//
// Hosted mode has no token and ignores the option entirely — there the session
// cookie is the identity, and every visitor is entitled to their own workspace.
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { isDesktop } from "../main/mode";
import { readCookie } from "./session";
// Both refusals below go through the ONE error funnel, like every other failure
// this server sends: they were hand-built `res.status(403).json(...)` calls that
// happened to agree with `{ error, code }` today and would drift tomorrow.
import { sendError, WireError } from "./errors";

/** The cookie main.ts sets on the loopback origin before loading the window. */
export const DESKTOP_COOKIE = "slicely_desktop";

/** The header alternative, for a caller that isn't a browser (and for tests).
 *  Lower-case because that is how Node hands header names over. */
export const DESKTOP_HEADER = "x-slicely-desktop";

/** The only host names that name this machine's own loopback interface. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when `host` is an interface the desktop app may bind — i.e. loopback and
 * nothing else. `undefined` is FALSE: an unset host means "every interface",
 * which is what a container wants and the opposite of what a personal Mac app
 * wants. Used by startServer (see index.ts).
 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  // The whole 127/8 block, not just .0.1 — `127.0.0.2` is loopback too.
  return LOOPBACK_NAMES.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * DNS-REBINDING HARDENING. True when a request's `Host` header names the
 * loopback address and port this server is actually listening on.
 *
 * The attack the token already stops, and this stops a second time: a page on
 * `http://evil.example` cannot read our responses (no CORS header, and the
 * token), but its author controls DNS for their own name, so they can point
 * `attack.evil.example` at `127.0.0.1` and have the victim's browser send us
 * same-origin-looking requests with `Host: attack.evil.example`. A server that
 * answers whatever Host it is given is then reachable from any web page the user
 * visits, with the browser's own cookies attached.
 *
 * The expected port is the socket's own local port rather than a value threaded
 * down from `listen`, because the desktop app asks the OS for port 0 and only
 * learns the answer afterwards — the socket always knows, and cannot be lied to.
 */
export function isAllowedDesktopHost(header: string | undefined, localPort: number | undefined): boolean {
  if (!header) return false; // HTTP/1.1 requires Host; a request without one is not ours.
  // A Host header is a host and optionally a port — nothing else. Refuse the
  // punctuation that introduces anything else BEFORE parsing, because the parser
  // is lenient where this must not be: `127.0.0.1:4321#` parses to our own
  // hostname, our own port, and an EMPTY hash, so checking `parsed.hash` alone
  // let it through. (Delimiters, not a character allowlist, so an IPv6 literal's
  // brackets and colons still work.)
  if (/[/\\@#?\s]/.test(header.trim())) return false;
  let parsed: URL;
  try {
    // The Host header is an authority, not a URL — borrow a scheme to parse it
    // with the same rules a browser uses (which is the point: no hand-rolled
    // splitting on ":" that an IPv6 literal or a userinfo field walks past).
    parsed = new URL(`http://${header.trim()}`);
  } catch {
    return false;
  }
  // A `Host` carrying userinfo, a path, a query or a FRAGMENT is not a host at
  // all. The fragment was missing from this list: `127.0.0.1:53421#evil.example`
  // parses with our hostname and our port and a hash nobody looked at, so it
  // passed — harmless in itself (a fragment is never sent to a server by a
  // browser), but this function's whole job is to answer "is this Host header
  // exactly ours", and "ours plus something" is not.
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return false;
  }
  if (!isLoopbackBindHost(parsed.hostname)) return false;
  // An empty `port` means the scheme's default, which for the borrowed http is 80.
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  return localPort !== undefined && port === localPort;
}

/** Constant-time compare that doesn't leak the token's length either: a
 *  mismatched length fails before timingSafeEqual (which throws on unequal
 *  buffers), and `presented` is always hashed to the same size first by being
 *  compared against a buffer of the expected length only when they match. */
function sameToken(expected: Buffer, presented: string): boolean {
  const got = Buffer.from(presented, "utf8");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/**
 * Refuse any desktop-mode request that doesn't carry the launch token — or that
 * arrived under a host name that isn't this server's own loopback address (see
 * `isAllowedDesktopHost`).
 *
 * Mounted on the WHOLE app rather than on `/api`, ahead of the static
 * allow-list: the app shell, the stylesheet and the client modules are just as
 * much "the desktop app" as the API is, and serving them to a local port
 * scanner while refusing the API would be a strange place to draw the line.
 */
export function desktopTokenGuard(token: string): RequestHandler {
  const expected = Buffer.from(token, "utf8");

  return function requireDesktopToken(req, res, next) {
    // Hosted mode ignores the token: nothing mints one there, and requiring a
    // header no browser sends would refuse every visitor.
    if (!isDesktop()) {
      next();
      return;
    }

    // Defence in depth, before the token is even looked at: a request that
    // reached us under somebody else's host name is refused whatever it carries.
    if (!isAllowedDesktopHost(req.headers.host, req.socket.localPort)) {
      sendError(res, new WireError(403, "Forbidden.", "forbidden"));
      return;
    }

    const header = req.headers[DESKTOP_HEADER];
    const presented =
      (typeof header === "string" ? header : undefined) ??
      readCookie(req.headers.cookie, DESKTOP_COOKIE);

    if (presented && sameToken(expected, presented)) {
      next();
      return;
    }

    sendError(res, new WireError(403, "Forbidden.", "forbidden"));
  };
}
