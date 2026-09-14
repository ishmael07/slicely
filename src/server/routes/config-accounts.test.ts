// GET /api/config's account fields, and PATCH /api/settings' refusal to let a
// free-credit visitor pick a model they cannot pay for.
//
// Hermetic: an ephemeral loopback server, a temp-dir-backed session store, a
// stub chat agent, and a workdir under $TMPDIR. No network and no real key —
// the "owner key" is a syntactically valid string that is never sent anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { randomBytes } from "node:crypto";
import { createApp } from "../index";
import { SessionStore, bindAccountToSession, type ChatAgent } from "../session";
import { runInSession, sessionContext } from "../../main/session-context";
import { setUserApiKey } from "../../main/userkey";
import { resetConfigForTests } from "../../main/config";
import { resetKeyVaultForTests } from "../../main/keyvault";
import { centsToMicros } from "../../main/pricing";
import { findOrCreateAccount, resetAccountsForTests } from "../../main/accounts/store";
import { resetMeterForTests } from "../../main/accounts/meter";
import { resetFundingForTests } from "../../main/agent/funding";
import type { AccountView, SigninProvider, FreeTierView } from "../../shared/types";

process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

const OWNER_ANTHROPIC = "sk-ant-api03-" + "o".repeat(40);
const USER_OPENAI = "sk-proj-" + "u".repeat(40);

interface ConfigBody {
  mode: string;
  hasKey: boolean;
  accountsEnabled: boolean;
  signinProviders: SigninProvider[];
  freeTier: FreeTierView | null;
  [other: string]: unknown;
}

const stubAgent: () => ChatAgent = () => ({
  async send(_message, emit) {
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised here */
  },
});

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const OAUTH_ENV = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "SLICELY_PUBLIC_URL",
] as const;

function clearEnv(): void {
  for (const name of OAUTH_ENV) delete process.env[name];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SLICELY_FREE_MODEL;
  process.env.SLICELY_MODE = "hosted";
}

/** Both providers configured, and a public URL to build redirect URIs from. */
function bothProviders(): void {
  process.env.SLICELY_PUBLIC_URL = "https://app.test";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-value";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret-value";
}

interface Harness {
  base: string;
  store: SessionStore;
  workdir: string;
  cookie: string;
  close: () => Promise<void>;
}

/** A booted app with a minted session, and every module cache dropped first. */
async function harness(setup: () => void): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), "slicely-config-acct-"));
  process.env.SLICELY_WORKDIR = workdir;
  clearEnv();
  setup();
  resetConfigForTests();
  resetAccountsForTests();
  resetMeterForTests();
  resetFundingForTests();

  const root = join(workdir, "sessions");
  const store = new SessionStore({ sessionsRoot: root, secretDir: workdir, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent, desktopToken: "tok" });
  const { base, close } = await listen(app);
  const boot = await fetch(`${base}/api/config`, { headers: { "x-slicely-desktop": "tok" } });
  const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    base,
    store,
    workdir,
    cookie,
    close: async () => {
      await close();
      store.stopSweep();
      clearEnv();
      resetConfigForTests();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

async function config(h: Harness): Promise<ConfigBody> {
  const resp = await fetch(`${h.base}/api/config`, {
    headers: { cookie: h.cookie, "x-slicely-desktop": "tok" },
  });
  assert.equal(resp.status, 200);
  return (await resp.json()) as ConfigBody;
}

// ── 1, 2, 3, 4, 5: what /api/config says about sign-in ───────────────────────

test("OAuth configured and an owner key: sign-in exists and names the free model", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const body = await config(h);
    assert.equal(body.accountsEnabled, true);
    assert.deepEqual(body.signinProviders, [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ], "the order is the server's, so the buttons never swap between renders");
    assert.deepEqual(body.freeTier, {
      model: "claude-sonnet-5",
      modelLabel: "Sonnet 5",
      effort: "medium",
      creditCents: 50,
    });
  } finally { await h.close(); }
});

test("no OAuth secrets: exactly today's response, plus three empty fields", async () => {
  const withAccounts = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  let enabled: ConfigBody;
  try {
    enabled = await config(withAccounts);
  } finally { await withAccounts.close(); }

  const plain = await harness(() => { process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC; });
  try {
    const body = await config(plain);
    assert.equal(body.accountsEnabled, false);
    assert.deepEqual(body.signinProviders, []);
    assert.equal(body.freeTier, null);

    // EVERY field that exists today is untouched by the three new ones.
    for (const key of Object.keys(body)) {
      if (key === "accountsEnabled" || key === "signinProviders" || key === "freeTier") continue;
      assert.deepEqual(body[key], enabled[key], `${key} must not depend on whether accounts exist`);
    }
    assert.deepEqual(
      Object.keys(body),
      Object.keys(enabled),
      "and the field ORDER is stable in both states",
    );
  } finally { await plain.close(); }
});

test("one provider configured offers one button", async () => {
  const h = await harness(() => {
    process.env.SLICELY_PUBLIC_URL = "https://app.test";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-value";
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const body = await config(h);
    assert.deepEqual(body.signinProviders, [{ id: "google", label: "Google" }]);
    assert.equal(body.accountsEnabled, true);
  } finally { await h.close(); }
});

test("a half-configured provider is not offered at all", async () => {
  const h = await harness(() => {
    process.env.SLICELY_PUBLIC_URL = "https://app.test";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";   // …and no secret
    process.env.GITHUB_CLIENT_SECRET = "github-client-secret-value";   // …and no id
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const body = await config(h);
    assert.deepEqual(body.signinProviders, [], "half a client is no client");
    assert.equal(body.accountsEnabled, false);
  } finally { await h.close(); }
});

test("no SLICELY_PUBLIC_URL means no OAuth, because a redirect URI cannot be guessed", async () => {
  const h = await harness(() => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-value";
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const body = await config(h);
    assert.deepEqual(body.signinProviders, []);
    assert.equal(body.accountsEnabled, false);
  } finally { await h.close(); }
});

test("OAuth but no owner key: nothing to fund, so nothing to sign in for", async () => {
  const h = await harness(() => { bothProviders(); });
  try {
    const body = await config(h);
    assert.equal(body.accountsEnabled, false, "sign-in with no free credit is a dead end");
    assert.equal(body.freeTier, null);
    assert.deepEqual(
      body.signinProviders,
      [],
      "the providers ARE configured, but offering a button that leads to a password prompt " +
        "and then nothing is worse than not offering one",
    );
  } finally { await h.close(); }
});

test("desktop mode has no accounts at all", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    process.env.SLICELY_MODE = "desktop";
  });
  try {
    const body = await config(h);
    assert.equal(body.mode, "desktop");
    assert.equal(body.accountsEnabled, false);
    assert.deepEqual(body.signinProviders, []);
    assert.equal(body.freeTier, null);
  } finally { await h.close(); }
});

// ── 6: and none of it leaks a secret ─────────────────────────────────────────

test("the config body carries no key and no client secret", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const resp = await fetch(`${h.base}/api/config`, {
      headers: { cookie: h.cookie, "x-slicely-desktop": "tok" },
    });
    const raw = await resp.text();
    for (const forbidden of [
      OWNER_ANTHROPIC, "google-client-secret-value", "github-client-secret-value",
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLIENT_SECRET", "google-client-id",
    ]) {
      assert.ok(!raw.includes(forbidden), `${forbidden} must never reach a client`);
    }
    // And nothing key-SHAPED, whatever it is called. (`keyHelp.placeholder` is
    // the literal "sk-ant-…", which is copy, not a credential — hence the
    // length floor rather than a ban on the prefix.)
    assert.equal(
      /sk-[A-Za-z0-9_-]{20,}/.test(raw),
      false,
      "no key-shaped token may appear in the boot response",
    );
  } finally { await h.close(); }
});

// ── 9, 10: a free user cannot pick a model ───────────────────────────────────

/** This harness's session id, off its own cookie. */
function sessionId(h: Harness): string {
  return decodeURIComponent(h.cookie.split("=")[1].split(".")[0]);
}

/**
 * Store a BYO key for the harness's session, the way PUT /api/key does.
 *
 * Straight through main/userkey.ts rather than over HTTP: the route also
 * VALIDATES the key against the provider, which is a live network call, and this
 * test is about the picker, not about key validation.
 */
function connectKey(h: Harness, provider: "anthropic" | "openai", key: string): void {
  const session = h.store.get(sessionId(h))!;
  runInSession(sessionContext(session.id, session.dir), () => setUserApiKey(provider, key));
}

/** Sign the harness's session in, with `micros` of credit left. */
function signIn(h: Harness, spentMicros = 0): void {
  const { account } = findOrCreateAccount(
    {
      provider: "google",
      providerUserId: "107812345",
      email: "jane@example.com",
      normalizedEmail: "jane@example.com",
      name: "Jane Doe",
    },
    centsToMicros(50),
  );
  if (spentMicros) account.spentMicros = spentMicros;
  bindAccountToSession(h.store.get(sessionId(h))!, account.id);
}

async function patchSettings(h: Harness, body: unknown): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const resp = await fetch(`${h.base}/api/settings`, {
    method: "PATCH",
    headers: { cookie: h.cookie, "content-type": "application/json", "x-slicely-desktop": "tok" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: (await resp.json()) as { error?: string; code?: string } };
}

test("a visitor on free credit is told to add a key rather than given a picker", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    signIn(h);
    const model = await patchSettings(h, { model: "gpt-6-astra" });
    assert.equal(model.status, 403);
    assert.equal(model.body.code, "forbidden");
    assert.equal(
      model.body.error,
      "Add your own key to choose models.",
      "the exact sentence the UI shows, so the two cannot drift",
    );

    // Effort is fixed to "medium" on free credit for the same reason.
    const effort = await patchSettings(h, { effort: "max" });
    assert.equal(effort.status, 403);
    assert.equal(effort.body.code, "forbidden");

    // And nothing was saved.
    const after = await fetch(`${h.base}/api/settings`, {
      headers: { cookie: h.cookie, "x-slicely-desktop": "tok" },
    });
    const state = (await after.json()) as { current: { model: string; effort: string } };
    assert.notEqual(state.current.model, "gpt-6-astra");
    assert.notEqual(state.current.effort, "max");
  } finally { await h.close(); }
});

test("a visitor with their own key still picks their own model", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    signIn(h);
    // They are signed in AND they have pasted their own OpenAI key. The model
    // they are switching to is one that key pays for, so the answer is yes.
    connectKey(h, "openai", USER_OPENAI);

    const model = await patchSettings(h, { model: "gpt-6-astra" });
    assert.equal(model.status, 200, "they are paying for it, so it is their choice");

    const after = await fetch(`${h.base}/api/settings`, {
      headers: { cookie: h.cookie, "x-slicely-desktop": "tok" },
    });
    const state = (await after.json()) as { current: { model: string } };
    assert.equal(state.current.model, "gpt-6-astra");
  } finally { await h.close(); }
});

test("with accounts off, a model change is refused the way it always was", async () => {
  const h = await harness(() => { /* no OAuth, no owner key */ });
  try {
    const model = await patchSettings(h, { model: "gpt-6-astra" });
    assert.equal(model.status, 409, "today's refusal, unchanged");
    assert.equal(model.body.code, "no_key");
  } finally { await h.close(); }
});

// ── The AccountView shape B4's GET /api/me renders ───────────────────────────

test("an account renders as an email, a letter, four integers and two labels", async () => {
  const h = await harness(() => {
    bothProviders();
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
  });
  try {
    const { accountView } = await import("./config");
    const { account } = findOrCreateAccount(
      {
        provider: "google",
        providerUserId: "1",
        email: "jane@example.com",
        normalizedEmail: "jane@example.com",
        name: "Jane Doe",
      },
      centsToMicros(50),
    );
    const view: AccountView = accountView(account);
    assert.equal(view.email, "jane@example.com");
    assert.equal(view.name, "Jane Doe");
    assert.equal(view.initial, "J");
    assert.equal(view.balanceMicros, 50_000_000);
    assert.equal(view.balanceLabel, "$0.50");
    assert.equal(view.grantedMicros, 50_000_000);
    assert.equal(view.grantedLabel, "$0.50");
    assert.equal(view.chatsToday, 0);
    assert.equal(view.chatsPerDay, 40);
    assert.equal(view.exhausted, false);
    // Nothing else, ever: no id, no provider, no token.
    assert.deepEqual(Object.keys(view).sort(), [
      "balanceLabel", "balanceMicros", "chatsPerDay", "chatsToday",
      "exhausted", "grantedLabel", "grantedMicros", "initial", "name",
    ].concat(["email"]).sort());

    // A spent account reads as spent, and floors at zero.
    account.spentMicros = 60_000_000;
    const spent = accountView(account);
    assert.equal(spent.balanceMicros, 0);
    assert.equal(spent.balanceLabel, "$0.00");
    assert.equal(spent.exhausted, true);

    // An address that does not start with a letter still gets a monogram.
    account.email = "7@example.com";
    assert.equal(accountView(account).initial, "7");
    account.email = "  ";
    assert.equal(accountView(account).initial, "?");
  } finally { await h.close(); }
});
