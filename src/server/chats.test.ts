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
import { loadChats, saveChats, newChat, appendTurn, titleFrom, summarise } from "./chats";

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
