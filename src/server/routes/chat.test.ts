// Tests for POST /api/chat's SSE wire format and /api/chat/cancel — using an
// injected stub ChatAgent (see session.ts's ChatAgent + index.ts's
// chatAgentFactory option) so this never constructs a real SlicelyAgent,
// never touches the Anthropic SDK, and makes no network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

// Chat requires the visitor's own Anthropic key (main/userkey.ts), so every
// test here connects one first through PUT /api/key with an INJECTED validator:
// still no network, no real key, and now the same path a real browser takes.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
const TEST_KEY = "sk-ant-api03-" + "c".repeat(40);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
}

/** Connect a key to a fresh session and return its cookie. */
async function connectKey(base: string): Promise<string> {
  const resp = await fetch(`${base}/api/key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: TEST_KEY }),
  });
  assert.equal(resp.status, 200);
  const raw = resp.headers.get("set-cookie");
  assert.ok(raw, "connecting a key should mint a session cookie");
  return raw.split(";")[0];
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("POST /api/chat streams well-formed SSE `data:` frames, in order, from the stubbed agent", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const stub: () => ChatAgent = () => ({
    async send(message, emit) {
      emit({ type: "text", text: `echo: ${message}` });
      emit({ type: "tool_start", tool: "search_models", label: "Searching…" });
      emit({ type: "tool_end", tool: "search_models", ok: true });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = await resp.text();
    const frames = body
      .split("\n\n")
      .map((f) => f.trim())
      .filter(Boolean);
    assert.ok(frames.length >= 4, `expected at least 4 SSE frames, got ${frames.length}: ${JSON.stringify(frames)}`);

    const events = frames.map((frame) => {
      assert.match(frame, /^data: /, `frame is not a well-formed SSE data line: ${frame}`);
      const parsed = JSON.parse(frame.slice("data: ".length)) as { type: string };
      assert.equal(typeof parsed.type, "string");
      return parsed.type;
    });
    assert.deepEqual(events, ["text", "tool_start", "tool_end", "done"]);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/chat/cancel reaches this session's own agent instance", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  let cancelled = false;
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      emit({ type: "done" });
    },
    cancel() {
      cancelled = true;
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const first = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hi" }),
    });
    await first.text(); // drain the SSE stream before reusing the connection

    const cancelResp = await fetch(`${base}/api/chat/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(cancelResp.status, 200);
    assert.equal(cancelled, true);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action's server-side file becomes a download token, never a raw path", async () => {
  // "I opened it in PrusaSlicer" is only true for whoever is sitting at the
  // server. The browser gets a button instead — and it must point at a session
  // token, because a filesystem path from the server is both useless to the
  // browser and a disclosure of where files live.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const project = join(root, "plate-1.3mf");
  writeFileSync(project, "PKfake");

  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      emit({
        type: "action",
        label: "Open in PrusaSlicer",
        kind: "open-project",
        filePath: project,
        hint: "Downloads the plate.",
      });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });

  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "open it" }),
    });
    const body = await resp.text();
    const action = body
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)))
      .find((f) => f.type === "action");

    assert.ok(action, "the action must reach the browser");
    assert.equal(action.label, "Open in PrusaSlicer");
    assert.match(action.href, /^\/api\/gcode\/[0-9a-f]+$/, "must be a session token");
    assert.equal(action.filePath, undefined, "the server path must not be disclosed");
    assert.ok(!JSON.stringify(action).includes(root), "no server path anywhere in the frame");
  } finally {
    await close();
  }
});

test("a second turn in the same tab is a 409 with code `busy`, distinguishable from no_key", async () => {
  // Both refusals are 409, so the CODE is the only thing telling the UI whether
  // to show the key card or simply wait and re-enable the composer.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      await new Promise((r) => setTimeout(r, 150));
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const post = () =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
      });

    const first = post();
    // Let the first turn reach the handler and mark the session busy.
    await new Promise((r) => setTimeout(r, 40));
    const second = await post();

    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string; code?: string };
    assert.equal(body.code, "busy");

    await (await first).text(); // drain the streaming turn
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
