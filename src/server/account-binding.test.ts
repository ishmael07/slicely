// Tests for the account↔session binding and the rehydration that makes it
// survive a deploy. Hermetic: an ephemeral loopback server, a temp-dir-backed
// session store, a probe route instead of the real app where the point is what
// `req.session` holds. No network, no accounts directory, no provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Express, Request, Response } from "express";
import { createApp } from "./index";
import { resetConfigForTests } from "../main/config";
import { centsToMicros } from "../main/pricing";
import {
  findOrCreateAccount, getAccount, isRetired, resetAccountsForTests,
  type SignInProfile,
} from "../main/accounts/store";
import {
  SessionStore,
  SESSION_PERSONAL_FILES,
  bindAccountToSession,
  unbindAccountFromSession,
  readSessionAccountId,
  sessionMiddleware,
  type ChatAgent,
} from "./session";

const ACCOUNT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** One verified sign-in, the same person every time. */
const PROFILE: SignInProfile = {
  provider: "google",
  providerUserId: "107812345",
  email: "Jane.Doe@gmail.com",
  normalizedEmail: "janedoe@gmail.com",
  name: "Jane Doe",
};
const OTHER_ACCOUNT = "0123456789abcdef0123456789abcdef";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-binding-"));
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

/**
 * The smallest app that can answer "what does `req.session` say?".
 *
 * The middleware is mounted at the APP level here (the real server mounts it on
 * the `/api` router and shares the instance with `/auth`), which is exactly the
 * ambiguity `mayMintSession` is written to survive: `/api/config` mints under
 * either mount, and so do the two `/auth` routes.
 */
function probeApp(store: SessionStore): Express {
  const app = express();
  app.use(sessionMiddleware(store));
  const say = (req: Request, res: Response) =>
    res.json({ id: req.session?.id ?? null, accountId: req.session?.accountId ?? null });
  app.get("/api/config", say);   // a minting route
  app.get("/probe", say);        // NOT a minting route: needs a valid cookie
  return app;
}

function cookieOf(resp: Response | globalThis.Response): string | undefined {
  const raw = (resp as globalThis.Response).headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
}

// ── 1: the file itself ───────────────────────────────────────────────────────

test("binding writes one small 0600 file, and unbinding removes it", () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  try {
    const { session } = store.getOrCreate(
      { headers: {}, protocol: "http" } as unknown as Request,
      { setHeader: () => undefined } as unknown as Response,
    );
    bindAccountToSession(session, ACCOUNT);
    assert.equal(session.accountId, ACCOUNT);

    const path = join(session.dir, "account.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, accountId: ACCOUNT });
    assert.equal(statSync(path).mode & 0o777, 0o600, "an identity file is not world-readable");
    assert.equal(readSessionAccountId(session.dir), ACCOUNT, "it round-trips");
    assert.equal(
      readdirSync(session.dir).filter((n) => n.includes(".tmp")).length,
      0,
      "the atomic write leaves no temp sibling behind",
    );

    // Re-binding replaces rather than appends.
    bindAccountToSession(session, OTHER_ACCOUNT);
    assert.equal(readSessionAccountId(session.dir), OTHER_ACCOUNT);

    unbindAccountFromSession(session);
    assert.equal(session.accountId, undefined);
    assert.equal(existsSync(path), false);
    assert.equal(readSessionAccountId(session.dir), undefined);
  } finally {
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hand-edited account.json that names a path, not an account, reads as signed out", () => {
  const root = tmpRoot();
  try {
    for (const body of [
      JSON.stringify({ version: 1, accountId: "../../etc/passwd" }),
      JSON.stringify({ version: 1, accountId: "" }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ accountId: 42 }),
      "not json at all",
    ]) {
      writeFileSync(join(root, "account.json"), body);
      assert.equal(readSessionAccountId(root), undefined, body);
    }
    rmSync(join(root, "account.json"));
    assert.equal(readSessionAccountId(root), undefined, "and a missing file is simply signed out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2: the whole point — a restart does not sign anyone out ──────────────────

test("a restart keeps the workspace, the stored key and the account binding", async () => {
  const root = tmpRoot();
  const first = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const appA = probeApp(first);
  const a = await listen(appA);
  let cookie: string | undefined;
  let id = "";
  try {
    const boot = await fetch(`${a.base}/api/config`);
    cookie = cookieOf(boot);
    assert.ok(cookie, "the boot call mints and sets a cookie");
    id = ((await boot.json()) as { id: string }).id;

    const session = first.get(id)!;
    bindAccountToSession(session, ACCOUNT);
    // Something only the original workspace could have: the stand-in for an
    // encrypted BYO key, a saved chat, an upload.
    writeFileSync(join(session.dir, "marker.txt"), "still here");
  } finally {
    await a.close();
    first.stopSweep();
  }

  // A SECOND store over the same directories and the same secret — which is
  // precisely what a deploy is.
  const second = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const b = await listen(probeApp(second));
  try {
    assert.equal(second.count(), 0, "the new process starts knowing nobody");
    const resp = await fetch(`${b.base}/probe`, { headers: { cookie: cookie! } });
    assert.equal(resp.status, 200, "and the route that cannot mint still answers");
    const body = (await resp.json()) as { id: string; accountId: string | null };
    assert.equal(body.id, id, "the same session, not a new one");
    assert.equal(body.accountId, ACCOUNT, "still signed in");
    assert.equal(second.count(), 1, "exactly one record was adopted");
    assert.equal(
      readFileSync(join(root, id, "marker.txt"), "utf8"),
      "still here",
      "nobody lost their workspace to a deploy",
    );
    assert.equal(cookieOf(resp), undefined, "and no new cookie was issued");
  } finally {
    await b.close();
    second.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3, 4, 5: rehydration is not a way in ─────────────────────────────────────

test("an unsigned cookie still mints a new session — rehydration is not a bypass", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(probeApp(store));
  try {
    // A real session directory exists, and a forged cookie names it.
    const boot = await fetch(`${base}/api/config`);
    const id = ((await boot.json()) as { id: string }).id;
    assert.ok(existsSync(join(root, id)));

    const forged = await fetch(`${base}/api/config`, {
      headers: { cookie: `__Host-slicely_sid=${id}.${"0".repeat(64)}` },
    });
    const body = (await forged.json()) as { id: string };
    assert.notEqual(body.id, id, "a bad signature buys nothing, however real the id is");

    // And on a route that cannot mint, a forged cookie is simply refused.
    const refused = await fetch(`${base}/probe`, {
      headers: { cookie: `__Host-slicely_sid=${id}.${"0".repeat(64)}` },
    });
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { code: string }).code, "no_session");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified cookie whose directory is gone mints fresh and resurrects nothing", async () => {
  const root = tmpRoot();
  const first = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const a = await listen(probeApp(first));
  let cookie = "";
  let id = "";
  try {
    const boot = await fetch(`${a.base}/api/config`);
    cookie = cookieOf(boot)!;
    id = ((await boot.json()) as { id: string }).id;
  } finally {
    await a.close();
    first.stopSweep();
  }
  // The sweeper got there first, or the volume is new.
  rmSync(join(root, id), { recursive: true, force: true });

  const second = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const b = await listen(probeApp(second));
  try {
    const resp = await fetch(`${b.base}/api/config`, { headers: { cookie } });
    const body = (await resp.json()) as { id: string };
    assert.notEqual(body.id, id, "a workspace that is gone is gone");
    assert.equal(
      existsSync(join(root, id)),
      false,
      "and it must not be recreated empty under the old id",
    );
  } finally {
    await b.close();
    second.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a 32-hex id is ever rehydrated, so a signed id cannot be a path", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(probeApp(store));
  try {
    // Sign an id this server would never mint, using the server's OWN secret —
    // so the HMAC genuinely verifies and only the id check stands in the way.
    const secret = Buffer.from(readFileSync(join(root, ".session-secret"), "utf8").trim(), "hex");
    for (const hostile of ["../escape", "..", "not-hex", "A".repeat(32), "abc"]) {
      const mac = createHmac("sha256", secret).update(hostile).digest("hex");
      const resp = await fetch(`${base}/probe`, {
        headers: { cookie: `__Host-slicely_sid=${encodeURIComponent(hostile)}.${mac}` },
      });
      assert.equal(resp.status, 401, `${hostile} must not be adopted`);
      assert.equal(((await resp.json()) as { code: string }).code, "no_session");
    }
    assert.equal(store.count(), 0, "nothing was adopted and nothing was minted");
    assert.deepEqual(readdirSync(root), [".session-secret"], "and no directory was created");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6: desktop is untouched ──────────────────────────────────────────────────

test("desktop mode never rehydrates — there is one workspace and it is the user's", async () => {
  const root = tmpRoot();
  const desktopDir = join(root, "desktop");
  // Mint a hosted-shaped session first, so there IS something adoptable on disk.
  const hosted = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const a = await listen(probeApp(hosted));
  let cookie = "";
  let hostedId = "";
  try {
    const boot = await fetch(`${a.base}/api/config`);
    cookie = cookieOf(boot)!;
    hostedId = ((await boot.json()) as { id: string }).id;
  } finally {
    await a.close();
    hosted.stopSweep();
  }

  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, desktopDir, sweepIntervalMs: 0 });
  const b = await listen(probeApp(store));
  try {
    // The cookie names a real, verifiable, on-disk session — and it is ignored,
    // because on the desktop the single workspace answers every request.
    const resp = await fetch(`${b.base}/probe`, { headers: { cookie } });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { id: string; accountId: string | null };
    assert.notEqual(body.id, hostedId, "another workspace on disk is not the desktop's");
    assert.equal(body.accountId, null, "and the desktop has no account to be signed in as");
    assert.equal(store.count(), 1);
  } finally {
    await b.close();
    store.stopSweep();
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 7: a visitor may arrive on a sign-in link ────────────────────────────────

test("the two /auth routes may mint a session, and nothing else under /auth may", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(probeApp(store));
  try {
    for (const path of ["/auth/google/start", "/auth/google/callback", "/auth/github/start"]) {
      const resp = await fetch(`${base}${path}`);
      // The router itself is not mounted in this app, so reaching the handler
      // means a 404 from Express — the point is that it is NOT 401 no_session.
      assert.equal(resp.status, 404, `${path} must reach the router, not the gate`);
      assert.ok(cookieOf(resp), `${path} mints a workspace for a first-time visitor`);
    }
    for (const path of ["/auth/google/bogus", "/auth/google", "/auth", "/auth/google/start/x"]) {
      const resp = await fetch(`${base}${path}`);
      assert.equal(resp.status, 401, `${path} is not a sign-in route`);
      assert.equal(((await resp.json()) as { code: string }).code, "no_session");
    }
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 8: "Delete my data" takes the binding with everything else ───────────────

test("account.json is personal data, and DELETE /api/session removes it", async () => {
  assert.ok(
    SESSION_PERSONAL_FILES.includes("account.json"),
    "the binding must be classified as personal, or the census test is the only thing that notices",
  );

  const root = tmpRoot();
  const desktopDir = join(root, "desktop");
  const prev = process.env.SLICELY_MODE;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  // DESKTOP, because that is the branch where "delete my data" works by NAME:
  // a hosted session's whole directory goes, which takes the file trivially.
  process.env.SLICELY_MODE = "desktop";
  // And a workdir of our own, because `destroy` also deletes the bound ACCOUNT
  // and `main/accounts/paths.ts` creates its directory as a side effect of being
  // asked for a path. Without this the test writes into the developer's real
  // `~/Slicely-data`.
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetAccountsForTests();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, desktopDir, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent, desktopToken: "tok" });
  const { base, close } = await listen(app);
  try {
    const session = store.desktopSession();
    bindAccountToSession(session, ACCOUNT);
    assert.ok(existsSync(join(session.dir, "account.json")));

    const resp = await fetch(`${base}/api/session`, {
      method: "DELETE",
      headers: { "x-slicely-desktop": "tok" },
    });
    assert.ok(resp.status < 400, `DELETE /api/session answered ${resp.status}`);
    assert.equal(
      existsSync(join(session.dir, "account.json")),
      false,
      "the link between this workspace and a person must go with the data",
    );
    assert.ok(existsSync(session.dir), "the desktop workspace itself survives");
  } finally {
    await close();
    store.stopSweep();
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    resetAccountsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Fix round 1: the account goes with the data, and a restart keeps its age ──

test("delete my data deletes the ACCOUNT, and signing in again gets no new grant", async () => {
  const root = tmpRoot();
  const savedWorkdir = process.env.SLICELY_WORKDIR;
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetAccountsForTests();
  const store = new SessionStore({
    sessionsRoot: join(root, "sessions"), secretDir: root, sweepIntervalMs: 0,
  });
  try {
    const { session } = store.getOrCreate(
      { headers: {}, protocol: "http" } as unknown as Request,
      { setHeader: () => undefined } as unknown as Response,
    );
    const { account, granted } = findOrCreateAccount(PROFILE, centsToMicros(50));
    assert.equal(granted, true, "the first sign-in is granted");
    bindAccountToSession(session, account.id);

    await store.destroy(session.id);

    assert.equal(getAccount(account.id), undefined, "the account record is gone");
    assert.equal(isRetired("janedoe@gmail.com"), true, "and the email is retired");

    // Spec §1.5, and the sentence the UI promises: signing in again works, and
    // brings no money with it.
    const again = findOrCreateAccount(PROFILE, centsToMicros(50));
    assert.equal(again.granted, false, "free credit is not granted twice");
    assert.equal(again.account.grantedMicros, 0);
    assert.notEqual(again.account.id, account.id, "it is a new, empty record");
  } finally {
    store.stopSweep();
    if (savedWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = savedWorkdir;
    resetConfigForTests();
    resetAccountsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("only google and github may mint on a sign-in link", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(probeApp(store));
  try {
    // `[a-z]+` would have let a provider that does not exist widen the gate;
    // the two providers Slicely actually has are named.
    for (const path of ["/auth/gitlab/start", "/auth/apple/callback", "/auth/x/start"]) {
      const resp = await fetch(`${base}${path}`);
      assert.equal(resp.status, 401, `${path} is not one of our sign-in routes`);
      assert.equal(((await resp.json()) as { code: string }).code, "no_session");
    }
    for (const path of ["/auth/github/callback", "/auth/google/start"]) {
      const resp = await fetch(`${base}${path}`);
      assert.equal(resp.status, 404, `${path} must still reach the router`);
    }
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rehydrated session keeps the age it had, rather than being born again", async () => {
  const root = tmpRoot();
  const first = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const a = await listen(probeApp(first));
  let cookie = "";
  let id = "";
  let bornAt = 0;
  try {
    const boot = await fetch(`${a.base}/api/config`);
    cookie = cookieOf(boot)!;
    id = ((await boot.json()) as { id: string }).id;
    bornAt = first.get(id)!.createdAt;
  } finally {
    await a.close();
    first.stopSweep();
  }

  // A measurable gap, so "the age it had" and "now" are telling different times.
  const deployedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const second = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const b = await listen(probeApp(second));
  try {
    await fetch(`${b.base}/probe`, { headers: { cookie } });
    const adopted = second.get(id)!;
    assert.ok(adopted, "adopted");
    // Not "now": a session adopted after a deploy is as old as its workspace, and
    // stamping the adoption moment onto it would make every deploy look like a
    // wave of brand-new visitors to anything that ever reads a session's age.
    assert.ok(
      adopted.createdAt < deployedAt,
      `createdAt ${adopted.createdAt} must predate the restart at ${deployedAt}`,
    );
    assert.ok(
      Math.abs(adopted.createdAt - bornAt) < 1_000,
      `createdAt ${adopted.createdAt} should be the original ${bornAt}`,
    );
    assert.ok(adopted.createdAt <= adopted.lastActiveAt);
  } finally {
    await b.close();
    second.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
