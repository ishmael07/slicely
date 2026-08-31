// Tests for POST /api/chat's SSE wire format and /api/chat/cancel — using an
// injected stub ChatAgent (see session.ts's ChatAgent + index.ts's
// chatAgentFactory option) so this never constructs a real SlicelyAgent,
// never touches the Anthropic SDK, and makes no network call regardless of
// whether a real ANTHROPIC_API_KEY happens to be configured in the
// environment this test runs in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
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
  const { base, close } = await listen(createApp({ sessionStore: store, chatAgentFactory: stub }));
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const { base, close } = await listen(createApp({ sessionStore: store, chatAgentFactory: stub }));
  try {
    const first = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await first.text(); // drain the SSE stream before reusing the connection
    const cookie = first.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "the chat turn should have minted a session cookie");

    const cancelResp = await fetch(`${base}/api/chat/cancel`, {
      method: "POST",
      headers: { cookie: cookie! },
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

  const { base, close } = await listen(createApp({ sessionStore: store, chatAgentFactory: stub }));
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
