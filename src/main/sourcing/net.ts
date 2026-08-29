// Shared, low-level networking helpers for every source plugin plus the URL
// resolver and downloader. Centralized so three cross-cutting concerns stay
// consistent everywhere a request leaves the process:
//   1. An honest, identifying User-Agent — some sites soft-block generic
//      browser UAs on API paths, and it's simply the right thing to do.
//   2. A hard per-request timeout, so one slow/hanging source can't stall a
//      whole federated search (SearchOutcome.sources reports it as failed).
//   3. An SSRF guard — Slicely fetches URLs the USER pasted (resolveUrl) and
//      URLs third-party APIs hand back (file downloads). Neither is trusted
//      to be a public, non-internal address. See `assertPublicHttpUrl`.
//
// Dependency-free beyond Node builtins. No Electron.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** Sent on every outbound request. Honest per the legal/ethical constraint —
 *  never masquerade as a browser to get around a source's own rate limiting
 *  or bot detection. */
export const USER_AGENT =
  "Slicely/0.2 (+https://github.com/ishmael07/slicely; 3D-model sourcing agent)";

/** Per-request budget. A federated search fans out to many sources at once;
 *  this keeps one flaky source from blocking the rest. */
export const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Merge a caller-supplied AbortSignal with a timeout, without relying on
 * `AbortSignal.any` (Node 20.3+ only — Slicely targets Node 18+, per repo
 * rules). Aborting either input aborts the result.
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number = DEFAULT_TIMEOUT_MS,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;

  const controller = new AbortController();
  const abortFrom = (s: AbortSignal) => controller.abort(s.reason);
  if (signal.aborted) return signal;
  if (timeoutSignal.aborted) return timeoutSignal;
  signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  timeoutSignal.addEventListener("abort", () => abortFrom(timeoutSignal), {
    once: true,
  });
  return controller.signal;
}

// ── SSRF guard ────────────────────────────────────────────────────────────
// Verified 2026-08-27 by direct testing of the ranges below (loopback,
// RFC1918, link-local, IPv6 loopback/unique-local/link-local, and the
// "localhost"/".local" hostname forms called out in the spec).

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === "::1" || norm === "::") return true;
  if (norm.startsWith("::ffff:")) {
    const mapped = norm.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  if (norm.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(norm)) return true; // fc00::/7 unique-local
  return false;
}

/** Pure, synchronous check against a hostname or IP literal. Exported so
 *  tests (and the resolver) can check it directly without a DNS round-trip. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const version = isIP(h);
  if (version === 4) return isPrivateIPv4(h);
  if (version === 6) return isPrivateIPv6(h);
  return false; // a real hostname — DNS-checked by assertPublicHttpUrl
}

/**
 * Throws unless `raw` is an http(s) URL that does not point at a private,
 * loopback, or link-local address. For a plain hostname (not an IP literal)
 * this also resolves it and checks the resulting address, so a hostname that
 * DNS-rebinds to an internal IP is rejected too — best-effort: a DNS failure
 * here is not itself a reason to block (the subsequent fetch will fail on its
 * own), it's only a positive private-IP match that blocks.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme "${url.protocol}" — only http/https are allowed.`,
    );
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(
      `Refusing to fetch a private/loopback address: ${url.hostname}`,
    );
  }
  if (isIP(url.hostname) === 0) {
    try {
      const { address } = await dnsLookup(url.hostname);
      if (isPrivateHost(address)) {
        throw new Error(
          `Refusing to fetch ${url.hostname} — it resolves to a private address (${address}).`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing to fetch")) {
        throw err;
      }
      // DNS lookup itself failed (offline, NXDOMAIN, sandboxed test env) —
      // not a private-address match, so let the real fetch fail naturally.
    }
  }
  return url;
}

/** fetch() with the standard UA, timeout, and SSRF guard applied. Use this
 *  (not bare `fetch`) for anything hitting a URL that isn't a hardcoded,
 *  known-public API host. */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  await assertPublicHttpUrl(url);
  return fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    signal: withTimeout(init.signal as AbortSignal | undefined, timeoutMs),
  });
}

/** Plain fetch with the standard UA + timeout, WITHOUT the SSRF guard — for
 *  hardcoded, trusted, known-public API hosts (e.g. `api.github.com`) where
 *  the guard's DNS round-trip is pure overhead. Never use this for a URL that
 *  came from user input or a third-party API response. */
export async function fetchWithUA(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    signal: withTimeout(init.signal as AbortSignal | undefined, timeoutMs),
  });
}

/** Read a response body defensively for error messages — never throws. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

/** GET JSON with the standard UA/timeout, throwing a descriptive error on a
 *  non-2xx response instead of an opaque JSON parse failure. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetchWithUA(url, init, timeoutMs);
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${await safeText(res)}`);
  }
  return (await res.json()) as T;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Fetch just the first `maxBytes` of a URL's body (via a Range request, so a
 * cooperative server sends only that much) for magic-byte/type sniffing
 * without downloading the whole file. A server that ignores Range will still
 * send its full body over the wire — the reader is cancelled as soon as
 * enough bytes are collected, which stops us reading further, but does not
 * refund bandwidth already in flight. Fine for resolveUrl's "what is this?"
 * check; never use this to decide whether a huge file is safe to download.
 */
export async function peekBytes(
  url: string,
  maxBytes = 512,
): Promise<{ res: Response; head: Buffer }> {
  const res = await guardedFetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
  if (!res.body) return { res, head: Buffer.alloc(0) };

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { res, head: Buffer.concat(chunks).subarray(0, maxBytes) };
}

/**
 * Are the scraped meta-search engines enabled?
 *
 * Thangs, Yeggi, and STLfinder all sit behind bot protection that refuses an
 * honestly-identified request, so in practice they return nothing. Measured on
 * a real search: Yeggi alone spent 10,003ms of a 10,265ms search timing out,
 * while every source that actually works finished inside 1.7 seconds. Leaving
 * them on costs eight seconds of dead time per search and produces a row of
 * failures the user can do nothing about.
 *
 * They stay in the codebase because the block is theirs, not ours, and may
 * lift. Set SLICELY_ENABLE_SCRAPERS=1 to try them again.
 */
export function scrapersEnabled(): boolean {
  const flag = (process.env.SLICELY_ENABLE_SCRAPERS ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
