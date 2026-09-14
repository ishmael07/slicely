// ─────────────────────────────────────────────────────────────────────────────
// GET /api/thumb — proxies model thumbnails.
//
// Several sources serve images with Cross-Origin-Resource-Policy set, so a
// browser refuses to paint them in our page: Thingiverse's CDN fails with
// ERR_BLOCKED_BY_RESPONSE.NotSameOrigin and the card falls back to a grey
// placeholder. Fetching server-side and re-serving makes the image same-origin,
// so results actually look like the thing you are about to print.
//
// This is a proxy, so it is deliberately narrow: only known model-source image
// hosts, only images, and a size cap. An open image proxy is an SSRF tool.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { guardedFetch } from "../../main/sourcing/net";

/**
 * Hosts whose thumbnails may be proxied.
 *
 * An allowlist rather than a blocklist: anything else is somebody using the
 * server to fetch a URL of their choosing. Matching is on the exact host or a
 * subdomain of it, never a substring — "evil-thingiverse.com" must not pass.
 */
const ALLOWED_HOSTS = [
  "thingiverse.com",
  "cdn.thingiverse.com",
  "media.printables.com",
  "files.printables.com",
  "makerworld.com",
  "bblmw.com",
  "myminifactory.com",
  "images.myminifactory.com",
  "3dprint.nih.gov",
  "ids.si.edu",
  "nasa.gov",
  "githubusercontent.com",
];

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

/**
 * Cap on a proxied image.
 *
 * Set at 4MB first, which rejected real Printables listing photos with a 413 —
 * sources serve the full-resolution upload, not a thumbnail, and a good camera
 * photo of a print clears 4MB easily. This is a guard against something absurd,
 * not a compression policy.
 */
const MAX_BYTES = 16 * 1024 * 1024;
/**
 * How long we wait for a source's image server.
 *
 * 8 s was too short to be honest about what these URLs are: the sources serve
 * the listing's FULL-RESOLUTION upload (see MAX_BYTES above), so a 3 MB photo
 * on a slow CDN legitimately takes ten seconds — three to five cards in a
 * twelve-result search came back 502 and rendered as ◆ placeholders, measured
 * against Printables and MyMiniFactory. 15 s covers the real ones; anything
 * beyond that is a dead host, and a card without a picture is still usable.
 *
 * Exported so the test can assert the number this route actually waits, rather
 * than a copy of it written out again in the test.
 */
export const THUMB_TIMEOUT_MS = 15_000;

/** What this router needs to reach the internet. Injectable ONLY so a test can
 *  see which URL and which timeout the route asked for without a network; the
 *  default is the SSRF-guarded fetch and nothing else may be passed in
 *  production (index.ts calls this with no options). */
export interface ThumbsRouterOptions {
  fetch?: typeof guardedFetch;
}

export function createThumbsRouter(opts: ThumbsRouterOptions = {}): Router {
  const router = Router();
  const fetchUpstream = opts.fetch ?? guardedFetch;

  router.get("/thumb", async (req: Request, res: Response) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (!raw) {
      res.status(400).end();
      return;
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      res.status(400).end();
      return;
    }
    if (url.protocol !== "https:" || !hostAllowed(url.hostname)) {
      res.status(403).end();
      return;
    }

    try {
      // The allowlist above checks the URL the CLIENT sent. Thumbnail hosts
      // redirect constantly (CDN → signed storage URL), and a 302 is a fresh
      // URL nobody has checked — so the fetch goes through the shared guard,
      // which follows the chain itself and re-applies BOTH the SSRF ranges and
      // the `allow` predicate below to every hop.
      const upstream = await fetchUpstream(
        url.toString(),
        {
          headers: {
            // Some CDNs 403 an unidentified client.
            "User-Agent": "Slicely/1.0 (+https://github.com/ishmael07/slicely)",
            Accept: "image/*",
          },
          guard: { allow: (u) => u.protocol === "https:" && hostAllowed(u.hostname) },
        },
        THUMB_TIMEOUT_MS,
      );
      if (!upstream.ok) {
        res.status(502).end();
        return;
      }

      const type = upstream.headers.get("content-type") ?? "";
      // Only images. Without this the endpoint would happily relay HTML or JSON
      // from an allowed host.
      if (!type.startsWith("image/")) {
        res.status(415).end();
        return;
      }
      const declared = Number(upstream.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) {
        res.status(413).end();
        return;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        res.status(413).end();
        return;
      }

      res.setHeader("Content-Type", type);
      // Thumbnails never change; let the browser keep them.
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.end(buf);
    } catch {
      // A dead thumbnail is not worth an error in the UI; the card falls back
      // to its placeholder on a non-200.
      res.status(502).end();
    }
  });

  return router;
}
