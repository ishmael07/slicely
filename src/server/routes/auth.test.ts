// The two redirect routes, /api/me and signing out — end to end over HTTP, with
// a FAKE PROVIDER injected through `createApp({ oauth: { providers: [fake] } })`.
// Nothing here touches the network, and nothing here needs a real Google or
// GitHub client: what is being tested is the state cookie, the abuse checks, the
// binding, and the fact that every single exit from the callback is a 302 with
// an empty body.
//
// Every response body this file sees is also swept, once, for anything that
// looks like a secret — see the last test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, type CreateAppOptions } from "../index";
import { SessionStore, type ChatAgent } from "../session";
import { OAUTH_COOKIE, type OauthState } from "../oauth/state";
import { OauthError, type OauthProvider, type RawProfile } from "../oauth/index";
import { resetConfigForTests } from "../../main/config";
import { resetAccountsForTests } from "../../main/accounts/store";
import { resetSignupsForTests } from "../../main/accounts/signups";
import { resetMeterForTests } from "../../main/accounts/meter";
import type { MeResponse } from "../../shared/types";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
process.env.SLICELY_PUBLIC_URL = "https://app.test";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const stubAgent: () => ChatAgent = () => ({
  async send(_message, emit) {
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised here */
  },
});

/** Everything a test captures, so the secret sweep at the end can look at all
 *  of it rather than at whatever each test happened to assert. */
const captured: string[] = [];

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A provider that answers from a table instead of from Google. `id` is
 *  "google" so it occupies the real route; nothing else about it is real. */
function fakeProvider(
  answer: (code: string, state: OauthState) => Promise<RawProfile>,
  id: "google" | "github" = "google",
): OauthProvider {
  return {
    id,
    label: id === "google" ? "Google" : "GitHub",
    configured: () => true,
    authorizeUrl: (s) => `https://idp.test/authorize?state=${encodeURIComponent(s.state)}`,
    profile: answer,
  };
}

const JANE: RawProfile = {
  providerUserId: "idp-user-1",
  email: "Jane.Doe@gmail.com",
  emailVerified: true,
  name: "Jane Doe",
};

function alwaysJane(): OauthProvider {
  return fakeProvider(async () => JANE);
}

interface Harness {
  base: string;
  root: string;
  close: () => Promise<void>;
}

async function harness(opts: Partial<CreateAppOptions> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "slicely-auth-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  // The accounts modules cache — the account index, the signup salt, the day's
  // meter counters — and this file runs several harnesses in one process. Without
  // the three resets, test N's index still says Jane has an account, so test N+1
  // takes the "returning visitor" path in a workdir where she has never been.
  resetAccountsForTests();
  resetSignupsForTests();
  resetMeterForTests();
  const store = new SessionStore({ sessionsRoot: join(root, "sessions"), secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      keyValidator: async () => "ok",
      oauth: { providers: [alwaysJane()] },
      ...opts,
    }),
  );
  return {
    base,
    root,
    close: async () => {
      await close();
      store.stopSweep();
      delete process.env.SLICELY_WORKDIR;
      resetConfigForTests();
      resetAccountsForTests();
      resetSignupsForTests();
      resetMeterForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** GET /api/config is the one call that may mint a workspace for the client. */
async function boot(base: string): Promise<string> {
  const resp = await fetch(`${base}/api/config`);
  assert.equal(resp.status, 200);
  captured.push(await resp.text());
  const cookie = cookieOf(resp, "__Host-slicely_sid");
  assert.ok(cookie);
  return cookie;
}

function cookieOf(resp: Response, name: string): string | undefined {
  for (const raw of resp.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.split(";")[0];
  }
  return undefined;
}

interface Started {
  session: string;
  oauth: string;
  state: string;
}

/** Drive `/auth/google/start` and hand back both cookies plus the `state` the
 *  fake IdP was given. */
async function start(base: string, query = "", sessionCookie?: string): Promise<Started> {
  const resp = await fetch(`${base}/auth/google/start${query}`, {
    redirect: "manual",
    headers: sessionCookie ? { cookie: sessionCookie } : {},
  });
  captured.push(await resp.text());
  assert.equal(resp.status, 302);
  const location = resp.headers.get("location") ?? "";
  assert.ok(location.startsWith("https://idp.test/authorize?state="), location || "no Location");
  const oauth = cookieOf(resp, OAUTH_COOKIE);
  assert.ok(oauth, "no oauth cookie");
  const session = sessionCookie ?? cookieOf(resp, "__Host-slicely_sid");
  assert.ok(session, "no session cookie");
  return { session, oauth, state: new URL(location).searchParams.get("state") ?? "" };
}

async function callback(
  base: string,
  s: Started,
  over: { state?: string; oauth?: string | null; error?: string } = {},
) {
  const state = over.state ?? s.state;
  const oauth = over.oauth === null ? undefined : (over.oauth ?? s.oauth);
  // A provider that is reporting an error sends no `code`, so neither do we.
  const query = over.error
    ? `error=${encodeURIComponent(over.error)}&state=${encodeURIComponent(state)}`
    : `code=the-code&state=${encodeURIComponent(state)}`;
  const resp = await fetch(`${base}/auth/google/callback?${query}`, {
    redirect: "manual",
    headers: { cookie: [s.session, oauth].filter(Boolean).join("; ") },
  });
  const body = await resp.text();
  captured.push(body);
  return { resp, body };
}

async function me(base: string, sessionCookie: string): Promise<MeResponse> {
  const resp = await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie } });
  const text = await resp.text();
  captured.push(text);
  assert.equal(resp.status, 200, text);
  return JSON.parse(text) as MeResponse;
}

/** Every account file on disk. Used to prove a refused sign-in created none. */
function accountIds(root: string): string[] {
  const dir = join(root, "accounts", "by-id");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("starting a sign-in mints a workspace, seals a note, and sends the browser to the provider", async () => {
  const h = await harness();
  try {
    const resp = await fetch(`${h.base}/auth/google/start`, { redirect: "manual" });
    assert.equal(resp.status, 302);
    // TWO cookies: the workspace this visitor did not have yet, and the note.
    const cookies = resp.headers.getSetCookie();
    assert.equal(cookies.length, 2, cookies.join(" | "));
    assert.ok(cookies.some((c) => c.startsWith("__Host-slicely_sid=")));
    const oauth = cookies.find((c) => c.startsWith(`${OAUTH_COOKIE}=`));
    assert.ok(oauth);
    const state = new URL(resp.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(state);
    assert.ok(!oauth.includes(state), "the state is readable in the cookie");
    assert.ok(!oauth.includes("verifier"), "the cookie is not encrypted");
  } finally {
    await h.close();
  }
});

test("a return_to pointing off-site is thrown away before it is ever sealed", async () => {
  const h = await harness();
  try {
    const s = await start(h.base, "?return_to=https%3A%2F%2Fevil.example%2Fsteal");
    const { resp } = await callback(h.base, s);
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/");
  } finally {
    await h.close();
  }
});

test("an unknown or unconfigured provider is a 404, not a hint about what exists", async () => {
  const h = await harness();
  try {
    // With a workspace already in hand, so what is being measured is the route's
    // answer and not the session gate's. Without a cookie, `/auth/bogus/start`
    // is 401 `no_session` instead — only the two real provider ids are allowed
    // to mint (see session.ts's MINTING_PATTERNS), which is the tighter answer.
    const cookie = await boot(h.base);
    for (const path of ["/auth/bogus/start", "/auth/github/start", "/auth/bogus/callback"]) {
      const resp = await fetch(`${h.base}${path}`, { redirect: "manual", headers: { cookie } });
      const body = await resp.text();
      captured.push(body);
      assert.equal(resp.status, 404, path);
      assert.equal((JSON.parse(body) as { code?: string }).code, "not_found", path);
    }
  } finally {
    await h.close();
  }
});

test("desktop mode mounts no sign-in at all", async () => {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const root = mkdtempSync(join(tmpdir(), "slicely-auth-desktop-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  const store = new SessionStore({ sessionsRoot: join(root, "sessions"), secretDir: root, desktopDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      desktopToken: "tok",
      oauth: { providers: [alwaysJane()] },
    }),
  );
  try {
    const resp = await fetch(`${base}/auth/google/start`, {
      redirect: "manual",
      headers: { "x-slicely-desktop": "tok" },
    });
    captured.push(await resp.text());
    assert.equal(resp.status, 404);
    // /api/me still answers, because the client asks it in both modes.
    const signedOut = await fetch(`${base}/api/me`, { headers: { "x-slicely-desktop": "tok" } });
    const body = await signedOut.text();
    captured.push(body);
    assert.equal(signedOut.status, 200);
    assert.deepEqual(JSON.parse(body), { signedIn: false });
    assert.equal(existsSync(join(root, "accounts")), false, "desktop mode created an accounts directory");
  } finally {
    await close();
    store.stopSweep();
    delete process.env.SLICELY_WORKDIR;
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    resetConfigForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the happy path: start, come back, and the session owns an account with fifty cents on it", async () => {
  const h = await harness();
  try {
    const s = await start(h.base, "?return_to=%2Fapp");
    const { resp, body } = await callback(h.base, s);
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/app");
    // Nothing to XSS and nothing to cache.
    assert.equal(body, "");
    // The note is single-use: cleared on the way out, whatever happened.
    const cleared = resp.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_COOKIE}=`));
    assert.ok(cleared, "the oauth cookie was not cleared");
    assert.match(cleared, /Max-Age=0\b/);

    const view = await me(h.base, s.session);
    assert.equal(view.signedIn, true);
    assert.deepEqual(view.account, {
      email: "Jane.Doe@gmail.com",
      name: "Jane Doe",
      initial: "J",
      balanceMicros: 50_000_000,
      balanceLabel: "$0.50",
      grantedMicros: 50_000_000,
      grantedLabel: "$0.50",
      chatsToday: 0,
      chatsPerDay: 40,
      exhausted: false,
    });
    assert.equal(accountIds(h.root).length, 1);
  } finally {
    await h.close();
  }
});

test("a tampered state, a missing note and an expired note all fail the same way", async () => {
  const h = await harness();
  try {
    const cases: Array<[string, () => Promise<{ resp: Response; body: string }>]> = [
      [
        "a state that is not the one we sealed",
        async () => {
          const s = await start(h.base);
          return callback(h.base, s, { state: randomBytes(32).toString("base64url") });
        },
      ],
      [
        "a state of the right shape but the wrong value",
        async () => {
          const s = await start(h.base);
          return callback(h.base, s, { state: s.state.slice(0, -1) + (s.state.at(-1) === "A" ? "B" : "A") });
        },
      ],
      [
        "no oauth cookie at all",
        async () => {
          const s = await start(h.base);
          return callback(h.base, s, { oauth: null });
        },
      ],
      [
        "an oauth cookie from someone else's sign-in",
        async () => {
          const mine = await start(h.base);
          const theirs = await start(h.base);
          return callback(h.base, { ...mine, oauth: theirs.oauth });
        },
      ],
    ];
    for (const [why, run] of cases) {
      const { resp, body } = await run();
      assert.equal(resp.status, 302, why);
      assert.equal(resp.headers.get("location"), "/#auth_error=oauth_failed", why);
      assert.equal(body, "", why);
    }
    assert.deepEqual(accountIds(h.root), [], "a failed sign-in created an account");
  } finally {
    await h.close();
  }
});

test("a visitor who presses Cancel is put back where they were, quietly", async () => {
  let profileCalls = 0;
  const h = await harness({
    oauth: {
      providers: [
        fakeProvider(async () => {
          profileCalls += 1;
          return JANE;
        }),
      ],
      // No code was ever issued, so there is nothing to exchange it for: a
      // callback carrying `?error=` must not touch the network at all.
      http: async () => {
        throw new Error("the callback talked to the provider anyway");
      },
    },
  });
  try {
    // Google/OIDC says `access_denied`; GitHub says `user_cancelled_authorize`.
    for (const error of ["access_denied", "user_cancelled_authorize"]) {
      const s = await start(h.base, "?return_to=%2Fapp");
      const { resp, body } = await callback(h.base, s, { error });
      assert.equal(resp.status, 302, error);
      // NO fragment: changing your mind is not a failure to explain.
      assert.equal(resp.headers.get("location"), "/app", error);
      assert.equal(body, "", error);
      const cleared = resp.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_COOKIE}=`));
      assert.ok(cleared, `the note was not cleared (${error})`);
      assert.match(cleared, /Max-Age=0\b/);
      assert.equal((await me(h.base, s.session)).signedIn, false, error);
    }

    // Any OTHER provider error IS something the client says a sentence about.
    const s = await start(h.base);
    const { resp, body } = await callback(h.base, s, { error: "temporarily_unavailable" });
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/#auth_error=oauth_failed");
    assert.equal(body, "");

    assert.equal(profileCalls, 0, "the provider was asked to exchange a code that does not exist");
    assert.deepEqual(accountIds(h.root), []);
  } finally {
    await h.close();
  }
});

test("a note sealed for one workspace is refused in another", async () => {
  const h = await harness();
  try {
    const mine = await start(h.base, "?return_to=%2Fapp");
    const someoneElse = await boot(h.base);
    // The note and the echoed state are both genuine — only the workspace
    // presenting them is not the one the note was sealed for.
    const resp = await fetch(
      `${h.base}/auth/google/callback?code=the-code&state=${encodeURIComponent(mine.state)}`,
      { redirect: "manual", headers: { cookie: [someoneElse, mine.oauth].join("; ") } },
    );
    const body = await resp.text();
    captured.push(body);
    assert.equal(resp.status, 302);
    // The note's own `return_to` still decides where they land — it is ours, and
    // it was already sealed — with the ordinary failure fragment on the end.
    assert.equal(resp.headers.get("location"), "/app#auth_error=oauth_failed");
    assert.equal(body, "");
    assert.deepEqual(accountIds(h.root), [], "a note from another workspace created an account");
    assert.equal((await me(h.base, someoneElse)).signedIn, false);

    // And the browser that actually started it still finishes normally.
    const { resp: ok } = await callback(h.base, mine);
    assert.equal(ok.headers.get("location"), "/app");
    assert.equal((await me(h.base, mine.session)).signedIn, true);
  } finally {
    await h.close();
  }
});

test("an unverified address and a disposable domain each get their own code, and no account", async () => {
  const cases: Array<[string, RawProfile | OauthError, string]> = [
    [
      "unverified",
      { providerUserId: "u2", email: "nobody@example.com", emailVerified: false },
      "email_unverified",
    ],
    [
      "the provider says unverified itself",
      new OauthError("email_unverified", "no verified primary"),
      "email_unverified",
    ],
    ["disposable", { providerUserId: "u3", email: "burner@mailinator.com", emailVerified: true }, "email_blocked"],
    [
      "an address we cannot even parse",
      { providerUserId: "u4", email: "not an address", emailVerified: true },
      "email_blocked",
    ],
    ["the provider just failed", new OauthError("oauth_failed", "upstream said no"), "oauth_failed"],
  ];
  for (const [why, answer, code] of cases) {
    const h = await harness({
      oauth: {
        providers: [
          fakeProvider(async () => {
            if (answer instanceof OauthError) throw answer;
            return answer;
          }),
        ],
      },
    });
    try {
      const s = await start(h.base);
      const { resp, body } = await callback(h.base, s);
      assert.equal(resp.status, 302, why);
      assert.equal(resp.headers.get("location"), `/#auth_error=${code}`, why);
      assert.equal(body, "", why);
      assert.deepEqual(accountIds(h.root), [], why);
      assert.equal((await me(h.base, s.session)).signedIn, false, why);
    } finally {
      await h.close();
    }
  }
});

test("the fourth brand-new account from one address is refused, and the third was not", async () => {
  let n = 0;
  const h = await harness({
    oauth: {
      providers: [
        fakeProvider(async () => {
          n += 1;
          return { providerUserId: `u${n}`, email: `person${n}@example.com`, emailVerified: true };
        }),
      ],
    },
  });
  try {
    for (const attempt of [1, 2, 3]) {
      const s = await start(h.base);
      const { resp } = await callback(h.base, s);
      assert.equal(resp.headers.get("location"), "/", `signup ${attempt} should have worked`);
      assert.equal((await me(h.base, s.session)).signedIn, true, `signup ${attempt}`);
    }
    assert.equal(accountIds(h.root).length, 3);

    const s = await start(h.base);
    const { resp, body } = await callback(h.base, s);
    assert.equal(resp.headers.get("location"), "/#auth_error=signup_limited");
    assert.equal(body, "");
    assert.equal(accountIds(h.root).length, 3, "a refused signup still created an account");
    assert.equal((await me(h.base, s.session)).signedIn, false);
  } finally {
    await h.close();
  }
});

test("signing in again finds the same account, grants nothing, and costs no signup", async () => {
  const h = await harness();
  try {
    const first = await start(h.base);
    await callback(h.base, first);
    const before = (await me(h.base, first.session)).account;
    assert.ok(before);
    const signupsBefore = readFileSync(
      join(h.root, "accounts", "signups", new Date().toISOString().slice(0, 10) + ".json"),
      "utf8",
    );

    // A second browser, the same person.
    const second = await start(h.base);
    const { resp } = await callback(h.base, second);
    assert.equal(resp.headers.get("location"), "/");
    const after = (await me(h.base, second.session)).account;
    assert.ok(after);
    assert.equal(after.grantedLabel, before.grantedLabel);
    assert.equal(after.balanceLabel, before.balanceLabel);
    assert.equal(accountIds(h.root).length, 1, "the same person got a second account");
    assert.equal(
      readFileSync(join(h.root, "accounts", "signups", new Date().toISOString().slice(0, 10) + ".json"), "utf8"),
      signupsBefore,
      "a returning visitor was charged a signup",
    );
  } finally {
    await h.close();
  }
});

test("signing out drops the account and keeps the workspace", async () => {
  const h = await harness();
  try {
    const s = await start(h.base);
    await callback(h.base, s);
    assert.equal((await me(h.base, s.session)).signedIn, true);

    // The session directory, found the way the server found it.
    const sessions = readdirSync(join(h.root, "sessions"));
    assert.equal(sessions.length, 1);
    const dir = join(h.root, "sessions", sessions[0]);
    assert.ok(existsSync(join(dir, "account.json")));
    // Two things a sign-out must not touch.
    writeFileSync(join(dir, "secrets.json"), "{}");
    writeFileSync(join(dir, "chats.json"), "[]");

    const out = await fetch(`${h.base}/api/auth/signout`, { method: "POST", headers: { cookie: s.session } });
    captured.push(await out.text());
    assert.equal(out.status, 204);
    assert.deepEqual(await me(h.base, s.session), { signedIn: false });
    assert.equal(existsSync(join(dir, "account.json")), false);
    assert.equal(existsSync(join(dir, "secrets.json")), true, "signing out deleted the stored key");
    assert.equal(existsSync(join(dir, "chats.json")), true, "signing out deleted the transcripts");

    // And again, when there is nothing to sign out of.
    const again = await fetch(`${h.base}/api/auth/signout`, { method: "POST", headers: { cookie: s.session } });
    captured.push(await again.text());
    assert.equal(again.status, 204);
  } finally {
    await h.close();
  }
});

test("signing out is a POST defended by the ordinary cross-origin guard", async () => {
  const h = await harness();
  try {
    const s = await start(h.base);
    await callback(h.base, s);
    const resp = await fetch(`${h.base}/api/auth/signout`, {
      method: "POST",
      headers: { cookie: s.session, origin: "https://evil.example" },
    });
    const body = await resp.text();
    captured.push(body);
    assert.equal(resp.status, 403);
    assert.equal((JSON.parse(body) as { code?: string }).code, "cross_origin");
    assert.equal((await me(h.base, s.session)).signedIn, true, "a cross-site POST signed the visitor out");
  } finally {
    await h.close();
  }
});

test("a blocked account still binds, so /api/me can explain itself", async () => {
  const h = await harness();
  try {
    const s = await start(h.base);
    await callback(h.base, s);
    const ids = accountIds(h.root);
    assert.equal(ids.length, 1);
    const file = join(h.root, "accounts", "by-id", ids[0]);
    const account = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    account.blocked = true;
    writeFileSync(file, JSON.stringify(account));

    // A fresh browser for the same person: the block is not a sign-in failure —
    // refusing a chat is POST /api/chat's job (Task A6), and an account the
    // client cannot see is an account the client cannot explain.
    const second = await start(h.base);
    const { resp } = await callback(h.base, second);
    assert.equal(resp.headers.get("location"), "/");
    const view = await me(h.base, second.session);
    assert.equal(view.signedIn, true);
    assert.equal(view.account?.email, "Jane.Doe@gmail.com");
  } finally {
    await h.close();
  }
});

test("not one captured body carries anything that looks like a secret", () => {
  assert.ok(captured.length > 30, `only ${captured.length} bodies were captured`);
  // A real key SHAPE, not the literal "sk-": /api/config legitimately ships
  // "sk-ant-…" as the placeholder text for the key field, and a sweep that
  // cannot tell a placeholder from a credential is a sweep nobody will keep.
  const forbidden: Array<[string, RegExp]> = [
    ["an OAuth client secret", /client_secret|GOCSPX/],
    ["a GitHub access token", /gho_[A-Za-z0-9]/],
    ["an API key", /sk-(?:ant-)?[A-Za-z0-9_-]{12,}/],
    ["an id_token", /id_token/],
    ["a PKCE verifier", /verifier/],
    ["an access token", /access_token/],
  ];
  for (const body of captured) {
    for (const [what, re] of forbidden) {
      assert.ok(!re.test(body), `a response body contained ${what}: ${body.slice(0, 200)}`);
    }
  }
});
