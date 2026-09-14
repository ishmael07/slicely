// Tests for saved conversations.
//
// The subtle requirement is that a chat stores TWO things: the transcript, so
// it can be redrawn, and the agent's own history, so reopening it CONTINUES
// the conversation. Storing only the transcript would redraw the words while
// the model started from nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadChats, saveChats, newChat, appendTurn, titleFrom, summarise } from "./chats";
import { createApp } from "./index";
import { SessionStore } from "./session";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "slicely-chats-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a chat is named from the first thing the user said", () => {
  const chat = newChat();
  assert.equal(chat.title, "New chat");
  appendTurn(chat, { role: "user", text: "print me a buff pikachu with a tail" });
  assert.equal(chat.title, "print me a buff pikachu with a tail");
  // A later message must not rename it out from under the user.
  appendTurn(chat, { role: "assistant", text: "sure" });
  appendTurn(chat, { role: "user", text: "actually make it blue" });
  assert.equal(chat.title, "print me a buff pikachu with a tail");
});

test("a long opening message is truncated to stay readable in a list", () => {
  const long = "a".repeat(200);
  assert.ok(titleFrom(long).length <= 48);
  assert.match(titleFrom(long), /…$/);
  assert.equal(titleFrom("   "), "New chat");
  assert.equal(titleFrom("  spaced   out  "), "spaced out");
});

test("chats round-trip to disk with their agent history intact", () => {
  withDir((dir) => {
    const chat = newChat();
    appendTurn(chat, { role: "user", text: "hello" });
    appendTurn(chat, { role: "assistant", text: "hi" });
    chat.agentHistory = [{ role: "user", content: "hello" }];
    saveChats(dir, [chat]);

    const back = loadChats(dir);
    assert.equal(back.length, 1);
    assert.equal(back[0].turns.length, 2);
    assert.deepEqual(
      back[0].agentHistory,
      [{ role: "user", content: "hello" }],
      "without this the model starts blank while the words are redrawn",
    );
  });
});

test("a missing or corrupt store starts empty rather than throwing", () => {
  withDir((dir) => {
    assert.deepEqual(loadChats(dir), []);
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(dir, "chats.json"), "{not json", "utf8");
    assert.deepEqual(loadChats(dir), []);
  });
});

test("listing is newest first", () => {
  withDir((dir) => {
    const older = newChat();
    older.title = "older";
    older.updatedAt = 1000;
    const newer = newChat();
    newer.title = "newer";
    newer.updatedAt = 2000;
    saveChats(dir, [older, newer]);
    assert.deepEqual(summarise(loadChats(dir)).map((c) => c.title), ["newer", "older"]);
  });
});

test("the store is bounded, so a long-lived session cannot grow forever", () => {
  withDir((dir) => {
    const many = Array.from({ length: 60 }, (_, i) => {
      const c = newChat();
      c.updatedAt = i;
      return c;
    });
    saveChats(dir, many);
    assert.ok(loadChats(dir).length <= 30, "old chats should be dropped");
  });

  const chat = newChat();
  for (let i = 0; i < 300; i++) appendTurn(chat, { role: "user", text: `m${i}` });
  assert.ok(chat.turns.length <= 200, "turns within one chat are bounded too");
  // The most recent turns are the ones kept.
  assert.equal(chat.turns[chat.turns.length - 1].text, "m299");
});

// ── Task D7: a GET never has a side effect ───────────────────────────────────
//
// `GET /api/chats/:id` used to switch the session's ACTIVE chat and reload the
// model's memory from it. That made an ordinary read — something a browser
// prefetcher, a link preview, a `<link rel=prefetch>`, or any cross-origin
// `<img src>` can trigger without the user meaning anything by it — silently
// rewrite the state of the conversation the user was actually in. Reading is
// now read-only; switching is an explicit POST.
async function chatsApp(): Promise<{
  base: string;
  cookie: string;
  sessionId: string;
  store: SessionStore;
  close: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "slicely-chats-http-"));
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const server: Server = createServer(createApp({ sessionStore: store }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // The boot call mints the session — it is the only endpoint that may (see
  // session.ts's MINTING_ROUTES) — then its cookie is reused for everything.
  const first = await fetch(`${base}/api/config`);
  const raw = first.headers.get("set-cookie");
  assert.ok(raw, "the first API call should mint a session cookie");
  const cookie = raw.split(";")[0];
  const sessionId = cookie.slice(cookie.indexOf("=") + 1).split(".")[0];
  assert.ok(store.get(sessionId), "the cookie should name a live session record");

  return {
    base,
    cookie,
    sessionId,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.stopSweep();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("reading a chat does not switch to it; activating it does", async () => {
  const app = await chatsApp();
  const { base, cookie, sessionId, store } = app;
  const headers = { cookie, "Content-Type": "application/json" };
  try {
    const mk = async (): Promise<string> => {
      const resp = await fetch(`${base}/api/chats`, { method: "POST", headers, body: "{}" });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as { chat: { id: string } };
      return body.chat.id;
    };
    const a = await mk();
    const b = await mk();

    // Make `a` the active chat again, so switching to `b` would be observable.
    const back = await fetch(`${base}/api/chats/${a}/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(back.status, 200);
    assert.equal(store.get(sessionId)?.activeChatId, a);

    // THE READ: it answers with the chat and changes nothing.
    const read = await fetch(`${base}/api/chats/${b}`, { headers: { cookie } });
    assert.equal(read.status, 200);
    const readBody = (await read.json()) as { id: string; turns: unknown[] };
    assert.equal(readBody.id, b);
    assert.ok(Array.isArray(readBody.turns));
    assert.equal(
      store.get(sessionId)?.activeChatId,
      a,
      "a GET must not move the session's active chat",
    );

    // THE WRITE: an explicit POST is what switches.
    const act = await fetch(`${base}/api/chats/${b}/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(act.status, 200);
    assert.equal((await act.json() as { id: string }).id, b);
    assert.equal(store.get(sessionId)?.activeChatId, b);

    // A chat that isn't this session's is a plain 404 from both verbs.
    const missingRead = await fetch(`${base}/api/chats/nope`, { headers: { cookie } });
    assert.equal(missingRead.status, 404);
    assert.equal(((await missingRead.json()) as { code?: string }).code, "not_found");
    const missingAct = await fetch(`${base}/api/chats/nope/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(missingAct.status, 404);
  } finally {
    await app.close();
  }
});

test("printer discovery is a POST — the GET is gone", async () => {
  const app = await chatsApp();
  const { base, cookie } = app;
  try {
    // A LAN scan spends seconds of mDNS/SSDP time and mutates nothing the
    // caller owns, but it is exactly the kind of expensive side effect a GET
    // must not carry: it was reachable from any page's <img src>.
    const gone = await fetch(`${base}/api/printers/discover`, { headers: { cookie } });
    assert.equal(gone.status, 404, "GET /api/printers/discover must no longer exist");

    // The POST exists. Hosted mode (the test default) refuses LAN discovery
    // with its own code, which is proof enough that the route is wired.
    const post = await fetch(`${base}/api/printers/discover`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutMs: 10 }),
    });
    assert.equal(post.status, 403);
    assert.equal(((await post.json()) as { code?: string }).code, "forbidden_in_hosted_mode");
  } finally {
    await app.close();
  }
});
