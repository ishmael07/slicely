// Both providers, with every outbound call INJECTED. No test in this file
// touches the network: `profile()` takes its `http` as an argument precisely so
// the token exchange and the profile read can be asserted byte for byte —
// which URL, which method, which headers, which form fields, and nothing else.
//
// What is being defended here is mostly negative: no client secret in a URL, no
// access token in a thrown message, no token written to disk, and no id_token
// claim taken on trust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resetConfigForTests } from "../../main/config";
import { configuredProviders, OauthError, redirectUri, signInProviders, type HttpFn } from "./index";
import { pkceChallenge, type OauthState } from "./state";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

const GOOGLE_ID = "1234.apps.googleusercontent.com";
const GOOGLE_SECRET = "GOCSPX-supersecret";
const GITHUB_ID = "Iv1.github0000";
const GITHUB_SECRET = "ghs-supersecret";

/** Set exactly the OAuth env this case wants, and nothing left over from the
 *  last one — `configured()` is a pure function of these four plus the URL. */
function env(over: Record<string, string | undefined>): void {
  for (const name of [
    "SLICELY_PUBLIC_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  ]) {
    delete process.env[name];
  }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) process.env[k] = v;
  }
  resetConfigForTests();
}

function allSet(): void {
  env({
    SLICELY_PUBLIC_URL: "https://app.test",
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    GITHUB_CLIENT_ID: GITHUB_ID,
    GITHUB_CLIENT_SECRET: GITHUB_SECRET,
  });
}

function state(over: Partial<OauthState> = {}): OauthState {
  return {
    provider: "google",
    sid: "sid-1",
    state: "state-abc",
    verifier: "verifier-xyz",
    nonce: "nonce-123",
    returnTo: "/app",
    exp: Date.now() + 60_000,
    ...over,
  };
}

function provider(id: "google" | "github") {
  const found = configuredProviders().find((p) => p.id === id);
  assert.ok(found, `expected ${id} to be configured`);
  return found;
}

/** A base64url-payload JWT. The signature is deliberately junk — google.ts does
 *  not verify it (see the file's comment), and a test that signed one would be
 *  asserting a property the code does not claim. */
function jwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.not-a-signature`;
}

function googleClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: GOOGLE_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "nonce-123",
    sub: "sub-123",
    email: "Jane@Gmail.com",
    email_verified: true,
    name: "Jane",
    ...over,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** An `HttpFn` that records what it was asked and answers from a script. */
function scripted(replies: Array<{ status?: number; body: unknown; text?: string }>): {
  http: HttpFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const http: HttpFn = async (url, init = {}) => {
    calls.push({ url, init });
    const reply = replies[i++] ?? { status: 500, body: {} };
    const body = reply.text ?? JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { http, calls };
}

function formOf(init: RequestInit): URLSearchParams {
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  const contentType = headers["Content-Type"] ?? headers["content-type"];
  assert.equal(contentType, "application/x-www-form-urlencoded");
  return new URLSearchParams(String(init.body));
}

// ── Google ───────────────────────────────────────────────────────────────────

test("Google is offered only when the id, the secret and the public URL are all set", () => {
  env({});
  assert.equal(
    configuredProviders().find((p) => p.id === "google"),
    undefined,
  );
  env({ GOOGLE_CLIENT_ID: GOOGLE_ID, SLICELY_PUBLIC_URL: "https://app.test" });
  assert.equal(
    configuredProviders().find((p) => p.id === "google"),
    undefined,
    "an id with no secret is not a configured provider",
  );
  env({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: GOOGLE_SECRET });
  assert.equal(
    configuredProviders().find((p) => p.id === "google"),
    undefined,
    "without SLICELY_PUBLIC_URL there is no redirect URI to register",
  );
  env({
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    SLICELY_PUBLIC_URL: "https://app.test",
  });
  assert.equal(provider("google").label, "Google");
  assert.deepEqual(signInProviders(), [{ id: "google", label: "Google" }]);
  assert.equal(redirectUri("google"), "https://app.test/auth/google/callback");
});

test("the Google authorize URL asks for exactly what the spec says, and carries no secret", () => {
  allSet();
  const s = state();
  const url = new URL(provider("google").authorizeUrl(s));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = url.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), GOOGLE_ID);
  assert.equal(q.get("scope"), "openid email profile");
  assert.equal(q.get("redirect_uri"), "https://app.test/auth/google/callback");
  assert.equal(q.get("state"), s.state);
  assert.equal(q.get("nonce"), s.nonce);
  assert.equal(q.get("code_challenge"), pkceChallenge(s.verifier));
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("prompt"), "select_account");
  assert.equal(q.get("access_type"), "online");
  assert.ok(!url.toString().includes(GOOGLE_SECRET), "the client secret must never reach a URL");
  assert.ok(!url.toString().includes(s.verifier), "the verifier must never reach a URL");
});

test("Google's token exchange sends the six fields and nothing else, and the id_token becomes a profile", async () => {
  allSet();
  const { http, calls } = scripted([{ body: { access_token: "ya29.discarded", id_token: jwt(googleClaims()) } }]);
  const s = state();
  const raw = await provider("google").profile("auth-code-1", s, http);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const form = formOf(calls[0].init);
  assert.deepEqual([...form.keys()].sort(), [
    "client_id",
    "client_secret",
    "code",
    "code_verifier",
    "grant_type",
    "redirect_uri",
  ]);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code-1");
  assert.equal(form.get("redirect_uri"), "https://app.test/auth/google/callback");
  assert.equal(form.get("client_id"), GOOGLE_ID);
  assert.equal(form.get("client_secret"), GOOGLE_SECRET);
  assert.equal(form.get("code_verifier"), s.verifier);
  assert.deepEqual(raw, {
    providerUserId: "sub-123",
    email: "Jane@Gmail.com",
    emailVerified: true,
    name: "Jane",
  });
});

test("every id_token claim Google's signature would have covered is checked here instead", async () => {
  allSet();
  const bad: Array<[string, Record<string, unknown> | string]> = [
    ["a foreign issuer", googleClaims({ iss: "https://accounts.evil.example" })],
    ["a token minted for another client", googleClaims({ aud: "9999.apps.googleusercontent.com" })],
    ["an expired token", googleClaims({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ["a nonce from a different sign-in", googleClaims({ nonce: "nonce-from-elsewhere" })],
    ["no subject", googleClaims({ sub: "" })],
    ["no email", googleClaims({ email: undefined })],
  ];
  for (const [why, claims] of bad) {
    const { http } = scripted([{ body: { id_token: jwt(claims as Record<string, unknown>) } }]);
    await assert.rejects(
      () => provider("google").profile("c", state(), http),
      (e: unknown) => e instanceof OauthError && e.code === "oauth_failed",
      why,
    );
  }

  // A payload that is not JSON, and a token that is not three segments.
  const notJson = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("not json at all").toString("base64url")}.sig`;
  for (const [why, token] of [
    ["a payload that is not JSON", notJson],
    ["two segments instead of three", "header.payload"],
    ["no token at all", undefined],
  ] as Array<[string, string | undefined]>) {
    const { http } = scripted([{ body: { id_token: token } }]);
    await assert.rejects(
      () => provider("google").profile("c", state(), http),
      (e: unknown) => e instanceof OauthError && e.code === "oauth_failed",
      why,
    );
  }

  // The accepted second spelling of the issuer.
  const { http: ok } = scripted([{ body: { id_token: jwt(googleClaims({ iss: "accounts.google.com" })) } }]);
  const raw = await provider("google").profile("c", state(), ok);
  assert.equal(raw.providerUserId, "sub-123");

  // `iss` is compared against a fixed pair, not a suffix.
  const { http: suffix } = scripted([
    { body: { id_token: jwt(googleClaims({ iss: "https://evil-accounts.google.com.attacker.test" })) } },
  ]);
  await assert.rejects(
    () => provider("google").profile("c", state(), suffix),
    (e: unknown) => e instanceof OauthError && e.code === "oauth_failed",
  );
});

test("an unverified Google address is refused with its own code, not a generic failure", async () => {
  allSet();
  for (const value of [false, "false", undefined, "true"]) {
    const { http } = scripted([{ body: { id_token: jwt(googleClaims({ email_verified: value })) } }]);
    await assert.rejects(
      () => provider("google").profile("c", state(), http),
      (e: unknown) => e instanceof OauthError && e.code === "email_unverified",
      `email_verified: ${JSON.stringify(value)}`,
    );
  }
});

test("a refusal from Google's token endpoint says nothing about our secret or their body", async () => {
  allSet();
  const { http } = scripted([
    { status: 400, body: { error: "invalid_grant", error_description: "Bad Request", secret_echo: GOOGLE_SECRET } },
  ]);
  await assert.rejects(
    () => provider("google").profile("c", state(), http),
    (e: unknown) => {
      assert.ok(e instanceof OauthError);
      assert.equal(e.code, "oauth_failed");
      assert.ok(!e.message.includes(GOOGLE_SECRET), "the client secret reached a message");
      assert.ok(!e.message.includes("invalid_grant"), "the upstream body reached a message");
      assert.ok(!e.message.includes("Bad Request"), "the upstream body reached a message");
      return true;
    },
  );
});

test("a Google sign-in writes nothing to disk and makes exactly one outbound call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-oauth-"));
  process.env.SLICELY_WORKDIR = dir;
  allSet();
  try {
    const before = readdirSync(dir);
    const { http, calls } = scripted([{ body: { access_token: "ya29.discarded", id_token: jwt(googleClaims()) } }]);
    await provider("google").profile("c", state(), http);
    assert.equal(calls.length, 1);
    assert.deepEqual(readdirSync(dir), before);
    // Nor did the access token survive into anything we can see.
    assert.ok(!JSON.stringify(calls).includes("ya29."), "the access token was echoed somewhere");
  } finally {
    delete process.env.SLICELY_WORKDIR;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── GitHub ───────────────────────────────────────────────────────────────────

/** The three headers every GitHub API call must carry, plus a UA GitHub will
 *  not turn away. Asserted on both API calls, because either one missing the
 *  version header is a sign-in that breaks on GitHub's next API change. */
function assertGithubApiHeaders(init: RequestInit, token: string): void {
  const h = init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${token}`);
  assert.equal(h.Accept, "application/vnd.github+json");
  assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(h["User-Agent"]?.startsWith("slicely/"), `User-Agent was ${h["User-Agent"]}`);
}

const GH_USER = { id: 4242, login: "jane", name: "Jane Doe" };
const GH_EMAILS = [
  { email: "alt@x.com", primary: false, verified: true },
  { email: "jane@example.com", primary: true, verified: true },
];

test("GitHub is offered only when its id, its secret and the public URL are all set", () => {
  env({});
  assert.equal(
    configuredProviders().find((p) => p.id === "github"),
    undefined,
  );
  env({ GITHUB_CLIENT_ID: GITHUB_ID, SLICELY_PUBLIC_URL: "https://app.test" });
  assert.equal(
    configuredProviders().find((p) => p.id === "github"),
    undefined,
  );
  env({ GITHUB_CLIENT_ID: GITHUB_ID, GITHUB_CLIENT_SECRET: GITHUB_SECRET });
  assert.equal(
    configuredProviders().find((p) => p.id === "github"),
    undefined,
  );
  env({
    GITHUB_CLIENT_ID: GITHUB_ID,
    GITHUB_CLIENT_SECRET: GITHUB_SECRET,
    SLICELY_PUBLIC_URL: "https://app.test",
  });
  assert.equal(provider("github").label, "GitHub");
  assert.equal(redirectUri("github"), "https://app.test/auth/github/callback");
});

test("both providers are offered in one fixed order, so the buttons never swap", () => {
  allSet();
  assert.deepEqual(signInProviders(), [
    { id: "google", label: "Google" },
    { id: "github", label: "GitHub" },
  ]);
});

test("the GitHub authorize URL sends state but no PKCE challenge, because OAuth Apps have none", () => {
  allSet();
  const s = state({ provider: "github" });
  const url = new URL(provider("github").authorizeUrl(s));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), GITHUB_ID);
  assert.equal(q.get("redirect_uri"), "https://app.test/auth/github/callback");
  assert.equal(q.get("scope"), "read:user user:email");
  assert.equal(q.get("state"), s.state);
  assert.equal(q.get("allow_signup"), "true");
  assert.equal(q.get("code_challenge"), null);
  assert.equal(q.get("code_challenge_method"), null);
  assert.ok(!url.toString().includes(GITHUB_SECRET));
  assert.ok(!url.toString().includes(s.verifier));
});

test("a GitHub sign-in is three calls in order, and the address is the verified primary one", async () => {
  allSet();
  const { http, calls } = scripted([
    { body: { access_token: "gho_x", token_type: "bearer", scope: "read:user,user:email" } },
    { body: GH_USER },
    { body: GH_EMAILS },
  ]);
  const raw = await provider("github").profile("gh-code", state({ provider: "github" }), http);
  assert.equal(calls.length, 3);

  assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
  const form = formOf(calls[0].init);
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "application/json");
  assert.deepEqual([...form.keys()].sort(), ["client_id", "client_secret", "code", "redirect_uri"]);
  assert.equal(form.get("client_id"), GITHUB_ID);
  assert.equal(form.get("client_secret"), GITHUB_SECRET);
  assert.equal(form.get("code"), "gh-code");
  assert.equal(form.get("redirect_uri"), "https://app.test/auth/github/callback");

  assert.equal(calls[1].url, "https://api.github.com/user");
  assertGithubApiHeaders(calls[1].init, "gho_x");
  assert.equal(calls[2].url, "https://api.github.com/user/emails");
  assertGithubApiHeaders(calls[2].init, "gho_x");

  // The primary address wins even though a verified non-primary came first.
  assert.deepEqual(raw, {
    providerUserId: "4242",
    email: "jane@example.com",
    emailVerified: true,
    name: "Jane Doe",
  });
});

test("the GitHub identity is the numeric id, never the login, because a login can change hands", async () => {
  allSet();
  const { http } = scripted([
    { body: { access_token: "gho_x" } },
    { body: { id: 4242, login: "renamed-later", name: null } },
    { body: GH_EMAILS },
  ]);
  const raw = await provider("github").profile("c", state({ provider: "github" }), http);
  assert.equal(raw.providerUserId, "4242");
  assert.equal(raw.name, undefined);
});

test("a GitHub account with no verified primary address is told where to fix it", async () => {
  allSet();
  const unverifiedPrimary = [
    { email: "alt@x.com", primary: false, verified: true },
    { email: "jane@example.com", primary: true, verified: false },
  ];
  for (const emails of [unverifiedPrimary, [], [{ email: "a@b.c", primary: false, verified: true }]]) {
    const { http } = scripted([{ body: { access_token: "gho_x" } }, { body: GH_USER }, { body: emails }]);
    await assert.rejects(
      () => provider("github").profile("c", state({ provider: "github" }), http),
      (e: unknown) => {
        assert.ok(e instanceof OauthError);
        assert.equal(e.code, "email_unverified");
        assert.ok(e.message.includes("github.com/settings/emails"), e.message);
        return true;
      },
      JSON.stringify(emails),
    );
  }
});

test("every way GitHub can refuse is an oauth_failed that names no token", async () => {
  allSet();
  const scripts: Array<[string, Array<{ status?: number; body: unknown; text?: string }>]> = [
    // GitHub answers 200 with an error BODY for a bad code.
    ["a bad verification code", [{ body: { error: "bad_verification_code", error_description: "expired" } }]],
    ["no access token at all", [{ body: { token_type: "bearer" } }]],
    ["a 500 from the token endpoint", [{ status: 500, body: {} }]],
    ["a body that is not JSON", [{ body: {}, text: "<html>maintenance</html>" }]],
    ["a 401 from /user", [{ body: { access_token: "gho_x" } }, { status: 401, body: {} }]],
    ["a /user with no id", [{ body: { access_token: "gho_x" } }, { body: { login: "jane" } }]],
    [
      "a 403 from /user/emails",
      [{ body: { access_token: "gho_x" } }, { body: GH_USER }, { status: 403, body: {} }],
    ],
    [
      "an emails body that is not an array",
      [{ body: { access_token: "gho_x" } }, { body: GH_USER }, { body: { message: "nope" } }],
    ],
  ];
  for (const [why, replies] of scripts) {
    const { http } = scripted(replies);
    await assert.rejects(
      () => provider("github").profile("c", state({ provider: "github" }), http),
      (e: unknown) => {
        assert.ok(e instanceof OauthError, why);
        assert.equal(e.code, "oauth_failed", why);
        assert.ok(!e.message.includes("gho_"), `the access token reached a message: ${why}`);
        assert.ok(!e.message.includes(GITHUB_SECRET), `the client secret reached a message: ${why}`);
        assert.ok(!e.message.includes("bad_verification_code"), `the upstream body reached a message: ${why}`);
        return true;
      },
      why,
    );
  }
});

test("a GitHub sign-in writes nothing to disk, and the access token appears in no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-oauth-gh-"));
  process.env.SLICELY_WORKDIR = dir;
  allSet();
  try {
    const before = readdirSync(dir);
    const { http } = scripted([{ body: { access_token: "gho_x" } }, { body: GH_USER }, { body: GH_EMAILS }]);
    const raw = await provider("github").profile("c", state({ provider: "github" }), http);
    assert.deepEqual(readdirSync(dir), before);
    assert.ok(!JSON.stringify(raw).includes("gho_"));
  } finally {
    delete process.env.SLICELY_WORKDIR;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
