// ─────────────────────────────────────────────────────────────────────────────
// "Is this URL our own server?" — the one decision the window's navigation
// guard makes, kept here as a pure function so it can be tested without
// Electron.
//
// It used to be `target.startsWith(serverUrl)` inline in main.ts, and that is
// not an origin check — it is a string-prefix check, which a URL's *userinfo*
// field walks straight past:
//
//     serverUrl = "http://127.0.0.1:53421"
//     target    = "http://127.0.0.1:53421@evil.example/"
//
// The target's host is `evil.example`; `127.0.0.1:53421` is a username. The
// prefix matched, so the window navigated off-origin with the preload bridge
// (the native open dialog, `pathsForDrop`) still attached to it. Other spellings
// do the same thing: `http://127.0.0.1:53421.evil.example/`,
// `http://127.0.0.1:534210/` (a different port that happens to start with ours).
//
// So the comparison is done where the browser does it: on the parsed ORIGIN —
// scheme, host and port together, all three or nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `target` is a URL on exactly the same origin as `serverUrl`.
 *
 * Deliberately total and deliberately pessimistic: anything unparseable (a
 * relative URL, `about:blank`, `javascript:…`, an empty `serverUrl` because the
 * server has not finished starting) is NOT the same origin and gets `false`.
 * The caller's job is then to refuse the navigation, which is the safe answer
 * for every one of those cases.
 */
export function isSameOrigin(target: string, serverUrl: string): boolean {
  try {
    const a = new URL(target);
    const b = new URL(serverUrl);
    // `origin` is "null" for opaque origins (data:, blob: of one, file: in some
    // runtimes). Two of those must never compare equal to each other.
    if (a.origin === "null" || b.origin === "null") return false;
    // BOTH MUST BE http(s), before the origins are compared at all.
    //
    // `blob:` INHERITS the origin of the page that created it, so
    // `new URL("blob:http://127.0.0.1:53421/<uuid>").origin` is
    // "http://127.0.0.1:53421" — our own server's origin, exactly equal, and the
    // window would have been allowed to navigate to a blob the page built for
    // itself. The same is true of `filesystem:`. A blob URL is content the page
    // authored rather than content the server served, which is the whole
    // distinction this guard exists to make, so scheme is part of the answer:
    // the only thing the window may navigate to is our own http(s) server.
    if (!/^https?:$/.test(a.protocol) || !/^https?:$/.test(b.protocol)) return false;
    return a.origin === b.origin;
  } catch {
    return false;
  }
}
