// ─────────────────────────────────────────────────────────────────────────────
// Continue with GitHub — plain OAuth 2.0, three calls, nothing kept.
//
// GITHUB OAUTH APPS DO NOT SUPPORT PKCE. So `authorizeUrl` sends `state` and no
// `code_challenge`, and the cookie's `verifier` is simply generated and unused
// for this provider. That is deliberate: one cookie shape and one code path for
// both providers beats a conditional field that only one of them fills. The
// `state` comparison in routes/auth.ts is the CSRF defence either way.
//
// THE ACCESS TOKEN LIVES IN ONE LOCAL VARIABLE across two HTTPS calls and is
// never written, logged, returned or put in an error message. There is nothing
// to refresh it with and nothing that stores it, so a later compromise of our
// disk yields no GitHub access.
//
// `providerUserId` IS THE NUMERIC ID, NEVER THE LOGIN. A login can be changed
// and then claimed by somebody else; keying an account on `jane` would hand that
// person Jane's workspace and Jane's credit. `id` is immutable.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OauthError, oauthEnv, redirectUri, type HttpFn, type OauthProvider, type RawProfile } from "./index";
import { publicUrl } from "./__stub";
import type { OauthState } from "./state";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

/** Where a GitHub user fixes an unverified primary address. In the copy,
 *  because "email_unverified" on its own tells nobody what to do. */
const VERIFY_HELP = "github.com/settings/emails";

function clientId(): string {
  return oauthEnv("GITHUB_CLIENT_ID");
}

function clientSecret(): string {
  return oauthEnv("GITHUB_CLIENT_SECRET");
}

export const githubProvider: OauthProvider = {
  id: "github",
  label: "GitHub",

  configured(): boolean {
    return Boolean(clientId() && clientSecret() && publicUrl());
  },

  authorizeUrl(state: OauthState): string {
    const q = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri("github"),
      // `read:user` for the immutable numeric id, `user:email` for the verified
      // address. Nothing about repositories: Slicely has no business there.
      scope: "read:user user:email",
      state: state.state,
      // Someone without a GitHub account can make one mid-flow rather than
      // bouncing off a sign-in wall.
      allow_signup: "true",
    });
    return `${AUTHORIZE_URL}?${q}`;
  },

  async profile(code: string, _state: OauthState, http: HttpFn): Promise<RawProfile> {
    const body = new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: redirectUri("github"),
    });

    // `Accept: application/json` matters: without it GitHub answers this
    // endpoint with a form-encoded body, and the token is then "missing".
    const tokenRes = await call(http, TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
    const token = str((await json<{ access_token?: unknown }>(tokenRes)).access_token);
    if (!token) {
      // GitHub answers 200 with `{ error: "bad_verification_code" }` rather than
      // a 4xx, so "no token in a successful response" is the normal failure
      // shape here, not an oddity. Its body is not repeated: it echoes the
      // request, and the request carried our client secret.
      throw new OauthError("oauth_failed", "GitHub's token endpoint returned no access token.");
    }

    const user = await json<{ id?: unknown; name?: unknown }>(
      await call(http, USER_URL, { headers: apiHeaders(token) }),
    );
    const id = typeof user.id === "number" && Number.isFinite(user.id) ? String(user.id) : "";
    if (!id) {
      throw new OauthError("oauth_failed", "GitHub's user endpoint returned no numeric id.");
    }

    const emails = await json<unknown>(await call(http, EMAILS_URL, { headers: apiHeaders(token) }));
    if (!Array.isArray(emails)) {
      throw new OauthError("oauth_failed", "GitHub's email endpoint did not return a list.");
    }
    // The PRIMARY entry, and only if GitHub has verified it — never "the first
    // verified one we find", which would let someone sign in with an address
    // their GitHub account merely lists.
    const primary = emails.find(
      (e: unknown) => isEntry(e) && e.primary === true && e.verified === true && str(e.email) !== "",
    );
    if (!primary || !isEntry(primary)) {
      throw new OauthError(
        "email_unverified",
        `Your GitHub account has no verified primary email. Verify one at ${VERIFY_HELP}, or continue with Google.`,
      );
    }

    const name = str(user.name);
    return { providerUserId: id, email: str(primary.email), emailVerified: true, name: name || undefined };
  },
};

/** The three headers GitHub's REST API wants on every call, plus a UA it will
 *  not refuse. Built per call so the token is a parameter, never a module-level
 *  variable something else could read. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    // Pinned, because an unpinned client silently follows GitHub's next
    // breaking change and a sign-in is a bad place to discover one.
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `slicely/${appVersion()}`,
  };
}

/** One outbound call, with a transport failure and a non-2xx collapsed into the
 *  same `oauth_failed` — and with NEITHER carrying the response body, which for
 *  the token endpoint echoes our client secret back at us. */
async function call(http: HttpFn, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch {
    throw new OauthError("oauth_failed", `GitHub could not be reached (${host(url)}).`);
  }
  if (!res.ok) {
    throw new OauthError("oauth_failed", `GitHub answered ${res.status} from ${host(url)}.`);
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new OauthError("oauth_failed", "GitHub answered with a body that is not JSON.");
  }
}

/** The path of one of the three constants above — safe to name in a log because
 *  it came from this file, not from a request. */
function host(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return "github";
  }
}

function isEntry(value: unknown): value is { email?: unknown; primary?: unknown; verified?: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let versionCache: string | undefined;

/** Slicely's own version, for the User-Agent GitHub asks every client to send.
 *  Read once from package.json — three levels up from `dist/server/oauth/`, the
 *  same three from `src/server/oauth/`, so it resolves either way. */
function appVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    versionCache = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }
  return versionCache;
}
