// POST /api/waitlist — one line in an append-only file, and 204 whatever
// happens to an address that is already on it.
//
// The 204-either-way is the point: a different status for "already there" would
// turn this route into a membership oracle anyone could walk an address list
// through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, type CreateAppOptions } from "../index";
import { SessionStore, type ChatAgent } from "../session";
import { resetConfigForTests } from "../../main/config";
import { resetWaitlistForTests, type WaitlistEntry } from "../../main/accounts/waitlist";
import type { OauthProvider, RawProfile } from "../oauth/index";
import { OAUTH_COOKIE } from "../oauth/state";

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

const JANE: RawProfile = {
  providerUserId: "idp-user-1",
  email: "signed.in@example.com",
  emailVerified: true,
  name: "Jane Doe",
};

const fake: OauthProvider = {
  id: "google",
  label: "Google",
  configured: () => true,
  authorizeUrl: (s) => `https://idp.test/authorize?state=${encodeURIComponent(s.state)}`,
  profile: async () => JANE,
};

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Harness {
  base: string;
  root: string;
  close: () => Promise<void>;
}

async function harness(opts: Partial<CreateAppOptions> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "slicely-waitlist-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetWaitlistForTests();
  const store = new SessionStore({ sessionsRoot: join(root, "sessions"), secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      keyValidator: async () => "ok",
      oauth: { providers: [fake] },
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
      resetWaitlistForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function cookieOf(resp: Response, name: string): string | undefined {
  for (const raw of resp.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.split(";")[0];
  }
  return undefined;
}

async function boot(base: string): Promise<string> {
  const resp = await fetch(`${base}/api/config`);
  assert.equal(resp.status, 200);
  const cookie = cookieOf(resp, "__Host-slicely_sid");
  assert.ok(cookie);
  return cookie;
}

async function join_(base: string, cookie: string, body: unknown): Promise<{ status: number; code?: string }> {
  const resp = await fetch(`${base}/api/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (resp.status === 204) return { status: 204 };
  const text = await resp.text();
  return { status: resp.status, code: (JSON.parse(text) as { code?: string }).code };
}

function lines(root: string): WaitlistEntry[] {
  const path = join(root, "accounts", "waitlist.ndjson");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  // One entry per line, newline-terminated, so `wc -l` is the count.
  assert.ok(raw.endsWith("\n"), "the file is not newline-terminated");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WaitlistEntry);
}

test("an address joins the list once, whatever spelling it arrives in", async () => {
  const h = await harness();
  try {
    const cookie = await boot(h.base);
    assert.deepEqual(await join_(h.base, cookie, { email: "Jane.Doe+x@gmail.com", name: "Jane" }), { status: 204 });
    const [entry] = lines(h.root);
    assert.deepEqual(Object.keys(entry).sort(), ["email", "name", "ts"]);
    // The address as TYPED, so a reply can be addressed the way they wrote it.
    assert.equal(entry.email, "Jane.Doe+x@gmail.com");
    assert.equal(entry.name, "Jane");
    assert.ok(entry.ts > 0);
    assert.ok(!("ip" in entry), "the entry recorded an address");
    assert.ok(!("accountId" in entry), "an anonymous caller got an accountId");

    // The same address, then its normalised twin, then a different capitalisation.
    for (const email of ["Jane.Doe+x@gmail.com", "janedoe@gmail.com", "JANEDOE@googlemail.com"]) {
      assert.deepEqual(await join_(h.base, cookie, { email }), { status: 204 }, email);
    }
    assert.equal(lines(h.root).length, 1, "the same person is on the list twice");
  } finally {
    await h.close();
  }
});

test("a signed-in caller's line says which account asked", async () => {
  const h = await harness();
  try {
    const started = await fetch(`${h.base}/auth/google/start`, { redirect: "manual" });
    const session = cookieOf(started, "__Host-slicely_sid");
    const oauth = cookieOf(started, OAUTH_COOKIE);
    assert.ok(session && oauth);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await fetch(`${h.base}/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: `${session}; ${oauth}` },
    });
    assert.equal(back.status, 302);

    assert.deepEqual(await join_(h.base, session, { email: "jane@example.com" }), { status: 204 });
    const [entry] = lines(h.root);
    assert.match(String(entry.accountId), /^[0-9a-f]{32}$/);
  } finally {
    await h.close();
  }
});

test("nonsense is refused with a code the client already has copy for, and nothing is written", async () => {
  const h = await harness();
  try {
    const cookie = await boot(h.base);
    const bad: unknown[] = [
      { email: "jane" },
      { email: "" },
      { email: `${"a".repeat(300)}@example.com` },
      { email: 42 },
      { email: null },
      {},
      { email: "jane@" },
      { email: "@example.com" },
      { email: "jane doe@example.com" },
    ];
    for (const body of bad) {
      assert.deepEqual(await join_(h.base, cookie, body), { status: 400, code: "email_invalid" }, JSON.stringify(body));
    }
    assert.deepEqual(lines(h.root), []);
  } finally {
    await h.close();
  }
});

test("a long name is trimmed to fit; a name with a newline in it is refused outright", async () => {
  const h = await harness();
  try {
    const cookie = await boot(h.base);
    assert.deepEqual(await join_(h.base, cookie, { email: "long@example.com", name: "N".repeat(300) }), {
      status: 204,
    });
    assert.equal(lines(h.root)[0].name?.length, 100);

    // One entry per line is the file format. JSON.stringify would escape a
    // newline anyway, which is exactly why this has to be refused deliberately
    // rather than relied on to be harmless.
    const refused = await join_(h.base, cookie, { email: "newline@example.com", name: "Jane\nDoe" });
    assert.equal(refused.status, 400);
    assert.equal(lines(h.root).length, 1, "the refused entry was written anyway");

    // A name that is not a string is simply absent, not an error: it is optional.
    assert.deepEqual(await join_(h.base, cookie, { email: "noname@example.com", name: 7 }), { status: 204 });
    assert.equal(lines(h.root)[1].name, undefined);
  } finally {
    await h.close();
  }
});

test("the waitlist is on the heavy tier, so it cannot be used as a write loop", async () => {
  // The tier is narrowed rather than driven sixty times — the house pattern (see
  // CreateAppOptions.limits), and it proves the same thing in three requests.
  const h = await harness({ limits: { heavy: { capacity: 2, refillPerSec: 0 } } });
  try {
    const cookie = await boot(h.base);
    assert.equal((await join_(h.base, cookie, { email: "one@example.com" })).status, 204);
    assert.equal((await join_(h.base, cookie, { email: "two@example.com" })).status, 204);
    assert.deepEqual(await join_(h.base, cookie, { email: "three@example.com" }), {
      status: 429,
      code: "rate_limited",
    });
    assert.equal(lines(h.root).length, 2);
  } finally {
    await h.close();
  }
});

test("desktop mode has no waitlist to post to", async () => {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const root = mkdtempSync(join(tmpdir(), "slicely-waitlist-desktop-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetWaitlistForTests();
  const store = new SessionStore({
    sessionsRoot: join(root, "sessions"),
    secretDir: root,
    desktopDir: root,
    sweepIntervalMs: 0,
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, desktopToken: "tok" }),
  );
  try {
    const resp = await fetch(`${base}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-slicely-desktop": "tok" },
      body: JSON.stringify({ email: "jane@example.com" }),
    });
    assert.equal(resp.status, 404);
    assert.equal(((await resp.json()) as { code?: string }).code, "not_found");
    assert.equal(existsSync(join(root, "accounts")), false, "desktop mode created an accounts directory");
  } finally {
    await close();
    store.stopSweep();
    delete process.env.SLICELY_WORKDIR;
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    resetConfigForTests();
    resetWaitlistForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
