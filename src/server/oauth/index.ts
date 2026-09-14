// ─────────────────────────────────────────────────────────────────────────────
// The provider seam: two OAuth providers behind one four-method interface, and
// one injectable `fetch` so no test ever reaches Google or GitHub.
//
// A provider does exactly four things and knows nothing about Express, sessions,
// accounts or metering:
//
//   configured()    — are its two secrets and our public URL set?
//   authorizeUrl()  — where do we send the browser?
//   profile()       — turn a `code` into a verified email, and keep nothing else.
//   id / label      — what the sign-in button says.
//
// EVERY OUTBOUND URL IS A CONSTANT IN THIS DIRECTORY. Nothing a visitor sends
// ever becomes part of one, which is why these calls go through `fetchWithUA`
// (a fixed UA and a timeout) rather than sourcing/net.ts's SSRF-guarding
// `guardedFetch`: the guard exists for URLs that came from user input or a
// third-party response, and its DNS round-trip would be pure overhead against
// two hardcoded, known-public hosts.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchWithUA } from "../../main/sourcing/net";
import type { SigninProvider } from "../../shared/types";
import type { OauthState } from "./state";
import { googleProvider } from "./google";
import { githubProvider } from "./github";
import { getConfig } from "../../main/config";

/** The one function a provider needs from the outside world. Injected in tests;
 *  production gets `fetchWithUA`. */
export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface OauthConfig {
  /** Injected in tests. Production passes nothing and the env is read. */
  providers?: OauthProvider[];
  http?: HttpFn;
}

/**
 * A sign-in that failed for a reason the visitor can act on.
 *
 * The `code` is one of the two the callback can turn into a fragment the client
 * renders as a sentence. The `message` is for the SERVER LOG only — it never
 * reaches a response body, so it may name what went wrong, but (see google.ts
 * and github.ts) it must still never carry a secret or an upstream body, because
 * logs get pasted into issues.
 */
export class OauthError extends Error {
  constructor(
    readonly code: "oauth_failed" | "email_unverified",
    message: string,
  ) {
    super(message);
    this.name = "OauthError";
  }
}

export interface OauthProvider {
  readonly id: "google" | "github";
  readonly label: string;
  /** True when the client id, the secret and SLICELY_PUBLIC_URL are all set. */
  configured(): boolean;
  /** The full authorize URL to 302 to. */
  authorizeUrl(state: OauthState): string;
  /** Exchange + profile read. MUST NOT persist or log any token. */
  profile(code: string, state: OauthState, http: HttpFn): Promise<RawProfile>;
}

/** What a provider hands back — and all it hands back. No access token, no
 *  id_token, no avatar URL, nothing refreshable. */
export interface RawProfile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** Fixed, in UI order. `signinProviders` in /api/config reads the same list, so
 *  the two buttons can never come back in a different order between renders. */
const ALL_PROVIDERS: readonly OauthProvider[] = [googleProvider, githubProvider];

/**
 * Where the provider sends the browser back to.
 *
 * Built from `SLICELY_PUBLIC_URL` and NEVER from the `Host` header: a spoofed
 * Host would otherwise move the callback to somebody else's server, carrying the
 * authorization code with it. Both providers also pin this value server-side, so
 * a mismatch is a hard failure at the provider rather than a quiet redirect.
 */
export function redirectUri(providerId: string): string {
  return `${getConfig().publicUrl.replace(/\/+$/, "")}/auth/${providerId}/callback`;
}

/** The providers this deployment can actually offer, in UI order. A test passes
 *  `providers` to get a fake instead — and a fake is used AS GIVEN, without the
 *  `configured()` filter, so a test need not fake the env too. */
export function configuredProviders(cfg: OauthConfig = {}): OauthProvider[] {
  if (cfg.providers) return [...cfg.providers];
  return ALL_PROVIDERS.filter((p) => p.configured());
}

/** The same list, in the shape `/api/config` publishes (Task A7 owns the field;
 *  this is the function it calls). */
export function signInProviders(cfg: OauthConfig = {}): SigninProvider[] {
  return configuredProviders(cfg).map((p) => ({ id: p.id, label: p.label }));
}

/** The provider for a `:provider` path segment, or `undefined` — which the route
 *  answers 404, identically for "unknown" and "not configured here". */
export function providerFor(id: unknown, cfg: OauthConfig = {}): OauthProvider | undefined {
  if (typeof id !== "string") return undefined;
  return configuredProviders(cfg).find((p) => p.id === id);
}

/** The `HttpFn` to hand a provider. */
export function httpFor(cfg: OauthConfig = {}): HttpFn {
  return cfg.http ?? ((url, init) => fetchWithUA(url, init ?? {}, OAUTH_TIMEOUT_MS));
}

/** An OAuth token exchange is one small POST to a healthy CDN-fronted endpoint.
 *  Ten seconds is generous; the visitor is staring at a blank redirect. */
export const OAUTH_TIMEOUT_MS = 10_000;

/** Read an OAuth env var fresh, so a secret rotated on the host takes effect on
 *  restart without a cache to invalidate. Shared by both providers. */
export function oauthEnv(name: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : "";
}
