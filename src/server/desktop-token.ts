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

/** The cookie main.ts sets on the loopback origin before loading the window. */
export const DESKTOP_COOKIE = "slicely_desktop";

/** The header alternative, for a caller that isn't a browser (and for tests).
 *  Lower-case because that is how Node hands header names over. */
export const DESKTOP_HEADER = "x-slicely-desktop";

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
 * Refuse any desktop-mode request that doesn't carry the launch token.
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

    const header = req.headers[DESKTOP_HEADER];
    const presented =
      (typeof header === "string" ? header : undefined) ??
      readCookie(req.headers.cookie, DESKTOP_COOKIE);

    if (presented && sameToken(expected, presented)) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden.", code: "forbidden" });
  };
}
