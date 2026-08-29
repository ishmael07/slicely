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
const TIMEOUT_MS = 8000;

export function createThumbsRouter(): Router {
  const router = Router();

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
      const upstream = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Some CDNs 403 an unidentified client.
          "User-Agent": "Slicely/1.0 (+https://github.com/ishmael07/slicely)",
          Accept: "image/*",
        },
        redirect: "follow",
      });
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
