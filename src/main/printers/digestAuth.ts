// Minimal HTTP Digest authentication (RFC 2617 / RFC 7616), MD5 + qop=auth
// only. PrusaLink is the only transport that needs this, and there is no
// digest-auth package in this project's dependency list — so this hand-rolls
// exactly the two facts that matter: parsing a WWW-Authenticate challenge and
// building the matching Authorization header. The hashing here is verified
// against RFC 2617's own worked example (Mufasa/testrealm@host.com), not
// against a live PrusaLink device — PrusaLink also accepts a plain X-Api-Key,
// which the prusalink driver prefers whenever the user supplies one.
import { createHash, randomBytes } from "node:crypto";

/** The parts of a `WWW-Authenticate: Digest ...` challenge Slicely needs. */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  /** Comma-separated list, e.g. "auth" or "auth,auth-int". Only "auth" is
   *  implemented; anything else falls back to the (obsolete) RFC 2069 form. */
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/**
 * Parse a `WWW-Authenticate` header value. Returns undefined when it isn't a
 * Digest challenge (absent, or a different scheme like Basic) or is missing
 * the two fields a challenge can't function without.
 */
export function parseDigestChallenge(header: string | null): DigestChallenge | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!/^Digest\s/i.test(trimmed)) return undefined;
  const rest = trimmed.replace(/^Digest\s+/i, "");

  // Values are comma-separated key=value pairs; quoted values may themselves
  // contain commas, so split with a regex instead of a naive .split(",").
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    params[m[1]] = m[2] !== undefined ? m[2] : m[3].trim();
  }

  if (!params.realm || !params.nonce) return undefined;
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
  };
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/**
 * Build the `Authorization: Digest ...` header for one request against a
 * given challenge. `uri` is the request-target (path + query, no scheme or
 * host — what actually goes on the HTTP request line), which must match
 * exactly what's sent or the server's hash check fails.
 *
 * nc/cnonce default to a fresh single-use pair, which is always correct (if
 * wasteful) — reusing nc across requests requires tracking per-challenge
 * state this module deliberately doesn't keep.
 */
export function buildDigestHeader(
  challenge: DigestChallenge,
  username: string,
  password: string,
  method: string,
  uri: string,
  nc = "00000001",
  cnonce: string = randomBytes(8).toString("hex"),
): string {
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  // Only "auth" qop is implemented (the mode every server we target actually
  // sends); an unlisted/empty qop falls back to RFC 2069's simpler digest.
  const qop = challenge.qop
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s === "auth");

  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);

  return `Digest ${parts.join(", ")}`;
}
