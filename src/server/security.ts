// ─────────────────────────────────────────────────────────────────────────────
// Hardening middleware for a server that, unlike the Electron app, is reached
// by a hostile-by-default internet client. Nothing here is a new dependency
// (no helmet, no express-rate-limit) per the P1 constraint — it's the minimum
// hand-rolled set: security headers, a same-origin lock, a JSON/upload size
// ceiling, and an in-memory token-bucket rate limiter.
// ─────────────────────────────────────────────────────────────────────────────
import type { Request, RequestHandler } from "express";
import type { PrinterTransport } from "../shared/printers";
import { CLOUD_TRANSPORTS } from "../shared/printers";

/**
 * True when Slicely is running as a SHARED, hosted, multi-tenant server
 * rather than on a single user's own machine. Flip with `SLICELY_MULTI_USER=
 * true`.
 *
 * WHY THIS DISTINCTION MATTERS: LAN mDNS/SSDP discovery and the LAN-only
 * printer transports (OctoPrint, Moonraker, PrusaLink, Bambu-LAN, and the
 * local "file"/SD-card transport) all assume the SERVER's network is the
 * PRINTER's network. That assumption holds for the Electron app running on
 * the user's own Mac, on the same Wi-Fi as their printer. It is essentially
 * never true for a hosted server sitting in a datacenter: its "LAN" is the
 * cloud provider's internal network, not the user's garage. Running
 * discovery there would either find nothing, or — worse, on a shared
 * host — find and expose devices that belong to a DIFFERENT tenant's
 * network. Only genuinely cloud transports (Prusa Connect, Bambu Cloud)
 * reach a specific user's printer regardless of where the server itself
 * runs, so those are the only transports multi-user mode allows.
 */
export function isMultiUser(): boolean {
  return process.env.SLICELY_MULTI_USER === "true";
}

/** True when `transport` requires being on the same physical network as the
 *  printer (i.e. everything that isn't a cloud transport). In multi-user
 *  mode these are refused by routes/printers.ts. */
export function isLanOnlyTransport(transport: PrinterTransport): boolean {
  return !CLOUD_TRANSPORTS.has(transport);
}

/** express.json({ limit }) — generous enough for a job-plan payload (dozens
 *  of parts + settings) but nowhere near upload-file sized. */
export const JSON_BODY_LIMIT = "2mb";

/** multer's per-file size ceiling. STL/3MF/ZIP models can legitimately run to
 *  tens of MB; 200MB comfortably covers a multi-part kit while still bounding
 *  a hostile upload. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // 'unsafe-inline' on style- only (the web client's CSS is a single small
    // stylesheet with no inline event handlers); script-src stays locked to
    // same-origin script files.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self';",
    );
    next();
  };
}

/**
 * A same-origin lock for an app that is meant to be used ONLY from its own
 * page. Browsers already refuse to let cross-site JS *read* a response
 * without a matching Access-Control-Allow-Origin header, and this server
 * never sends one — so cross-site `fetch()` reads are blocked by default.
 * This middleware makes that explicit and closes the remaining gap (a
 * cross-site POST whose response the attacker doesn't need to read, i.e. a
 * CSRF-shaped request): any request that carries an `Origin` header naming a
 * different host is rejected outright, before it reaches a route handler.
 * Same-origin requests, and non-browser clients that send no Origin at all
 * (curl, the SSE reconnect logic, server-to-server calls), pass through.
 */
export function corsGuard(): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const host = req.headers.host;
    let sameOrigin = false;
    try {
      sameOrigin = !!host && new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      res.status(403).json({ error: "Cross-origin requests are not allowed." });
      return;
    }
    next();
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────

interface Bucket {
  tokens: number;
  last: number;
}

export interface RateLimitOptions {
  /** Burst size — max requests answered back-to-back. Default 30. */
  capacity?: number;
  /** Sustained refill rate, tokens/second. Default 2 (≈ 1 request/500ms). */
  refillPerSec?: number;
  /** How a request is attributed to a bucket. Default: session cookie, else
   *  remote IP, so one browser tab can't starve another and a single bad
   *  actor can't exhaust every other visitor's budget. */
  keyFn?: (req: Request) => string;
}

/** A tiny in-memory token-bucket limiter (no new dependency). Returns 429
 *  with a `Retry-After` header once a key's bucket is empty. Buckets for keys
 *  that haven't been seen in a while are swept out so long-running processes
 *  don't accumulate one entry per visitor forever. */
export function rateLimiter(opts: RateLimitOptions = {}): RequestHandler {
  const capacity = opts.capacity ?? 30;
  const refillPerSec = opts.refillPerSec ?? 2;
  const keyFn = opts.keyFn ?? defaultRateLimitKey;
  const buckets = new Map<string, Bucket>();
  const staleAfterMs = 30 * 60 * 1000;
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > staleAfterMs) {
      lastSweep = now;
      for (const [key, b] of buckets) {
        if (now - b.last > staleAfterMs) buckets.delete(key);
      }
    }

    const key = keyFn(req);
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity - 1, last: now };
      buckets.set(key, b);
      next();
      return;
    }

    const elapsedSec = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.last = now;

    if (b.tokens < 1) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "Too many requests — slow down a little." });
      return;
    }
    b.tokens -= 1;
    next();
  };
}

function defaultRateLimitKey(req: Request): string {
  const cookie = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)slicely_sid=([^;]+)/.exec(cookie);
  if (m) return `sid:${m[1]}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
}
