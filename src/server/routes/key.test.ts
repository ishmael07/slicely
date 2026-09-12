// The whole bring-your-own-key surface, end to end over HTTP: PUT/DELETE
// /api/key, what GET /api/config tells the client, DELETE /api/session, and
// what POST /api/chat does before a key exists.
//
// The Anthropic validation call is INJECTED (createApp's `keyValidator`), so
// these tests never touch the network and never need a real key. The chat agent
// is stubbed for the same reason — see chat.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

// Hosted mode with a real master key: the key is encrypted at rest, so the
// vault must be able to load one.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

const GOOD_KEY = "sk-ant-api03-" + "k".repeat(40);
const OAT_TOKEN = "sk-ant-oat01-" + "k".repeat(40);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-key-"));
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

/** The `name=value` half of a Set-Cookie, ready to send back as `cookie`. */
function cookieOf(resp: Response): string {
  const raw = resp.headers.get("set-cookie");
  assert.ok(raw, "expected a session cookie");
  return raw.split(";")[0];
}

test("a badly-shaped key is refused with a code the UI can branch on, and nothing is stored", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const bad = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "not-a-key" }),
    });
    assert.equal(bad.status, 400);
    const cookie = cookieOf(bad);
    assert.equal(((await bad.json()) as { code?: string }).code, "key_invalid_format");

    // A Claude Pro/Max subscription token is refused the same way: it is not an
    // API key, and Anthropic's terms forbid using one here.
    const oat = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: OAT_TOKEN }),
    });
    assert.equal(oat.status, 400);
    assert.equal(((await oat.json()) as { code?: string }).code, "key_invalid_format");

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    const body = (await cfg.json()) as { hasKey: boolean; keyHint?: string; mode: string };
    assert.equal(body.hasKey, false);
    assert.equal(body.keyHint, undefined);
    assert.equal(body.mode, "hosted");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a well-formed key Anthropic rejects is not stored either", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "rejected" }),
  );
  try {
    const resp = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(resp.status, 401);
    const cookie = cookieOf(resp);
    assert.equal(((await resp.json()) as { code?: string }).code, "key_rejected");

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(((await cfg.json()) as { hasKey: boolean }).hasKey, false);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted key is connected, reported only as a hint, and never echoed back", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(put.status, 200);
    const cookie = cookieOf(put);
    const putText = await put.text();
    const putBody = JSON.parse(putText) as { hasKey: boolean; keyHint?: string };
    assert.equal(putBody.hasKey, true);
    assert.equal(putBody.keyHint, "…" + GOOD_KEY.slice(-4));

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    const cfgText = await cfg.text();
    const cfgBody = JSON.parse(cfgText) as { hasKey: boolean; keyHint?: string; version: string; sourceCommit: string };
    assert.equal(cfgBody.hasKey, true);
    assert.equal(cfgBody.keyHint, "…" + GOOD_KEY.slice(-4));
    assert.equal(typeof cfgBody.version, "string");
    assert.ok(cfgBody.sourceCommit.length > 0);

    // The one rule this whole module exists to keep.
    assert.ok(!putText.includes(GOOD_KEY), "PUT /api/key must not echo the key");
    assert.ok(!cfgText.includes(GOOD_KEY), "GET /api/config must not echo the key");

    // A second visitor (no cookie) gets their own empty session.
    const other = await fetch(`${base}/api/config`);
    const otherText = await other.text();
    assert.equal((JSON.parse(otherText) as { hasKey: boolean }).hasKey, false);
    assert.ok(!otherText.includes(GOOD_KEY), "another session must never see the key");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /api/key disconnects it; DELETE /api/session takes the workspace with it", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(put.status, 200);
    const cookie = cookieOf(put);
    const sid = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    const dir = store.get(sid)?.dir;
    assert.ok(dir && existsSync(dir), "the session should own a directory on disk");

    const del = await fetch(`${base}/api/key`, { method: "DELETE", headers: { cookie } });
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as { hasKey: boolean }).hasKey, false);

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(((await cfg.json()) as { hasKey: boolean }).hasKey, false);

    const gone = await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie } });
    assert.equal(gone.status, 204);
    assert.match(gone.headers.get("set-cookie") ?? "", /Max-Age=0/, "the cookie must be cleared too");
    assert.equal(store.get(sid), undefined, "the session record is gone");
    assert.equal(existsSync(dir!), false, "and so is everything it stored");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing the key drops the agent built from the old one", async () => {
  // Without this, re-keying after a rejection looks like it worked and then
  // fails on every turn: the session's agent still holds an Anthropic client
  // constructed from the key that was replaced.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  let built = 0;
  const counting: () => ChatAgent = () => {
    built += 1;
    return stubAgent();
  };
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: counting, keyValidator: async () => "ok" }),
  );
  try {
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    const cookie = cookieOf(put);
    const chat = async () => {
      const resp = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
      });
      await resp.text();
    };

    await chat();
    assert.equal(built, 1);
    await chat();
    assert.equal(built, 1, "the same session reuses its agent");

    const rekey = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: "sk-ant-api03-" + "z".repeat(40) }),
    });
    assert.equal(rekey.status, 200);
    await chat();
    assert.equal(built, 2, "a new key must produce a new agent");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat with no key is a 409 with code no_key — answered BEFORE any SSE headers", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(resp.status, 409);
    assert.match(resp.headers.get("content-type") ?? "", /application\/json/);
    const body = (await resp.json()) as { error: string; code?: string };
    assert.equal(body.code, "no_key");
    assert.ok(!/\.env/.test(body.error), "no talk of files the user cannot see");

    // With a key connected, the same request streams as usual.
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    const cookie = cookieOf(put);
    const ok = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/event-stream/);
    await ok.text();
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
