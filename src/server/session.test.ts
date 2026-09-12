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
import { SessionStore, isInsideDir, __disposeCallsForTests, type ChatAgent } from "./session";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
}

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
    assert.ok(Number(over.headers.get("retry-after")) >= 1);
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
    writeFileSync(join(session.dir, "secrets.json"), "{}");
    writeFileSync(join(session.dir, "settings.json"), "{}");
    mkdirSync(join(session.dir, "chats"), { recursive: true });
    writeFileSync(join(session.dir, "chats", "one.json"), "[]");

    const removed = await store.sweepFiles();
    assert.ok(removed >= 3, `expected the three scratch files to go, removed ${removed}`);

    assert.deepEqual(readdirSync(session.uploadsDir), [], "uploads/ is emptied");
    assert.deepEqual(readdirSync(session.downloadsDir), [], "downloads/ is emptied");
    assert.deepEqual(readdirSync(session.slicesDir), [], "slices/ is emptied");
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
