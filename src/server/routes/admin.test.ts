// /api/admin/summary answers only a signed-in account whose e-mail is in
// SLICELY_ADMIN_EMAILS — and answers everyone else with the same 404, so the
// route's existence is not advertised. /admin (the page) is a plain static
// shell that is always served.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";
import { resetConfigForTests } from "../../main/config";
import { resetAccountsForTests } from "../../main/accounts/store";
import type { OauthProvider, RawProfile } from "../oauth/index";
import { OAUTH_COOKIE } from "../oauth/state";
import { adminEmails } from "./admin";

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
    /* not exercised */
  },
});

let who: RawProfile = { providerUserId: "u1", email: "Owner.Person@gmail.com", emailVerified: true, name: "Owner" };
const fake: OauthProvider = {
  id: "google",
  label: "Google",
  configured: () => true,
  authorizeUrl: (s) => `https://idp.test/authorize?state=${encodeURIComponent(s.state)}`,
  profile: async () => who,
};

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function harness(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "slicely-admin-route-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetAccountsForTests();
  const store = new SessionStore({ sessionsRoot: join(root, "sessions"), secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      keyValidator: async () => "ok",
      oauth: { providers: [fake] },
      adminDownloads: async () => ({ total: 7, byRelease: [{ tag: "v0.2.1", count: 7 }], fetchedAt: 0 }),
    }),
  );
  return {
    base,
    close: async () => {
      await close();
      store.stopSweep();
      delete process.env.SLICELY_WORKDIR;
      delete process.env.SLICELY_ADMIN_EMAILS;
      resetConfigForTests();
      resetAccountsForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function cookieOf(resp: Response, name: string): string | undefined {
  for (const raw of resp.headers.getSetCookie()) if (raw.startsWith(`${name}=`)) return raw.split(";")[0];
  return undefined;
}

async function signIn(base: string): Promise<string> {
  const started = await fetch(`${base}/auth/google/start`, { redirect: "manual" });
  const session = cookieOf(started, "__Host-slicely_sid");
  const oauth = cookieOf(started, OAUTH_COOKIE);
  assert.ok(session && oauth);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await fetch(`${base}/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: `${session}; ${oauth}` },
  });
  assert.equal(back.status, 302);
  return session;
}

test("adminEmails normalises like sign-up and skips junk", () => {
  const set = adminEmails(" Owner.Person+x@gmail.com, nope, second@example.com ,");
  assert.ok(set.has("ownerperson@gmail.com"));
  assert.ok(set.has("second@example.com"));
  assert.equal(set.size, 2);
  assert.equal(adminEmails(undefined).size, 0);
});

test("no cookie is the API's usual 401; a stranger, a non-admin and an unset list all get the same 404", async () => {
  const h = await harness();
  try {
    const anon = await fetch(`${h.base}/api/admin/summary`);
    assert.equal(anon.status, 401, "no session at all is refused by the session layer, like every /api route");

    const booted = await fetch(`${h.base}/api/config`);
    const fresh = cookieOf(booted, "__Host-slicely_sid");
    assert.ok(fresh);
    process.env.SLICELY_ADMIN_EMAILS = "ownerperson@gmail.com";
    const stranger = await fetch(`${h.base}/api/admin/summary`, { headers: { cookie: fresh } });
    assert.equal(stranger.status, 404, "a session that never signed in");
    assert.equal(((await stranger.json()) as { code?: string }).code, "not_found");

    process.env.SLICELY_ADMIN_EMAILS = "somebody-else@example.com";
    const session = await signIn(h.base);
    const other = await fetch(`${h.base}/api/admin/summary`, { headers: { cookie: session } });
    assert.equal(other.status, 404);

    delete process.env.SLICELY_ADMIN_EMAILS;
    const unset = await fetch(`${h.base}/api/admin/summary`, { headers: { cookie: session } });
    assert.equal(unset.status, 404);
  } finally {
    await h.close();
  }
});

test("the listed owner gets the summary, uncacheable, and sees their own account", async () => {
  const h = await harness();
  try {
    process.env.SLICELY_ADMIN_EMAILS = "ownerperson@gmail.com"; // dots and case differ from the profile on purpose
    const session = await signIn(h.base);
    const resp = await fetch(`${h.base}/api/admin/summary`, { headers: { cookie: session } });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("cache-control"), "no-store");
    const body = (await resp.json()) as {
      users: { total: number };
      sessions: number;
      visitors: number;
      downloads: { total: number | null };
      accounts: Array<{ email: string }>;
    };
    assert.equal(body.users.total, 1);
    assert.ok(body.sessions >= 1);
    assert.ok(body.visitors >= 1, "the signed-in browser's session is on disk");
    assert.equal(body.downloads.total, 7, "the injected counter, not GitHub");
    assert.equal(body.accounts[0].email, "Owner.Person@gmail.com");
  } finally {
    await h.close();
  }
});

test("the page itself is served, and is only a shell", async () => {
  const h = await harness();
  try {
    const page = await fetch(`${h.base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /\/web\/admin\.js/);
    assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.\w+/, "no address is baked into the page");
    const mod = await fetch(`${h.base}/web/admin.js`);
    assert.equal(mod.status, 200);
  } finally {
    await h.close();
  }
});
