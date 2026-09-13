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
import { isHosted } from "../main/mode";

/**
 * True when Slicely is running as a SHARED, hosted, multi-tenant server
 * rather than on a single user's own machine. Delegates to the `SLICELY_MODE`
 * switch (see mode.ts): hosted is the default, desktop is opt-in.
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
  return isHosted();
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
 * `Cache-Control: no-store` on everything under /api.
 *
 * NOT a nicety. Every API response is scoped to ONE session: `/api/config`
 * carries that visitor's `hasKey`/`keyHint`, `/api/chats` their conversations,
 * `/api/printers` their machines. They are plain GETs on a shared URL, so a CDN
 * or reverse proxy in front of a hosted deployment is entitled to cache the
 * first response it sees and hand it to the next visitor — leaking one user's
 * key state (and worse) to another. The cookie that distinguishes them is
 * invisible to a cache that hasn't been told to vary on it.
 *
 * Applied to the whole router rather than per route, so a new endpoint is
 * private by default instead of private only if its author remembered.
 * Streaming routes may still override it: /api/chat's SSE headers pass
 * `no-cache, no-transform` to `writeHead`, which wins for that response.
 */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
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

export interface BucketSpec {
  /** Burst size — max requests answered back-to-back. */
  capacity: number;
  /** Sustained refill rate, tokens/second. */
  refillPerSec: number;
}

/**
 * A keyed set of token buckets with no dependency and no unbounded growth:
 * buckets whose key hasn't been seen for a while are dropped, so a long-lived
 * process doesn't keep one entry per visitor forever.
 *
 * Shared by `rateLimiter` (per request, per tier) and by session.ts's per-IP
 * session-mint cap, which has to run BEFORE a session exists and so can't be
 * expressed as one more `rateLimiter` in the middleware chain.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  /**
   * How long an untouched bucket is kept before it's dropped to save memory.
   *
   * This CANNOT be a flat 30 minutes: dropping a bucket resets it to full, so
   * evicting one before it would have refilled on its own hands the key a free
   * budget. The per-IP session-mint bucket (20 tokens refilling at 20/hour)
   * takes a full hour to recover, so a flat half-hour window let one address
   * mint 20 workspaces, idle 31 minutes, and mint 20 more — about double the
   * documented cap. So: never evict sooner than a full refill would take.
   * (A bucket with no refill at all can only be reset by eviction, hence the
   * 24-hour ceiling rather than keeping it forever.)
   */
  private readonly staleAfterMs: number;
  private lastSweep = Date.now();

  constructor(private readonly spec: BucketSpec) {
    const fullRefillMs = spec.refillPerSec > 0 ? (spec.capacity / spec.refillPerSec) * 1000 : Infinity;
    this.staleAfterMs = Math.min(24 * 60 * 60 * 1000, Math.max(30 * 60 * 1000, fullRefillMs));
  }

  /** Spend one token for `key`. Returns `undefined` when the request is
   *  allowed, or the number of whole seconds until the next token is
   *  available (at least 1) when it is not. */
  take(key: string, now = Date.now()): number | undefined {
    if (now - this.lastSweep > this.staleAfterMs) {
      this.lastSweep = now;
      for (const [k, b] of this.buckets) {
        if (now - b.last > this.staleAfterMs) this.buckets.delete(k);
      }
    }

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.spec.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = Math.max(0, (now - b.last) / 1000);
      b.tokens = Math.min(this.spec.capacity, b.tokens + elapsedSec * this.spec.refillPerSec);
      b.last = now;
    }

    if (b.tokens < 1) return retryAfterSeconds(1 - b.tokens, this.spec.refillPerSec);
    b.tokens -= 1;
    return undefined;
  }
}

/** How long until `deficit` tokens have refilled, in whole seconds, never
 *  below 1 and never an absurd (or infinite, when refill is 0) wait. */
function retryAfterSeconds(deficit: number, refillPerSec: number): number {
  if (refillPerSec <= 0) return 60;
  return Math.max(1, Math.min(3600, Math.ceil(deficit / refillPerSec)));
}

export interface RateLimitOptions extends BucketSpec {
  /** Which tier this is — reported in the bucket key so a debugger dump says
   *  what a key belongs to. */
  name: string;
  /** How a request is attributed to a bucket. Default: the VERIFIED session
   *  id, else the caller's IP — see `defaultRateLimitKey`. Returning
   *  `undefined` falls back to that default. */
  keyFn?: (req: Request) => string | undefined;
}

/** The tiers from spec §2. `api` is the whole-surface budget; `chat` and
 *  `heavy` sit on top of it for the endpoints that cost real money (an
 *  Anthropic turn) or real CPU (a PrusaSlicer run). */
export const LIMITS = {
  api: { name: "api", capacity: 60, refillPerSec: 5 },
  chat: { name: "chat", capacity: 6, refillPerSec: 1 / 20 },
  heavy: { name: "heavy", capacity: 10, refillPerSec: 1 / 10 },
} as const;

/**
 * The caller's address, as an identity worth rate-limiting on.
 *
 * `req.ip` is only the real client when Express has been told to trust the
 * proxy in front of it — otherwise it is whatever the caller wrote in
 * `X-Forwarded-For`, which would let anyone mint an unlimited number of
 * distinct rate-limit keys. So the forwarded chain is consulted ONLY when the
 * operator has explicitly opted in with `SLICELY_TRUST_PROXY=1` (which
 * index.ts passes to `app.set("trust proxy", …)` as well, from this same
 * variable). Otherwise: the socket's peer address, which nobody can forge.
 */
export function clientIp(req: Request): string {
  if (process.env.SLICELY_TRUST_PROXY === "1") {
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** A tiny in-memory token-bucket limiter (no new dependency). Returns 429
 *  with a `Retry-After` header once a key's bucket is empty. */
export function rateLimiter(opts: RateLimitOptions): RequestHandler {
  const keyFn = opts.keyFn ?? defaultRateLimitKey;
  const buckets = new TokenBuckets(opts);

  return (req, res, next) => {
    const key = keyFn(req) ?? defaultRateLimitKey(req);
    const retryAfter = buckets.take(`${opts.name}:${key}`);
    if (retryAfter === undefined) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests — slow down a little.", code: "rate_limited" });
  };
}

/**
 * What a router factory accepts so index.ts can decide which tier its
 * expensive routes belong to. The handler is INJECTED rather than built inside
 * the factory for two reasons: the tiers are defined in exactly one place
 * (index.ts, from `LIMITS`), and a test that drives one router directly can
 * hand it `noLimit` instead of tripping over a budget it doesn't care about.
 */
export interface RouteLimitOptions {
  limit?: RequestHandler;
}

/** The "no tier applied" middleware — the default when a factory is called
 *  without a limiter (tests, and the Electron desktop app's single user). */
export const noLimit: RequestHandler = (_req, _res, next) => next();

/**
 * The bucket a request belongs to: its session if — and only if — the client
 * PROVED it holds a cookie this server issued, otherwise its IP address.
 *
 * This used to read the raw `slicely_sid` cookie string straight off the
 * header, which made the limiter worthless: any client could write itself a
 * fresh random cookie value before every request and get a fresh, full bucket
 * each time. `sessionMiddleware` (mounted immediately before this, on the
 * `/api` router) verifies the cookie's HMAC and hangs the record on
 * `req.session`, so this only has to read that.
 *
 * A request that arrives with no valid cookie has a session MINTED for it on
 * the way in. That brand-new id must not be used as the key either — it is
 * just as attacker-controlled as a forged cookie was, since dropping the
 * cookie is enough to get a new one. `req.sessionMinted` marks those, and they
 * are charged to the caller's IP instead.
 */
function defaultRateLimitKey(req: Request): string {
  const verifiedId = req.sessionMinted ? undefined : req.session?.id;
  if (verifiedId) return `sid:${verifiedId}`;
  return `ip:${clientIp(req)}`;
}
