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
import { Semaphore, SemaphoreTimeoutError } from "../../main/semaphore";
import { sendError, WireError } from "../errors";

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

/**
 * How many thumbnails may be in flight at once, and how long a request will
 * queue for a slot before giving up.
 *
 * A twelve-result search paints twelve cards, so the browser opens twelve of
 * these AT ONCE — and each one is a full-resolution photo on someone else's CDN
 * with a 15 s ceiling (above). Unbounded, all twelve race that ceiling
 * together: twelve sockets, twelve buffers of up to MAX_BYTES, and a slow host
 * anywhere in the set drags the whole grid to the timeout. Four at a time is
 * fast enough to fill a grid (they finish in waves) and small enough that the
 * memory and the socket count are bounded by the constant rather than by how
 * many cards a search returned.
 *
 * The queue wait is deliberately SHORTER than the fetch timeout: a request that
 * has already waited 10 s for a slot would, if let through, be allowed another
 * 15 s upstream — long past the point where the browser has given up and the
 * card has drawn its placeholder. Better to say "busy" while someone is still
 * listening. Both are exported so the test asserts the numbers the route
 * actually uses.
 */
export const THUMB_MAX_CONCURRENT = 4;
export const THUMB_QUEUE_TIMEOUT_MS = 10_000;

/** What this router needs to reach the internet, and how much of it at a time.
 *  Injectable ONLY so a test can see which URL and which timeout the route asked
 *  for without a network, and exercise the queue without waiting real seconds;
 *  the defaults are the SSRF-guarded fetch and the constants above, and nothing
 *  else may be passed in production (index.ts calls this with no options). */
export interface ThumbsRouterOptions {
  fetch?: typeof guardedFetch;
  maxConcurrent?: number;
  queueTimeoutMs?: number;
}

export function createThumbsRouter(opts: ThumbsRouterOptions = {}): Router {
  const router = Router();
  const fetchUpstream = opts.fetch ?? guardedFetch;
  // One semaphore per router, not per process: a test builds its own router,
  // and index.ts builds exactly one.
  const slots = new Semaphore(opts.maxConcurrent ?? THUMB_MAX_CONCURRENT);
  const queueTimeoutMs = opts.queueTimeoutMs ?? THUMB_QUEUE_TIMEOUT_MS;

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

    // Take a slot. AFTER the cheap rejections above, so a 400/403 never sits in
    // a queue behind twelve real fetches.
    let release: () => void;
    try {
      release = await slots.acquire(queueTimeoutMs);
    } catch (err) {
      if (err instanceof SemaphoreTimeoutError) {
        // 503 `busy`, not 502. A 502 says "this thumbnail is dead" and the UI
        // draws its placeholder for good; `busy` says "this server is full",
        // which is both true and retryable — and it is one of the stable wire
        // codes, so the client already knows it.
        sendError(
          res,
          new WireError(503, "Too many thumbnails at once. Try again in a moment.", "busy"),
        );
        return;
      }
      res.status(502).end();
      return;
    }
    // The grid may have scrolled away, or the tab closed, while this waited in
    // the queue. Spending a slot on a socket nobody is reading is the whole
    // thing the queue exists to prevent.
    if (res.writableEnded || res.destroyed) {
      release();
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
    } finally {
      // Never conditional, never skipped: a permit that is not given back is
      // gone for the life of the process, and four of those wedge the endpoint
      // permanently.
      release();
    }
  });

  return router;
}
