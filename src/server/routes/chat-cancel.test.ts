// Regression test for the bug that made web chat silently do nothing:
// `req.on("close")` fires as soon as body-parser finishes reading the POST
// body (Node >= 16 semantics), NOT only when the browser disconnects. The
// chat route used it to cancel the agent, so every turn was cancelled ~1ms
// in and the browser received a bare {"type":"done"} with no text.
//
// Hermetic: a stub agent that streams on a timer, no Anthropic client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

// Chat now requires the visitor's own Anthropic key (see main/userkey.ts), so
// each test connects one first — with an injected validator, so nothing here
// touches the network. Hosted mode + a master key: the key is encrypted at rest.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
const TEST_KEY = "sk-ant-api03-" + "c".repeat(40);

/** An agent that takes a beat before replying, and records cancellation. */
function slowAgent(): { agent: ChatAgent; cancelled: () => boolean } {
  let cancelled = false;
  const agent: ChatAgent = {
    async send(_message, emit) {
      await new Promise((r) => setTimeout(r, 120));
      if (cancelled) {
        emit({ type: "done" });
        return;
      }
      emit({ type: "text", text: "hello " });
      emit({ type: "text", text: "there" });
      emit({ type: "done" });
    },
    cancel() {
      cancelled = true;
    },
  };
  return { agent, cancelled: () => cancelled };
}

/** Connect a key to a fresh session and return its cookie.
 *
 *  Two calls, because minting a workspace is its own step now: GET /api/config
 *  is the only endpoint that may create one (see session.ts's MINTING_ROUTES),
 *  and everything else — PUT /api/key included — is 401 `no_session` without a
 *  cookie. This is exactly the order the client boots in. */
async function connectKey(base: string): Promise<string> {
  const boot = await fetch(`${base}/api/config`);
  assert.equal(boot.status, 200);
  const raw = boot.headers.get("set-cookie");
  assert.ok(raw, "the boot call should mint a session cookie");
  const cookie = raw.split(";")[0];

  const resp = await fetch(`${base}/api/key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ apiKey: TEST_KEY }),
  });
  assert.equal(resp.status, 200);
  return cookie;
}

async function withServer(
  makeAgent: () => ChatAgent,
  fn: (base: string, cookie: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "slicely-chat-"));
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    sweepIntervalMs: 0,
  });
  const app = createApp({
    sessionStore: store,
    chatAgentFactory: makeAgent,
    keyValidator: async () => "ok",
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    const base = `http://127.0.0.1:${port}`;
    await fn(base, await connectKey(base));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a normal chat POST is NOT cancelled by the request body being consumed", async () => {
  const { agent, cancelled } = slowAgent();
  await withServer(
    () => agent,
    async (base, cookie) => {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
      });
      const body = await res.text();

      assert.equal(
        cancelled(),
        false,
        "the agent must not be cancelled just because the POST body was read",
      );
      assert.match(body, /"type":"text"/, "the reply text must reach the browser");
      assert.match(body, /hello /);
      assert.match(body, /there/);
      assert.match(body, /"type":"done"/);
    },
  );
});

test("a real client disconnect DOES cancel the in-flight turn", async () => {
  const { agent, cancelled } = slowAgent();
  await withServer(
    () => agent,
    async (base, cookie) => {
      const ac = new AbortController();
      const pending = fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
        signal: ac.signal,
      }).catch(() => undefined);
      // Abort while the stub is still "thinking".
      setTimeout(() => ac.abort(), 40);
      await pending;
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(
        cancelled(),
        true,
        "closing the browser mid-reply must still cancel the agent",
      );
    },
  );
});
