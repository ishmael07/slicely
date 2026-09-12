// Tests for the session layer: the path-containment guard every route uses
// to keep one browser out of another's files, and the signed-cookie session
// store itself (two anonymous visitors never collide; the same cookie always
// comes back to the same session). Hermetic — an ephemeral HTTP server on a
// loopback port, a stubbed chat agent (no Anthropic client, no network), and
// a temp-dir-backed session store (never touches the real `~/Slicely`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "./index";
import { SessionStore, isInsideDir, type ChatAgent } from "./session";

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
