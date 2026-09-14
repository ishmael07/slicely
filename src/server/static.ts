// ─────────────────────────────────────────────────────────────────────────────
// The static allow-list.
//
// This server used to publish two whole directories:
//
//     app.use(express.static(join(REPO_ROOT, "src", "web")));
//     app.use("/web", express.static(join(REPO_ROOT, "dist-web", "web")));
//
// `src/web` is not a build output — it is the SOURCE directory. So
// `GET /app.ts` handed any visitor the TypeScript for the client, and
// `GET /web/app.js.map` handed them the sourcemap, which embeds the original
// sources again. Neither is a secret in a repo that's public anyway, but the
// habit is the problem: whatever lands in `src/web` next (a scratch file, a
// `.env.local` someone drops while debugging, a `notes.md`) is published the
// moment it's saved, with nobody deciding that it should be.
//
// So nothing is published by directory. The table below is the entire list of
// URLs this server will serve off disk, each mapped to one named file with one
// declared content type. Anything else — a `.ts`, a `.map`, a dotfile, a
// nested path, a directory listing, a traversal attempt — falls through to
// `next()` and meets the app's ordinary JSON 404.
//
// The one pattern (rather than literal) entry is `/web/<name>.js`, because the
// client is a set of browser ESM modules that import each other by name and
// the set changes as the UI grows. It is still narrow: a single path segment,
// `[A-Za-z0-9._-]` only (so no `/`, no `\`, no `%`-decoded surprise), not
// starting with a dot, and it must end in `.js` — which is by itself what
// refuses `app.js.map`, `app.ts` and `..`.
// ─────────────────────────────────────────────────────────────────────────────
import { join } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** One servable file: where it is, what it is, and how long a browser may keep
 *  it. `cache` is spelled out per entry rather than defaulted, because getting
 *  it wrong on the app shell is what ships a stale client to a returning user:
 *  none of these filenames are content-hashed, so the HTML, CSS and JS must all
 *  be revalidated every time. Only the things that genuinely never change —
 *  the favicon, the legal text — may sit in a cache. */
interface Servable {
  /** Path segments under the repo root. */
  file: string[];
  type: string;
  cache: string;
}

const REVALIDATE = "no-cache";
const ASSET_CACHE = "public, max-age=86400";
const PAGE_CACHE = "public, max-age=300";
/** A year, immutable — for files whose NAME states their contents. A woff2 named
 *  `inter-latin-400` is one weight of one release of one typeface: if it ever
 *  needs to change it gets a different name, so there is no stale-cache story to
 *  worry about and no reason to make a returning visitor revalidate three fonts
 *  on every page view. (Contrast the HTML/CSS/JS above, which reuse their names.) */
const IMMUTABLE = "public, max-age=31536000, immutable";

const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const WOFF2 = "font/woff2";

/** Every URL served off disk, in full. Add a line to publish a file; there is
 *  no other way for one to become reachable. */
function table(): Record<string, Servable> {
  return {
    // The app shell. Both spellings, because a hand-typed /index.html should
    // not 404 on the one page a user might type by hand.
    "/": { file: ["src", "web", "index.html"], type: HTML, cache: REVALIDATE },
    "/index.html": { file: ["src", "web", "index.html"], type: HTML, cache: REVALIDATE },
    // The app's own stylesheet, under its own URL. It used to answer at
    // `/styles.css` — but `site/terms.html` and `site/privacy.html` link a
    // RELATIVE `styles.css`, so served from this server at `/terms` they asked
    // for `/styles.css` and got the app shell's CSS, which has none of the
    // `.legal` rules. The legal text rendered unstyled. So `/styles.css` is the
    // site stylesheet (the one the legal pages mean) and the app shell links
    // `/app.css` instead — see `src/web/index.html`.
    "/app.css": { file: ["src", "web", "styles.css"], type: CSS, cache: REVALIDATE },
    // REVALIDATE, like every other CSS here: this filename is not
    // content-hashed either, so a cached copy is how a user keeps yesterday's
    // stylesheet after a deploy. (It sat on PAGE_CACHE, which contradicted this
    // module's own rule two comments up — only the favicon and the legal TEXT
    // may sit in a cache.)
    "/styles.css": { file: ["site", "styles.css"], type: CSS, cache: REVALIDATE },
    // The ◆ mark, shared with the marketing site so the two agree.
    "/favicon.svg": { file: ["site", "favicon.svg"], type: "image/svg+xml", cache: ASSET_CACHE },
    // The three Inter faces `site/styles.css` declares in its @font-face rules
    // (`url('fonts/inter-latin-<weight>.woff2')`, resolved against `/styles.css`
    // and therefore requested as `/fonts/…`). They were missing, so `/terms` and
    // `/privacy` served from THIS server 404'd all three and fell back to
    // system-ui. Listed one file per line, exactly the ones the site references —
    // `site/fonts/` also holds LICENSE.txt, which is not a web asset.
    "/fonts/inter-latin-400.woff2": {
      file: ["site", "fonts", "inter-latin-400.woff2"],
      type: WOFF2,
      cache: IMMUTABLE,
    },
    "/fonts/inter-latin-600.woff2": {
      file: ["site", "fonts", "inter-latin-600.woff2"],
      type: WOFF2,
      cache: IMMUTABLE,
    },
    "/fonts/inter-latin-700.woff2": {
      file: ["site", "fonts", "inter-latin-700.woff2"],
      type: WOFF2,
      cache: IMMUTABLE,
    },
    // Extension-less, because these are pages a user is linked to (Settings →
    // About, the onboarding card), not files. The `.html` spellings answer too,
    // since that is how the marketing site links them.
    "/terms": { file: ["site", "terms.html"], type: HTML, cache: PAGE_CACHE },
    "/terms.html": { file: ["site", "terms.html"], type: HTML, cache: PAGE_CACHE },
    "/privacy": { file: ["site", "privacy.html"], type: HTML, cache: PAGE_CACHE },
    "/privacy.html": { file: ["site", "privacy.html"], type: HTML, cache: PAGE_CACHE },
  };
}

/** The compiled client modules, and nothing else that happens to sit beside
 *  them in `dist-web/web` — the sourcemaps, most immediately. */
const WEB_MODULE = /^\/web\/([A-Za-z0-9_-][A-Za-z0-9._-]*\.js)$/;

/**
 * The one static handler this server mounts.
 *
 * `repoRoot` is passed in rather than derived here so the caller (index.ts,
 * which already resolves it relative to its own location for the compiled and
 * from-source cases alike) stays the single place that decides where the repo
 * is.
 */
export function webStatic(repoRoot: string): RequestHandler {
  const files = table();

  return function serveStatic(req: Request, res: Response, next: NextFunction): void {
    // A static file answers GET and HEAD. Anything else — a POST to
    // /styles.css, say — is not a static request and must not be answered as
    // one; it falls through so the API mount or the 404 handler deals with it.
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const entry = files[req.path];
    if (entry) {
      send(res, next, repoRoot, join(...entry.file), entry.type, entry.cache);
      return;
    }

    const mod = WEB_MODULE.exec(req.path);
    if (mod) {
      send(
        res,
        next,
        repoRoot,
        join("dist-web", "web", mod[1]),
        "text/javascript; charset=utf-8",
        REVALIDATE,
      );
      return;
    }

    next();
  };
}

/**
 * Send one already-vetted file, named RELATIVE to the repo root. A missing file
 * is `next()`, not a 500: an install without `dist-web/web` yet (or without
 * `site/`) should read as "no such URL", which is also what it is from the
 * client's side.
 *
 * `relPath` + `root` rather than one absolute path, because `dotfiles: "deny"`
 * is applied to whatever path `send` is given: handed an absolute path with no
 * `root`, it tests every segment of it, including the ones above the repo. A
 * checkout under a dotted ancestor — `~/.local/share/slicely`, which is exactly
 * where an unpacked release would sit — then 404s every single URL, with the
 * dotfile rule firing on `.local` rather than on anything this server named.
 * With `root` set, the rule sees only the part of the path the table chose.
 */
function send(
  res: Response,
  next: NextFunction,
  root: string,
  relPath: string,
  type: string,
  cache: string,
): void {
  res.type(type);
  res.setHeader("Cache-Control", cache);
  // `dotfiles: "deny"` is belt-and-braces: no entry in the table names one and
  // the module pattern refuses a leading dot, so this can only ever fire if
  // someone adds a bad line above.
  res.sendFile(relPath, { root, dotfiles: "deny" }, (err?: Error) => {
    if (!err) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    next();
  });
}
