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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

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

async function withServer(
  makeAgent: () => ChatAgent,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "slicely-chat-"));
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    sweepIntervalMs: 0,
  });
  const app = createApp({ sessionStore: store, chatAgentFactory: makeAgent });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
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
    async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    async (base) => {
      const ac = new AbortController();
      const pending = fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
