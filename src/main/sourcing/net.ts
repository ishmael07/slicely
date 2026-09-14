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
// "localhost"/".local" hostname forms called out in the spec), and widened in
// Task D3 to the ranges an SSRF probe actually reaches for once RFC1918 is
// closed: carrier-grade NAT, the IETF protocol/benchmark blocks, multicast,
// and the reserved 240/4 space.
//
// THREE separate holes are closed here, and all three matter together — any
// one left open makes the other two decorative:
//   1. REDIRECTS. A public URL that answers "302 Location:
//      http://169.254.169.254/latest/meta-data/" walks straight past a guard
//      that only ever looks at the URL the user pasted. `guardedFetch` follows
//      redirects ITSELF (redirect: "manual") and re-runs the full check on
//      every hop.
//   2. EVERY DNS RECORD, AND A FAILED LOOKUP. A name with two A records — one
//      public, one internal — passed a guard that checked only the first
//      address. And a lookup that fails tells us nothing about where the name
//      points, so it is a refusal, not a shrug.
//   3. PORTS AND NUMERIC HOSTS. Redis on 6379, Postgres on 5432 and friends are
//      reachable over HTTP-shaped requests; and "http://2130706433/" is
//      127.0.0.1 written as an integer, which `isIP` does not recognise as an
//      address at all.

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/** Ports an ordinary http(s) service — the only thing Slicely has business
 *  fetching — actually listens on. Anything else asked for by a URL we did not
 *  write is a port scan or a swing at an internal service. */
export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443] as const;

/** How many hops `guardedFetch` will follow before giving up. Real download
 *  chains (CDN → signed URL → storage bucket) use two or three. */
export const DEFAULT_MAX_REDIRECTS = 5;

function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return undefined;
  return parts;
}

/**
 * Expand an IPv6 literal to exactly eight numeric hextets, or undefined if it
 * isn't one. Handles the "::" run-of-zeros compressor and an embedded dotted
 * IPv4 tail ("::ffff:10.0.0.1"), which occupies the last two hextets.
 */
function ipv6Hextets(ip: string): number[] | undefined {
  let text = ip;
  const tail: number[] = [];

  // A dotted IPv4 tail is the last two hextets. Lop it off first so the rest is
  // plain hex groups.
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const parts = ipv4Parts(text.slice(lastColon + 1));
    if (!parts || parts.some((n) => n < 0 || n > 255)) return undefined;
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
    text = text.slice(0, lastColon);
    // "::1.2.3.4" leaves ":" behind — put the compressor back together.
    if (text.endsWith(":")) text += ":";
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (s: string): number[] | undefined => {
    if (s === "") return [];
    const out: number[] = [];
    for (const piece of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return undefined;

  const explicit = left.length + right.length + tail.length;
  if (halves.length === 1) return explicit === 8 ? [...left, ...tail] : undefined;
  if (explicit > 7) return undefined; // "::" must stand for at least one hextet
  return [...left, ...new Array(8 - explicit).fill(0), ...right, ...tail];
}

/**
 * Reduce an IP literal to the ONE spelling the range checks below understand.
 *
 * This exists because of a bypass that is invisible if you only ever test the
 * readable spellings: WHATWG URL serialises an IPv4-mapped IPv6 address in HEX.
 * `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`, and
 * `[0:0:0:0:0:ffff:169.254.169.254]` arrives as `[::ffff:a9fe:a9fe]` — the
 * cloud metadata address, wearing a hat. A check that only recognises the
 * dotted `::ffff:10.0.0.1` form lets every one of those straight through, and
 * the socket layer then dials the IPv4 address they mean.
 *
 * So: brackets and any zone id come off, the address is expanded to eight
 * hextets, and if it carries an IPv4 address INSIDE it, that IPv4 address is
 * what comes back. Four families do:
 *
 *   • `::ffff:0:0/96` IPv4-mapped     — the WHATWG hex spelling above.
 *   • `::/96` IPv4-compatible         — deprecated, still routed.
 *   • `64:ff9b::/96` NAT64            — the well-known prefix an IPv6-only host
 *     uses to reach IPv4. `64:ff9b::7f00:1` IS 127.0.0.1 to any NAT64 gateway on
 *     the path, and nothing in the v6 range checks would have noticed.
 *   • `2002::/16` 6to4                — the IPv4 address sits in hextets 1–2, so
 *     `2002:7f00:1::1` is a 6to4 tunnel to 127.0.0.1. Folding is unconditional
 *     and that is correct in both directions: the embedded address decides.
 *     `2002:808:808::1` folds to the perfectly public 8.8.8.8 and stays allowed.
 *
 * `::` and `::1` are left alone — they are IPv6 addresses in their own right,
 * handled by the v6 rules.
 *
 * Anything that isn't an IP literal is returned unchanged (lowercased and
 * de-bracketed), so callers can hand it a hostname safely. That includes
 * malformed near-IPv6 text (`:::1`, `1:2:3:4:5:6:7:8:9`): it comes back verbatim
 * rather than throwing, and it is not a hole, because nothing can ever dial it —
 * `isIP` rejects it (so the range checks answer "not an address"), and
 * `new URL()` refuses to parse it as a host, so it cannot become a socket
 * target by any route that reaches this function.
 */
export function normalizeIp(ip: string): string {
  const bare = (ip ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/%.*$/, ""); // drop any zone id
  if (isIP(bare) !== 6) return bare;

  const h = ipv6Hextets(bare);
  if (!h) return bare;
  // 6to4: 2002:WWXX:YYZZ::/48 embeds the IPv4 address in hextets 1 and 2.
  if (h[0] === 0x2002) return dotted(h[1], h[2]);
  // NAT64's well-known prefix: 64:ff9b::/96, IPv4 in the last two hextets.
  if (h[0] === 0x0064 && h[1] === 0xff9b && !h[2] && !h[3] && !h[4] && !h[5]) {
    return dotted(h[6], h[7]);
  }
  if (h[0] || h[1] || h[2] || h[3] || h[4]) return bare; // not in ::/96 or ::ffff:0:0/96
  const mapped = h[5] === 0xffff;
  // ::/96 minus :: and ::1 themselves, which are IPv6 loopback/unspecified.
  const compat = h[5] === 0 && !(h[6] === 0 && (h[7] === 0 || h[7] === 1));
  if (!mapped && !compat) return bare;
  return dotted(h[6], h[7]);
}

/** Two hextets as the dotted IPv4 address they encode. */
function dotted(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Addresses that are never a place on the public internet AND are never a
 * device on someone's LAN either: they name this very machine, the local link,
 * or a group. Split out from `isPrivateAddress` because the printer guard
 * (printers/util.ts) has to allow LAN addresses — that is where printers live —
 * while still refusing these.
 */
export function isLocalOrLinkLocalAddress(ip: string): boolean {
  const norm = normalizeIp(ip);
  const version = isIP(norm);
  if (version === 4) {
    const parts = ipv4Parts(norm);
    if (!parts) return false;
    const [a, b] = parts;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }
  if (version !== 6) return false;
  const h = ipv6Hextets(norm);
  if (!h) return false;
  // :: (unspecified) and ::1 (loopback), in every spelling including the
  // fully-written-out "0:0:0:0:0:0:0:1".
  if (h.slice(0, 7).every((g) => g === 0) && (h[7] === 0 || h[7] === 1)) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Is this IP LITERAL somewhere a request must not go? Loopback, RFC1918,
 * link-local, unique-local, and — added in Task D3 — carrier-grade NAT
 * (100.64/10), the IETF protocol assignments and documentation blocks
 * (192.0.0/24, 192.0.2/24), the benchmark range (198.18/15), multicast
 * (224/4) and the reserved 240/4.
 *
 * Hostnames are NOT handled here (they have no range) — `isPrivateHost` does
 * the hostname forms and `assertPublicHttpUrl` does the DNS resolution.
 * Exported for the printer host guard in printers/util.ts, which applies the
 * same ranges in hosted mode.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isLocalOrLinkLocalAddress(ip)) return true;
  const norm = normalizeIp(ip);
  const version = isIP(norm);
  if (version === 4) {
    const parts = ipv4Parts(norm);
    if (!parts) return false;
    const [a, b, c] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 documentation
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    return false;
  }
  if (version !== 6) return false;
  const h = ipv6Hextets(norm);
  if (!h) return false;
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Drop the DNS root label(s) from the end of a hostname.
 *
 * `localhost.` is the fully-qualified spelling of `localhost`, and resolvers
 * treat the two identically — as they do `localhost..`, which `new URL()` also
 * accepts. String comparisons do not, so every allow/deny list that matches a
 * hostname has to compare against the form with the dots removed, or the dotted
 * spelling walks past it.
 */
function stripRootDots(host: string): string {
  return host.replace(/\.+$/, "");
}

/**
 * A hostname reduced to the form the string rules below compare against: lower
 * case, root label(s) gone, IPv6 brackets gone.
 *
 * The ORDER matters, and it is the reverse of the obvious one. Strip the dots
 * FIRST: in `[::1].` the closing bracket is not the last character, so a
 * bracket-stripper run first leaves `::1].`, and the later dot-strip leaves
 * `::1]` — which `isIP` does not recognise, so the loopback literal sails
 * through as "a real hostname" and goes to DNS. Dots first, then brackets, and
 * every spelling of the same host arrives here as the same string.
 */
function canonicalHost(hostname: string): string {
  return stripRootDots(hostname.toLowerCase()).replace(/^\[|\]$/g, "");
}

/** Pure, synchronous check against a hostname or IP literal. Exported so
 *  tests (and the resolver) can check it directly without a DNS round-trip. */
export function isPrivateHost(hostname: string): boolean {
  const h = canonicalHost(hostname);
  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const version = isIP(h);
  if (version !== 0) return isPrivateAddress(h);
  return false; // a real hostname — DNS-checked by assertPublicHttpUrl
}

export interface UrlGuardOptions {
  /** Ports the URL may name. Defaults to `DEFAULT_ALLOWED_PORTS`. */
  allowedPorts?: number[];
  /** Resolve a hostname to EVERY address it has. Injectable so tests never
   *  touch real DNS; defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: (host: string) => Promise<string[]>;
  /** An extra, caller-specific predicate applied to every hop — the thumbnail
   *  proxy uses it to keep its host allowlist (and its https-only rule) in
   *  force on redirect targets, not just on the URL it was handed. */
  allow?: (url: URL) => boolean;
}

/** Every address a hostname resolves to, via the real resolver. */
async function resolveAll(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Throws unless `raw` is an http(s) URL, on an ordinary http(s) port, that does
 * not point at a private, loopback, link-local, or otherwise non-public
 * address — checking EVERY address the hostname resolves to, not just the
 * first.
 *
 * A DNS failure BLOCKS (changed in Task D3). The old behaviour let it through
 * on the theory that the subsequent fetch would fail anyway, but that is only
 * true when the failure is genuine: a resolver that answers differently for
 * two consecutive queries turns "we couldn't check" into "we didn't check".
 * A name we cannot verify is a name we do not fetch.
 */
export async function assertPublicHttpUrl(raw: string, opts: UrlGuardOptions = {}): Promise<URL> {
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
  if (opts.allow && !opts.allow(url)) {
    throw new Error(`Refusing to fetch ${url.hostname} — not an allowed host for this request.`);
  }

  // The trailing dot comes off BEFORE any check. `http://localhost./x` and
  // `http://localhost../x` both parse, both name the loopback host to every
  // resolver on earth, and neither is `"localhost"` as a string — so the
  // hostname rules below (and PRIVATE_HOSTNAMES in particular) used to miss
  // them, and the guard fell through to a DNS lookup for a name it should have
  // refused outright. See `canonicalHost`, which also explains why the dots
  // come off before the IPv6 brackets and not after.
  const host = canonicalHost(url.hostname);
  // A host made only of digits and dots is an IP address written so that
  // `isIP` does not recognise it — "http://2130706433/" and "http://0177.1/"
  // are both 127.0.0.1 — while the socket layer dials it happily. In practice
  // the WHATWG URL parser canonicalises every such form to a real IPv4 literal
  // before it reaches here (verified: 2130706433, 0x7f000001 and 0177.1 all
  // arrive as "127.0.0.1", and 1.2.3.4.5 fails to parse at all), so this is a
  // belt for a host that arrives from anywhere but `new URL`.
  //
  // Deliberately NOT also refusing a leading "0x": the hex spellings are
  // canonicalised by the same parser, so the rule would buy nothing and would
  // block the real, public file host `0x0.st`.
  if (isIP(host) === 0 && /^[0-9.]+$/.test(host)) {
    throw new Error(`Refusing to fetch a numeric host: ${url.hostname}`);
  }
  if (isPrivateHost(host)) {
    throw new Error(
      `Refusing to fetch a private/loopback address: ${url.hostname}`,
    );
  }

  const allowedPorts = opts.allowedPorts ?? [...DEFAULT_ALLOWED_PORTS];
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new Error(`Refusing to fetch ${url.hostname} on port ${port} — not an http(s) port.`);
  }

  if (isIP(host) === 0) {
    const lookup = opts.lookup ?? resolveAll;
    let addresses: string[];
    try {
      addresses = await lookup(host);
    } catch {
      throw new Error(`Refusing to fetch ${url.hostname} — its address could not be resolved.`);
    }
    if (addresses.length === 0) {
      throw new Error(`Refusing to fetch ${url.hostname} — its address could not be resolved.`);
    }
    const bad = addresses.find((a) => isPrivateAddress(a));
    if (bad !== undefined) {
      throw new Error(
        `Refusing to fetch ${url.hostname} — it resolves to a private address (${bad}).`,
      );
    }
  }
  return url;
}

/** Extra knobs `guardedFetch` understands on top of a plain RequestInit. */
export interface GuardedFetchInit extends RequestInit {
  /** Hops to follow before giving up. Defaults to `DEFAULT_MAX_REDIRECTS`. */
  maxRedirects?: number;
  /** Passed to `assertPublicHttpUrl` on every hop. */
  guard?: UrlGuardOptions;
  /** TESTS ONLY: stand in for global fetch, so the redirect loop can be driven
   *  without a server (and without a real socket) on the other end. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch() with the standard UA, timeout, and SSRF guard applied. Use this
 * (not bare `fetch`) for anything hitting a URL that isn't a hardcoded,
 * known-public API host.
 *
 * Redirects are followed HERE rather than by fetch, because fetch's own
 * `redirect: "follow"` does the whole chain inside one call and hands back only
 * the final response — the guard never sees the intermediate hops, which is
 * exactly where an attacker puts the internal address. Every hop is re-checked
 * from scratch.
 */
export async function guardedFetch(
  url: string,
  init: GuardedFetchInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, guard, fetchImpl, ...rest } = init;
  const doFetch = fetchImpl ?? fetch;
  // One budget for the whole chain, so a redirect loop can't buy extra time.
  const signal = withTimeout(rest.signal as AbortSignal | undefined, timeoutMs);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...(rest.headers as Record<string, string> | undefined),
  };

  let current = url;
  let method = (rest.method ?? "GET").toUpperCase();
  let body = rest.body;
  let origin = "";

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await assertPublicHttpUrl(current, guard);
    if (origin && target.origin !== origin) {
      // Credentials belong to the host they were issued for; a redirect to
      // somewhere else must not carry them along.
      delete headers.Authorization;
      delete headers.authorization;
      delete headers.Cookie;
      delete headers.cookie;
    }
    origin = target.origin;

    const res = await doFetch(current, { ...rest, method, body, headers, signal, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;

    // Nobody will ever read a 3xx body, and an un-read body holds the socket
    // open until the agent times it out. Cancelling is best-effort: a body that
    // is already disturbed or absent throws, and that is not a fetch failure.
    try {
      await res.body?.cancel();
    } catch {
      /* nothing to release */
    }

    const next = new URL(location, current);
    if (target.protocol === "https:" && next.protocol !== "https:") {
      // A chain that starts encrypted must stay encrypted. Otherwise a hop can
      // move the rest of the download onto plaintext — visible and rewritable
      // by anything on the path — which is a downgrade we get no say in later.
      throw new Error(
        `Refusing to follow a redirect from https to ${next.protocol} (${next.hostname}) — a downgraded hop is blocked.`,
      );
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      // What every client does in practice, and what the spec allows: the
      // redirected request becomes a bodiless GET.
      method = "GET";
      body = undefined;
    }
    current = next.toString();
  }
  throw new Error(`Too many redirects (more than ${maxRedirects}) starting at ${url}`);
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
