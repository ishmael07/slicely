// Tests for the session layer: the path-containment guard every route uses
// to keep one browser out of another's files, and the signed-cookie session
// store itself (two anonymous visitors never collide; the same cookie always
// comes back to the same session). Hermetic — an ephemeral HTTP server on a
// loopback port, a stubbed chat agent (no Anthropic client, no network), and
// a temp-dir-backed session store (never touches the real `~/Slicely`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "./index";
import { DESKTOP_HEADER } from "./desktop-token";
import {
  SessionStore,
  SESSION_KEPT_FILES,
  SESSION_PERSONAL_FILES,
  isInsideDir,
  resolveSessionPath,
  workspaceRelPath,
  __disposeCallsForTests,
  type ChatAgent,
} from "./session";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
}

/** A desktop launch token for the harnesses that build a desktop-mode app.
 *  Hosted mode ignores the option entirely. */
const TOKEN = "session-test-launch-token";

const stubAgent: () => ChatAgent = () => ({
  async send(_message, emit) {
    emit({ type: "text", text: "ok" });
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised in this file */
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

function setCookieValue(resp: Response): string | undefined {
  const raw = resp.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
}

/** The session id out of a `name=<id>.<hmac>` cookie pair. */
function sessionIdFrom(cookie: string): string {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  return value.slice(0, value.lastIndexOf("."));
}

test("isInsideDir accepts nested paths and rejects traversal / lookalike siblings", () => {
  assert.equal(isInsideDir("/a/b", "/a/b/c.stl"), true);
  assert.equal(isInsideDir("/a/b", "/a/b"), true);
  assert.equal(isInsideDir("/a/b", "/a/b/../../etc/passwd"), false);
  // "/a/bc" is NOT inside "/a/b" even though the string has "/a/b" as a
  // prefix — a naive startsWith() check would wrongly accept this.
  assert.equal(isInsideDir("/a/b", "/a/bc/evil.stl"), false);
});

test("an anonymous request mints a session cookie; replaying it reuses the same session; a fresh request gets a different one", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    // /api/config, not /healthz: sessions are minted on the /api router only.
    const r1 = await fetch(`${base}/api/config`);
    const cookie1 = setCookieValue(r1);
    assert.ok(cookie1, "first request should mint a session cookie");

    const r2 = await fetch(`${base}/api/config`, { headers: { cookie: cookie1! } });
    assert.equal(setCookieValue(r2), undefined, "replaying the same cookie should not mint a new one");

    const r3 = await fetch(`${base}/api/config`); // no cookie at all — a different visitor
    const cookie3 = setCookieValue(r3);
    assert.ok(cookie3 && cookie3 !== cookie1, "a request with no cookie gets its OWN new session");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Minting a workspace is itself a privilege (spec §2) ──────────────────────

test("static pages and /healthz never mint a session", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const home = await fetch(`${base}/`);
    const health = await fetch(`${base}/healthz`);
    assert.equal(setCookieValue(home), undefined, "the landing page must not cost a workspace");
    assert.equal(setCookieValue(health), undefined, "a health check must not cost a workspace");
    assert.equal(health.status, 200);
    assert.equal(store.count(), 0, "nothing outside /api touches the session store");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one address can mint only 20 sessions an hour", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  // Take the `api` tier out of the picture: this test is about the mint cap.
  const app = createApp({
    sessionStore: store,
    chatAgentFactory: stubAgent,
    limits: { api: { capacity: 1000 } },
  });
  const { base, close } = await listen(app);
  try {
    for (let i = 0; i < 20; i++) {
      const resp = await fetch(`${base}/api/config`);
      assert.equal(resp.status, 200, `mint ${i + 1} of 20 should be allowed`);
    }
    const over = await fetch(`${base}/api/config`);
    assert.equal(over.status, 429, "the 21st new workspace from one address is refused");
    const body = (await over.json()) as { error: string; code: string };
    assert.equal(body.code, "rate_limited");
    assert.match(body.error, /new sessions/i);
    // ~3 MINUTES, not "a few seconds": 20 an hour refills one token every 180s.
    // The client's copy branches on this (see rateLimitedCopy in web/api.ts) —
    // the same `rate_limited` code covers a tier burst that clears in a second
    // and this cap, and telling a first-time visitor to retry in a few seconds
    // sends them into a reload loop that cannot succeed.
    const retryAfter = Number(over.headers.get("retry-after"));
    assert.ok(retryAfter > 60, `the mint cap's Retry-After should be minutes, got ${retryAfter}`);
    assert.equal(retryAfter, 180);
    assert.equal(store.count(), 20, "the refused request must not leave a workspace behind");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("destroying a session disposes its in-memory state, settings and key", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const cookie = setCookieValue(await fetch(`${base}/api/config`));
    assert.ok(cookie);
    const id = sessionIdFrom(cookie!);
    const session = store.get(id);
    assert.ok(session, "the minted session should be in the store");

    const before = __disposeCallsForTests();
    await store.destroy(id);

    const after = __disposeCallsForTests();
    assert.equal(after.state, before.state + 1, "agent state must be dropped");
    assert.equal(after.settings, before.settings + 1, "settings must be dropped");
    assert.equal(after.userKey, before.userKey + 1, "the decrypted API key must not linger in memory");
    assert.equal(after.printers, before.printers + 1, "nor the decrypted printer credentials");
    assert.equal(store.get(id), undefined);
    assert.equal(existsSync(session!.dir), false, "the workspace directory goes too");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepFiles clears stale scratch files but keeps secrets, settings and chats", async () => {
  const root = tmpRoot();
  // fileIdleMs: 0 — every file is already "stale", so one sweep is enough.
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0, fileIdleMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const cookie = setCookieValue(await fetch(`${base}/api/config`));
    const session = store.get(sessionIdFrom(cookie!))!;
    // Back-dated a minute so the test asserts the THRESHOLD, not a race
    // between the write and the sweep inside the same millisecond.
    const stale = (path: string, body: string) => {
      writeFileSync(path, body);
      const past = new Date(Date.now() - 60_000);
      utimesSync(path, past, past);
    };
    stale(join(session.uploadsDir, "bracket.stl"), "solid\n");
    stale(join(session.downloadsDir, "kit.zip"), "PK");
    stale(join(session.slicesDir, "bracket.gcode"), "G28\n");
    // multer's landing strip. A request that dies between the write and the
    // rename (a cancelled tab, a 413 refusal, a crash) abandons its part file
    // here, and nothing else ever comes back for it — so the sweep must own it.
    stale(join(session.scratchDir, "abcd1234-bracket.stl"), "solid\n");
    writeFileSync(join(session.dir, "secrets.json"), "{}");
    writeFileSync(join(session.dir, "settings.json"), "{}");
    mkdirSync(join(session.dir, "chats"), { recursive: true });
    writeFileSync(join(session.dir, "chats", "one.json"), "[]");

    const removed = await store.sweepFiles();
    assert.ok(removed >= 4, `expected the four scratch files to go, removed ${removed}`);

    assert.deepEqual(readdirSync(session.uploadsDir), [], "uploads/ is emptied");
    assert.deepEqual(readdirSync(session.downloadsDir), [], "downloads/ is emptied");
    assert.deepEqual(readdirSync(session.slicesDir), [], "slices/ is emptied");
    assert.deepEqual(readdirSync(session.scratchDir), [], "scratch/ is emptied");
    assert.equal(existsSync(session.uploadsDir), true, "…but the directory itself stays");
    assert.equal(existsSync(join(session.dir, "secrets.json")), true, "the encrypted key survives");
    assert.equal(existsSync(join(session.dir, "settings.json")), true, "settings survive");
    assert.equal(existsSync(join(session.dir, "chats", "one.json")), true, "chat history survives");
    assert.equal(store.count(), 1, "a file sweep never evicts the session itself");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepFiles keeps a stale file the session is still holding a reference to", async () => {
  // Age is not evidence that nobody wants the file: the visitor who uploaded a
  // mesh an hour ago and is about to slice it still has it in activeModelPaths,
  // and the G-code they haven't downloaded yet still has a live token.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0, fileIdleMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const cookie = setCookieValue(await fetch(`${base}/api/config`));
    const session = store.get(sessionIdFrom(cookie!))!;
    const stale = (path: string, body: string) => {
      writeFileSync(path, body);
      const past = new Date(Date.now() - 60_000);
      utimesSync(path, past, past);
      return path;
    };
    const kept = stale(join(session.uploadsDir, "in-use.stl"), "solid\n");
    const keptGcode = stale(join(session.slicesDir, "in-use.gcode"), "G28\n");
    const dropped = stale(join(session.uploadsDir, "forgotten.stl"), "solid\n");

    session.activeModelPaths.push(kept);
    session.gcodeFiles.set("tok", { path: keptGcode, label: "in-use.gcode" });

    await store.sweepFiles();

    assert.equal(existsSync(kept), true, "the model the session is working on survives");
    assert.equal(existsSync(keptGcode), true, "so does G-code the browser still holds a token for");
    assert.equal(existsSync(dropped), false, "an unreferenced stale file still goes");
    assert.deepEqual(session.activeModelPaths, [kept], "and the reference is still valid");
    assert.equal(session.gcodeFiles.get("tok")?.path, keptGcode);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cookie whose value is not valid percent-encoding is read, not fatal", async () => {
  // `decodeURIComponent` THROWS a URIError on a malformed escape, and the cookie
  // parser runs on the first middleware of every request — so one junk cookie
  // (left by another app on the same origin, or sent on purpose) used to turn
  // every single response into a 500. A value that isn't percent-encoded is
  // simply read as itself; a session id then fails its own signature check.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    for (const cookie of ["slicely_sid=%zz", "slicely_sid=%", "junk=100%; other=%E0%A4%A"]) {
      const resp = await fetch(`${base}/api/config`, { headers: { cookie } });
      assert.equal(resp.status, 200, `cookie ${cookie} must not break the request`);
      // Unsigned/undecodable ⇒ not a session this server issued ⇒ a fresh one.
      assert.ok(setCookieValue(resp), "a junk cookie mints a clean session rather than failing");
    }
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Task D6: the session cookie's name and attributes ────────────────────────

/** Mint a session against a real server running in `mode` and return the raw
 *  `Set-Cookie` line, so its attributes can be read as the browser sees them. */
async function mintedCookieLine(mode: "hosted" | "desktop"): Promise<string> {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  // Desktop mode has no app without a launch token (index.ts refuses to build
  // one); hosted mode ignores the option, so the same call serves both.
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent, desktopToken: TOKEN });
  const { base, close } = await listen(app);
  try {
    const resp = await fetch(`${base}/api/config`, { headers: { [DESKTOP_HEADER]: TOKEN } });
    const raw = resp.headers.get("set-cookie");
    assert.ok(raw, "a first /api request must mint a session cookie");
    return raw!;
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
}

test("hosted: the session cookie is __Host- prefixed and always Secure", async () => {
  const line = await mintedCookieLine("hosted");

  assert.ok(line.startsWith("__Host-slicely_sid="), `got ${line.split("=")[0]}`);
  // `Secure` unconditionally, even though this test speaks plain http: a
  // hosted deploy is behind TLS termination, so the proxy's own hop is the
  // only place the request is ever plaintext — and a browser DISCARDS a
  // `__Host-` cookie that arrives without Secure, which would have logged
  // every visitor out of a server that happened not to see x-forwarded-proto.
  assert.match(line, /;\s*Secure/);
  assert.match(line, /;\s*HttpOnly/);
  assert.match(line, /;\s*SameSite=Lax/);
  assert.match(line, /;\s*Path=\//);
  // A `__Host-` cookie may not carry Domain at all.
  assert.doesNotMatch(line, /;\s*Domain=/i);
});

test("desktop: the session cookie is the bare name with no Secure", async () => {
  const line = await mintedCookieLine("desktop");

  // The Electron app is served over http://127.0.0.1. `Secure` there would
  // mean the cookie is never stored, and `__Host-` requires Secure — so the
  // desktop cookie is deliberately the plain one.
  assert.ok(line.startsWith("slicely_sid="), `got ${line.split("=")[0]}`);
  assert.doesNotMatch(line, /;\s*Secure/);
  assert.match(line, /;\s*HttpOnly/);
});

test("a hosted cookie is read back under its own name", async () => {
  // Naming is only half of it: the store has to LOOK for the name it issued,
  // or every request would mint a fresh workspace and nothing would persist.
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "hosted";
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const first = await fetch(`${base}/api/config`);
    const cookie = setCookieValue(first)!;
    assert.ok(cookie.startsWith("__Host-slicely_sid="));

    const second = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(setCookieValue(second), undefined, "the same cookie must not mint a second workspace");
    assert.equal(store.count(), 1);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
});

// ── Only the boot call may mint (D-2) ────────────────────────────────────────

test("a cookieless fan-out mints nothing and is answered 401 no_session", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  // The `api` tier is out of the way: this is about minting, not throughput.
  const app = createApp({
    sessionStore: store,
    chatAgentFactory: stubAgent,
    limits: { api: { capacity: 1000 } },
  });
  const { base, close } = await listen(app);
  try {
    // Exactly what the browser used to do on load: several API calls at once,
    // none of them carrying a cookie yet. Each one used to mint its own
    // workspace, so one page load cost 7–12 of them.
    const fanout = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${base}/api/chats`)),
    );
    for (const resp of fanout) {
      assert.equal(resp.status, 401, "a cookieless call that isn't the boot call is refused");
      assert.equal(setCookieValue(resp), undefined, "and it must not set a cookie");
      const body = (await resp.json()) as { error: string; code?: string };
      assert.equal(body.code, "no_session");
      assert.match(body.error, /session/i);
    }
    assert.equal(store.count(), 0, "five parallel cookieless requests mint ZERO sessions");

    // The boot call mints exactly one, and then the same cookie gets the rest
    // of the app — which is the whole contract the client now follows.
    const boot = await fetch(`${base}/api/config`);
    assert.equal(boot.status, 200);
    const cookie = setCookieValue(boot);
    assert.ok(cookie, "GET /api/config is the one call that mints");
    assert.equal(store.count(), 1, "one boot call, one workspace");

    const after = await fetch(`${base}/api/chats`, { headers: { cookie: cookie! } });
    assert.equal(after.status, 200, "with the cookie, everything else answers normally");
    assert.equal(store.count(), 1, "and still only one workspace exists");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cookieless fan-out does not spend the per-IP mint budget either", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({
    sessionStore: store,
    chatAgentFactory: stubAgent,
    limits: { api: { capacity: 1000 }, mintPerHour: 2 },
  });
  const { base, close } = await listen(app);
  try {
    // Ten refusals must cost nothing: the point of the gate is that a boot
    // storm (or a crawler) cannot exhaust the cap it used to exhaust.
    for (let i = 0; i < 10; i++) {
      assert.equal((await fetch(`${base}/api/status`)).status, 401);
    }
    assert.equal((await fetch(`${base}/api/config`)).status, 200, "mint 1 of 2");
    assert.equal((await fetch(`${base}/api/config`)).status, 200, "mint 2 of 2");
    assert.equal((await fetch(`${base}/api/config`)).status, 429, "the cap itself still bites");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop mode is unaffected: any endpoint answers without a prior boot call", async () => {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const root = tmpRoot();
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    desktopDir: join(root, "desktop"),
    sweepIntervalMs: 0,
  });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent, desktopToken: TOKEN });
  const { base, close } = await listen(app);
  try {
    // There is one workspace and it already exists, so there is nothing to
    // mint and nothing to refuse — the Mac app must not need a boot call to
    // read its own chats.
    const resp = await fetch(`${base}/api/chats`, { headers: { [DESKTOP_HEADER]: TOKEN } });
    assert.equal(resp.status, 200);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
});

// ── Workspace-relative file references (D-7a) ────────────────────────────────

test("resolveSessionPath accepts the client's relative reference and refuses escapes", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, chatAgentFactory: stubAgent });
  const { base, close } = await listen(app);
  try {
    const cookie = setCookieValue(await fetch(`${base}/api/config`))!;
    const session = store.get(sessionIdFrom(cookie))!;

    // The form the wire now carries.
    assert.equal(
      resolveSessionPath(session, "uploads/x.stl"),
      join(session.dir, "uploads", "x.stl"),
    );
    // Absolute still works (the desktop's attach-local, the agent's own paths).
    assert.equal(
      resolveSessionPath(session, join(session.uploadsDir, "x.stl")),
      join(session.dir, "uploads", "x.stl"),
    );
    // And nothing else does.
    assert.equal(resolveSessionPath(session, "../x.stl"), undefined);
    assert.equal(resolveSessionPath(session, "uploads/../../x.stl"), undefined);
    assert.equal(resolveSessionPath(session, "/etc/passwd"), undefined);
    assert.equal(resolveSessionPath(session, ""), undefined);
    assert.equal(resolveSessionPath(session, undefined), undefined);

    // ── Dot segments INSIDE the workspace ────────────────────────────────────
    // This is the case join-then-contain got wrong: `uploads/../secrets.json` is
    // genuinely inside the session, and it is the encrypted Anthropic key. So
    // containment was the wrong question to ask about a relative path, and the
    // wrong answer was reachable from GET /api/preview, POST /api/slice's
    // `paths`, POST /api/jobs' `parts[].path` and send_to_printer's `gcodePath`.
    const refused = (raw: string) => assert.equal(resolveSessionPath(session, raw), undefined, raw);
    refused("uploads/../secrets.json");
    refused("uploads/../printer-secrets.json");
    refused("uploads/./../settings.json");
    refused("downloads/../../sessions/other/uploads/x.stl");
    // Backslash counts as a separator too, so a Windows-ish spelling cannot slip
    // past a POSIX-only split.
    refused("uploads\\..\\secrets.json");
    // The session's own top level is not addressable at all, by any spelling.
    refused("secrets.json");
    refused("printers.json");
    refused("master.key");
    refused(".session-secret");
    // Nor is multer's landing strip, which is never handed out to anybody.
    refused("scratch/upload_abc123");

    // ── And the same rule, spelled ABSOLUTELY ───────────────────────────────
    // The subtree check used to be asked of the caller's SPELLING, so it bound
    // the relative form and skipped the absolute one — `<session.dir>/
    // secrets.json` passed containment, because of course it is inside the
    // session. It is now asked of the resolved path, which is where both forms
    // meet.
    refused(join(session.dir, "secrets.json"));
    refused(join(session.dir, "printer-secrets.json"));
    refused(join(session.dir, "printers.json"));
    refused(join(session.dir, "master.key"));
    refused(join(session.dir, ".session-secret"));
    refused(join(session.dir, "scratch", "upload_abc123"));
    refused(session.dir);
    refused(join(session.dir, "uploads", "..", "secrets.json"));

    // The other two subtrees the server does hand out still work.
    assert.equal(
      resolveSessionPath(session, "downloads/kit/part1.stl"),
      join(session.dir, "downloads", "kit", "part1.stl"),
    );
    assert.equal(
      resolveSessionPath(session, "slices/plate-1.gcode"),
      join(session.dir, "slices", "plate-1.gcode"),
    );

    // The reverse direction: what the client is told, POSIX-separated.
    assert.equal(workspaceRelPath(session, join(session.uploadsDir, "cube.stl")), "uploads/cube.stl");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete-my-data removes EVERY per-session file, in every shape its writers produce", async () => {
  // DESKTOP: the session directory is `app.getPath("userData")` — Electron's own
  // cookie jar, cache, GPUCache and Local Storage live in there — so it cannot be
  // deleted wholesale and "Delete my data" has to remove data by name. Which
  // means the list of names has to be COMPLETE. This test writes one file for
  // every writer in the codebase (the census is in the comment on
  // PERSONAL_FILES, and `grep -rn "sessionFile(" src` is how it was taken) plus
  // the temp sibling each atomic writer can leave behind — every one of which is
  // a complete copy of the file it was replacing, so leaving it is a rename and
  // not a deletion.
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const root = tmpRoot();
  const desktopDir = join(root, "desktop");
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    desktopDir,
    sweepIntervalMs: 0,
  });
  try {
    const session = store.desktopSession();
    const write = (name: string) => writeFileSync(join(session.dir, name), "x");

    // ── Personal, one line per writer ──────────────────────────────────────
    write("secrets.json"); //          main/userkey.ts — the encrypted Anthropic key
    write("chats.json"); //            server/chats.ts — every transcript
    write("jobs.json"); //             main/jobs/store.ts — the print queue
    write("printers.json"); //         main/printers/registry.ts — printer connections
    write("printer-secrets.json"); //  main/printers/registry.ts — their credentials
    // ── And the interrupted atomic write of each, in both writer shapes ────
    write("jobs.json.tmp-3f2a91bc"); //                  main/jobs/store.ts
    write("chats.json.tmp"); //                          server/chats.ts
    write(".secrets.json.8123.1789372358943.tmp"); //     main/userkey.ts
    write(".printer-secrets.json.8123.1789372358944.tmp"); // printers/registry.ts
    write(".printers.json.8123.1789372358945.tmp"); //    printers/registry.ts
    // ── Configuration, which must SURVIVE ─────────────────────────────────
    for (const name of SESSION_KEPT_FILES) write(name);
    // ── Files, in all four scratch directories, plus the one temp file a
    //    download leaves inside one of them (sourcing/download.ts) ──────────
    writeFileSync(join(session.uploadsDir, "cube.stl"), "solid x\nendsolid x\n");
    writeFileSync(join(session.downloadsDir, "bracket.stl"), "solid x\nendsolid x\n");
    writeFileSync(join(session.downloadsDir, ".slicely-dl-8123-1789372358946"), "partial");
    writeFileSync(join(session.slicesDir, "plate-1.gcode"), "G1\n");
    writeFileSync(join(session.scratchDir, "upload_abc123"), "raw multipart");

    // The census as it stands on disk, taken BEFORE the delete. Everything the
    // lines above wrote is one writer's real output; `isInterruptedAtomicWrite`
    // decides which of them are temp siblings (matched by shape, so a name added
    // to PERSONAL_FILES tomorrow is covered without anybody remembering its temp
    // form too).
    const scratch = ["uploads", "downloads", "slices", "scratch"];
    const before = readdirSync(session.dir).filter((n) => !scratch.includes(n));
    const classified = new Set<string>([...SESSION_PERSONAL_FILES, ...SESSION_KEPT_FILES]);
    // EVERY top-level file has to be classified as personal or kept. Driven by
    // the directory rather than by a second copy of the list, so a writer added
    // to the codebase and to this census — but not to either constant — fails
    // here instead of quietly leaving personal data behind.
    for (const name of before) {
      if (/\.tmp(-[0-9a-f]+)?$/.test(name)) continue; // an interrupted write, matched by shape
      assert.ok(
        classified.has(name),
        `${name} is written per session but classified as neither personal nor kept`,
      );
    }
    // And in the other direction: a name on either list that nothing writes is a
    // stale entry (the historical `chats`, which never existed, is the one
    // deliberate exception — it is kept on the list precisely so an old install's
    // file is still removed).
    for (const name of classified) {
      if (name === "chats") continue;
      assert.ok(before.includes(name), `${name} is classified but nothing in the census writes it`);
    }

    await store.destroy(session.id);

    // AFTER: scan the directory and assert nothing unclassified survived — the
    // question asked of the filesystem, not of a constant.
    const left = readdirSync(session.dir)
      .filter((n) => !scratch.includes(n))
      .sort();
    assert.deepEqual(
      left,
      [...SESSION_KEPT_FILES].filter((n) => before.includes(n)).sort(),
      `unexpected leftovers: ${left.join(", ")}`,
    );
    // Nothing on the personal list survived, under any spelling.
    for (const name of SESSION_PERSONAL_FILES) {
      assert.equal(existsSync(join(session.dir, name)), false, `${name} survived`);
    }
    for (const dir of [session.uploadsDir, session.downloadsDir, session.slicesDir, session.scratchDir]) {
      assert.deepEqual(readdirSync(dir), [], `${dir} still has files in it`);
    }
    assert.ok(existsSync(session.dir), "the desktop workspace itself must survive");
  } finally {
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
});
