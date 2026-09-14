// ─────────────────────────────────────────────────────────────────────────────
// The sealed note a sign-in carries with it.
//
// An OAuth redirect flow leaves our process entirely: we send the browser to
// Google or GitHub and it comes back minutes later on a fresh request with
// nothing but `?code` and `?state`. Everything the callback needs to finish the
// job — which provider it was, the `state` to compare, the PKCE verifier to
// prove we are the same client, the OIDC `nonce` to bind the id_token to this
// request, and where the user was standing when they started — has to travel
// with the browser and come back intact.
//
// TWO decisions here are load-bearing, and both are the kind a later reader
// "tidies" into a hole:
//
//  • THE COOKIE IS ENCRYPTED, NOT MERELY SIGNED. The PKCE verifier is a secret:
//    anyone who can read it can complete an authorization code they intercepted.
//    A signed-but-readable cookie would publish it. `keyvault.ts` already gives
//    us AES-256-GCM under SLICELY_MASTER_KEY, which also means a tampered or
//    foreign-key cookie fails loudly instead of decoding to garbage.
//
//  • SameSite=Lax, NOT Strict. The callback is a top-level cross-site GET (the
//    provider navigates the browser to us). A `Strict` cookie is NOT sent on
//    that navigation, so the callback would arrive with nothing to compare and
//    every sign-in would fail. `Lax` is sent on top-level navigations and is
//    the same reasoning that already applies to the session cookie.
//
// The note is short-lived (10 minutes) and single-use: the callback clears it
// before it does anything else, whatever the outcome.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { decryptSecret, encryptSecret } from "../../main/keyvault";
import { readCookie } from "../session";

/** `__Host-` is not decoration: a browser refuses to store the cookie unless it
 *  is Secure with `Path=/` and no `Domain`, so no neighbouring subdomain can
 *  set a sign-in state for us. Same reasoning as the session cookie. */
export const OAUTH_COOKIE = "__Host-slicely_oauth";

/** How long a half-finished sign-in stays valid. Long enough to create a Google
 *  account mid-flow, short enough that a stolen cookie is worthless by the time
 *  anyone finds it. */
export const OAUTH_TTL_MS = 10 * 60_000;

/** The longest `return_to` we will carry. A path on our own site; anything
 *  longer is not a page, it is someone probing. */
const MAX_RETURN_TO = 512;

/** The base the URL parser resolves a relative `return_to` against. An origin
 *  that cannot exist, so "same origin as the placeholder" means "the input
 *  named no origin of its own". */
const PLACEHOLDER = "http://placeholder.invalid";

export interface OauthState {
  provider: string;
  /** 32 random bytes, base64url. Compared with the provider's echo. */
  state: string;
  /** 64 random bytes, base64url — PKCE, unused by GitHub (see github.ts). */
  verifier: string;
  /** 16 random bytes, base64url. OIDC binds the id_token to it. */
  nonce: string;
  /** Already passed through `safeReturnTo`, so it is a path on this site. */
  returnTo: string;
  exp: number;
}

/** The on-the-wire shape inside the cookie. Short keys because the whole thing
 *  is encrypted, base64'd and then percent-encoded into a header. */
interface StateBlob {
  p: string;
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  exp: number;
}

/** `base64url(sha256(verifier))`, unpadded — RFC 7636's S256 transform. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The whole open-redirect defence, and it is four rules.
 *
 * DO NOT "SIMPLIFY" THIS. Each rule catches a family the others miss:
 *
 *  1. Not a short, plain string → `/`. A 600-character "path" is a probe.
 *  2. A control character (`\x00`–`\x1f`, `\x7f`) → `/`. This MUST come before
 *     parsing, because the URL parser silently STRIPS tabs and newlines:
 *     `"/\t/evil.example"` parses to the harmless-looking `/evil.example`, and
 *     a checker that parsed first would be reading different bytes than the
 *     browser was handed.
 *  3. Must begin with a single `/` → `/`. This is what turns
 *     `"%2f%2fevil.example"` (which parses to a perfectly same-origin path) and
 *     `"javascript:…"` away before any of it matters.
 *  4. One origin comparison after parsing. The URL parser has already
 *     normalised every backslash, percent-encoding and scheme trick — `//evil`,
 *     `/\evil`, `http:/\/\evil` all resolve to an origin that is not the
 *     placeholder's — so this single `!==` kills the entire family.
 *
 * What we emit is rebuilt FROM THE PARSE (`pathname + search + hash`), never
 * the caller's bytes, and re-checked for a leading `//` — because `/\evil` is
 * the one input the parser would otherwise hand back as the protocol-relative
 * `//evil`, which a `Location:` header treats as another site.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER);
  } catch {
    return "/";
  }
  if (url.origin !== PLACEHOLDER) return "/";
  const out = url.pathname + url.search + url.hash;
  if (!out.startsWith("/") || out.startsWith("//")) return "/";
  return out;
}

/** Compare two `state` values without leaking where they first differ, and
 *  without throwing on a wrong length (`timingSafeEqual` does). A non-string,
 *  a missing value and a different length are all simply "no". */
export function statesMatch(a: string, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/** Mint a fresh state, seal it into the cookie on `res`, and hand it back so
 *  the caller can build the authorize URL from the same values. */
export function startOauthState(res: Response, provider: string, returnTo: unknown): OauthState {
  const state: OauthState = {
    provider,
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(64).toString("base64url"),
    nonce: randomBytes(16).toString("base64url"),
    returnTo: safeReturnTo(returnTo),
    exp: Date.now() + OAUTH_TTL_MS,
  };
  const blob: StateBlob = {
    p: state.provider,
    state: state.state,
    verifier: state.verifier,
    nonce: state.nonce,
    returnTo: state.returnTo,
    exp: state.exp,
  };
  // `append`, not `setHeader`: the session middleware has very likely already
  // written its own Set-Cookie on this response, and a start that logged the
  // visitor out of the workspace they were standing in would be worse than no
  // sign-in at all.
  res.append("Set-Cookie", cookie(encryptSecret(JSON.stringify(blob)), OAUTH_TTL_MS));
  return state;
}

/** The state `req`'s cookie carries, or `undefined` for missing, undecryptable,
 *  malformed or expired — every one of which the callback answers identically,
 *  so none of them may throw. */
export function readOauthState(req: Request): OauthState | undefined {
  const raw = readCookie(req.headers.cookie, OAUTH_COOKIE);
  if (!raw) return undefined;
  let blob: StateBlob;
  try {
    blob = JSON.parse(decryptSecret(raw)) as StateBlob;
  } catch {
    return undefined;
  }
  if (!blob || typeof blob !== "object") return undefined;
  const { p, state, verifier, nonce, returnTo, exp } = blob;
  if (typeof p !== "string" || typeof state !== "string" || typeof verifier !== "string") return undefined;
  if (typeof nonce !== "string" || typeof returnTo !== "string" || typeof exp !== "number") return undefined;
  if (!(exp > Date.now())) return undefined;
  return { provider: p, state, verifier, nonce, returnTo: safeReturnTo(returnTo), exp };
}

/** Expire the cookie. The attributes must match the ones it was SET with, or a
 *  browser treats this as a different cookie and leaves the original in place —
 *  and a `__Host-` cookie without Secure is refused outright. */
export function clearOauthState(res: Response): void {
  res.append("Set-Cookie", cookie("", 0));
}

function cookie(value: string, maxAgeMs: number): string {
  return [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    // Always Secure: this cookie only exists in hosted mode, which is always
    // behind TLS, and `__Host-` would be refused without it.
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].join("; ");
}
