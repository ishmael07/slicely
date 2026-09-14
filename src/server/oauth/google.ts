// ─────────────────────────────────────────────────────────────────────────────
// Continue with Google — OIDC authorization code flow with PKCE (S256).
//
// WHY THE id_token SIGNATURE IS NOT VERIFIED, deliberately and not as an
// oversight: this token did not arrive from a browser. It came back in the body
// of OUR OWN server-to-server TLS request to `oauth2.googleapis.com/token`,
// authenticated with our client secret and our PKCE verifier. OpenID Connect
// Core §3.1.3.7 item 6 explicitly allows TLS server validation to stand in for
// signature validation in exactly this case, and taking it removes a JWKS fetch,
// a key cache and a key-rotation failure mode from the sign-in path.
//
// What that leaves us owing is the CLAIM checks the signature would otherwise
// have been protecting, and all five are here:
//
//   iss   — one of the two spellings Google uses, compared exactly (never a
//           suffix match, or `accounts.google.com.attacker.test` would pass)
//   aud   — our own client id, so a token minted for another app is refused
//   exp   — still in the future
//   nonce — equal to the one sealed in this sign-in's cookie, which is what
//           binds the token to THIS request rather than a replayed one
//   email_verified — strictly `true`; Google's own id_token carries a JSON
//           boolean, so the string "true" is refused along with "false"
//
// NOTHING IS KEPT. `access_token` is never read out of the response. The
// id_token is parsed into four fields and dropped with the rest of the body.
// ─────────────────────────────────────────────────────────────────────────────
import { OauthError, oauthEnv, redirectUri, type HttpFn, type OauthProvider, type RawProfile } from "./index";
import { publicUrl } from "./__stub";
import { pkceChallenge, type OauthState } from "./state";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The two spellings Google's own discovery document has used. An exact match
 *  against this pair — a `startsWith`/`endsWith` here would be the bug. */
const ACCEPTED_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

function clientId(): string {
  return oauthEnv("GOOGLE_CLIENT_ID");
}

function clientSecret(): string {
  return oauthEnv("GOOGLE_CLIENT_SECRET");
}

export const googleProvider: OauthProvider = {
  id: "google",
  label: "Google",

  configured(): boolean {
    return Boolean(clientId() && clientSecret() && publicUrl());
  },

  authorizeUrl(state: OauthState): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId(),
      redirect_uri: redirectUri("google"),
      scope: "openid email profile",
      state: state.state,
      nonce: state.nonce,
      code_challenge: pkceChallenge(state.verifier),
      code_challenge_method: "S256",
      // Always offer the account chooser: a shared browser must not sign the
      // last person in again silently.
      prompt: "select_account",
      // We want no refresh token. Nothing here is refreshable by design.
      access_type: "online",
    });
    return `${AUTHORIZE_URL}?${q}`;
  },

  async profile(code: string, state: OauthState, http: HttpFn): Promise<RawProfile> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri("google"),
      client_id: clientId(),
      client_secret: clientSecret(),
      code_verifier: state.verifier,
    });

    let res: Response;
    try {
      res = await http(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // A DNS failure, a timeout, a reset socket. The visitor can only retry.
      throw new OauthError("oauth_failed", "Google's token endpoint could not be reached.");
    }
    if (!res.ok) {
      // The status and NOTHING ELSE. Google's error body echoes request
      // parameters — which include our client secret — and this message reaches
      // the server log.
      throw new OauthError("oauth_failed", `Google's token endpoint answered ${res.status}.`);
    }

    let payload: { id_token?: unknown };
    try {
      payload = (await res.json()) as { id_token?: unknown };
    } catch {
      throw new OauthError("oauth_failed", "Google's token endpoint answered with an unreadable body.");
    }
    // `access_token` is in there. It is never read: there is nothing we want
    // from Google's APIs, so holding one would be a liability with no upside.
    const claims = decodeJwtPayload(payload.id_token);

    if (!ACCEPTED_ISSUERS.has(str(claims.iss))) {
      throw new OauthError("oauth_failed", "The id_token was not issued by Google.");
    }
    if (str(claims.aud) !== clientId()) {
      throw new OauthError("oauth_failed", "The id_token was minted for a different client.");
    }
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    if (!(exp * 1000 > Date.now())) {
      throw new OauthError("oauth_failed", "The id_token has expired.");
    }
    if (str(claims.nonce) !== state.nonce) {
      // The token is real but belongs to a different sign-in — a replay, or a
      // cookie from another tab. Either way it is not this request's.
      throw new OauthError("oauth_failed", "The id_token's nonce does not match this sign-in.");
    }
    const sub = str(claims.sub);
    const email = str(claims.email);
    if (!sub || !email) {
      throw new OauthError("oauth_failed", "The id_token carried no subject or no email address.");
    }
    if (claims.email_verified !== true) {
      throw new OauthError(
        "email_unverified",
        "Google has not verified this address. Verify it with Google, or continue with GitHub.",
      );
    }

    const name = str(claims.name);
    return { providerUserId: sub, email, emailVerified: true, name: name || undefined };
  },
};

/**
 * The payload of a JWT, with no dependency and no trust.
 *
 * Ten lines because that is all it is: three dot-separated segments, the middle
 * one base64url JSON. Every possible failure — two segments, five segments, a
 * payload that is not base64, base64 that is not JSON, JSON that is not an
 * object — is the same `oauth_failed`, because none of them is something a
 * visitor can act on differently.
 */
function decodeJwtPayload(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") {
    throw new OauthError("oauth_failed", "Google's token response carried no id_token.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OauthError("oauth_failed", "The id_token is not a three-part JWT.");
  }
  try {
    const json: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("not an object");
    }
    return json as Record<string, unknown>;
  } catch {
    throw new OauthError("oauth_failed", "The id_token's payload is not readable JSON.");
  }
}

/** A claim as a string, or `""`. A number, an array or a missing value is not a
 *  claim we can compare, and coercing one would be how `aud: 0` passes. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
