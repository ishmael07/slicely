// ─────────────────────────────────────────────────────────────────────────────
// composer-gate.test.ts — who is allowed to type, and what a pressed Send does.
//
// The free search route (`POST /api/find`) needs no key, no account and no
// credit. Spec §1.3 promises it to everybody: "a visitor who never signs in can
// still search, paste links, upload, slice, preview and print." That promise was
// broken on the client, not the wire — the composer itself was switched off
// whenever `canChat()` was false, so the two people the free route exists for,
// the signed-out visitor and the one whose credit ran out, could not type a line
// into it.
//
// So the decision a pressed Send makes is a function of its own here, and this
// file pins the branch that regressed: a bare search goes to /api/find even when
// there is nothing to pay a model with, and only a line that really needs the
// model is refused.
//
// It also pins the empty state's choice (spec §1.2.4): a reload on a spent
// balance is not a first run, and must not be shown "Connect an AI provider to
// start" as though the visitor had never begun.
//
// Runs in Node and touches no DOM — both functions under test are pure, and the
// modules they live in have declaration-only bodies.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSendChat, routeComposerSubmit, SEARCH_ONLY_PLACEHOLDER, type ComposerRoute } from "./chat.js";
import { emptyStateKind } from "./onboarding.js";
import { accountBlocked, creditExhausted, hasFreeCredit, markBlocked } from "./account.js";
import { resetSession, setAccount } from "./api.js";

/** The composer as a stranger sees it: no key, no credit, an empty transcript. */
const strangerOpening = { hasFiles: false, opening: true, canChat: false };
/** The same visitor mid-conversation. */
const strangerMid = { hasFiles: false, opening: false, canChat: false };

function kind(route: ComposerRoute): string {
  return route.kind;
}

test("a bare search is a search even with no key and no credit — the whole point of /api/find", () => {
  // Every one of these was unreachable while the textarea was disabled.
  const searches = ["find me a phone stand", "search for a vase", "looking for a dice tower"];
  for (const text of searches) {
    const route = routeComposerSubmit({ ...strangerMid, text });
    assert.equal(kind(route), "search", `"${text}" must reach /api/find without an account`);
    assert.ok(route.kind === "search" && route.query.length > 0, `"${text}" carries a query`);
  }
  // And the verb-less opening line, which is a search only as the first thing said.
  assert.equal(kind(routeComposerSubmit({ ...strangerOpening, text: "phone stand" })), "search");
});

test("whether a line is a search never depends on being able to chat", () => {
  for (const text of ["find me a phone stand", "phone stand", "find me a phone stand and slice it", "hello"]) {
    const off = routeComposerSubmit({ ...strangerOpening, text });
    const on = routeComposerSubmit({ ...strangerOpening, text, canChat: true });
    assert.equal(off.kind === "search", on.kind === "search", `"${text}" changes route with the gate`);
    if (off.kind === "search" && on.kind === "search") assert.equal(off.query, on.query, text);
  }
});

test("a conversation with nothing to pay for it is refused on the client, not sent", () => {
  // These all need the model: the second clause, the pronoun, the greeting.
  for (const text of ["find me a phone stand and slice it", "slice it for PETG", "hello"]) {
    assert.equal(kind(routeComposerSubmit({ ...strangerMid, text })), "refuse", text);
    assert.equal(kind(routeComposerSubmit({ ...strangerMid, text, canChat: true })), "chat", text);
  }
});

test("staged files are never a search — an attachment is a request to act on it", () => {
  // "find me a phone stand" with a file staged is about the file.
  const text = "find me a phone stand";
  assert.equal(kind(routeComposerSubmit({ text, hasFiles: true, opening: true, canChat: true })), "chat");
  assert.equal(kind(routeComposerSubmit({ text, hasFiles: true, opening: true, canChat: false })), "refuse");
});

test("nothing typed and nothing staged does nothing at all", () => {
  assert.equal(kind(routeComposerSubmit({ text: "", hasFiles: false, opening: true, canChat: true })), "empty");
  assert.equal(kind(routeComposerSubmit({ text: "", hasFiles: false, opening: true, canChat: false })), "empty");
});

test("the search-only invitation says what the box can still do, in one sentence-case line", () => {
  assert.equal(SEARCH_ONLY_PLACEHOLDER, "Search for something to print…");
  // No small print, no second sentence, no shouting.
  assert.ok(!SEARCH_ONLY_PLACEHOLDER.includes("."), "no full stop, and so no second sentence");
  assert.equal(SEARCH_ONLY_PLACEHOLDER, SEARCH_ONLY_PLACEHOLDER.trim());
});

test("a reload on a spent balance gets the exhausted card, not the first-run card", () => {
  assert.equal(emptyStateKind({ hasKey: false, freeCredit: false, exhausted: true }), "exhausted");
  // A stranger still gets the first-run card, and anybody who can chat gets neither.
  assert.equal(emptyStateKind({ hasKey: false, freeCredit: false, exhausted: false }), "connect");
  assert.equal(emptyStateKind({ hasKey: false, freeCredit: true, exhausted: false }), "invitation");
  assert.equal(emptyStateKind({ hasKey: true, freeCredit: false, exhausted: false }), "invitation");
  // A key of their own outranks a spent grant: they are not out of anything.
  assert.equal(emptyStateKind({ hasKey: true, freeCredit: false, exhausted: true }), "invitation");
});

test("the account store puts a signed-in, spent-out visitor in exactly that state", () => {
  resetSession();
  setAccount({
    signedIn: true,
    account: {
      email: "jane@example.com",
      initial: "J",
      balanceMicros: 0,
      balanceLabel: "$0.00",
      grantedMicros: 50_000_000,
      grantedLabel: "$0.50",
      chatsToday: 11,
      chatsPerDay: 40,
      exhausted: true,
    },
  });
  assert.equal(hasFreeCredit(), false);
  assert.equal(creditExhausted(), true);
  assert.equal(
    emptyStateKind({ hasKey: false, freeCredit: hasFreeCredit(), exhausted: creditExhausted() }),
    "exhausted",
  );
  resetSession();
});

test("a blocked account cannot chat even holding a key or free credit — blocking overrides either", () => {
  resetSession();
  assert.equal(accountBlocked(), false, "nothing marked it yet");
  assert.equal(canSendChat(true), true, "a key or credit alone is enough before any refusal lands");

  markBlocked();
  assert.equal(accountBlocked(), true);
  assert.equal(canSendChat(true), false, "blocked overrides a key or credit that would otherwise pay for the turn");
  assert.equal(canSendChat(false), false);

  // A conversation is refused client-side rather than sent for the server to
  // refuse again, but a bare search — no model, no money — is untouched.
  assert.equal(kind(routeComposerSubmit({ ...strangerMid, text: "hello", canChat: canSendChat(true) })), "refuse");
  assert.equal(
    kind(routeComposerSubmit({ ...strangerMid, text: "find me a phone stand", canChat: canSendChat(true) })),
    "search",
    "a bare search still reaches /api/find while blocked",
  );

  // Leave the flag as this test found it, so it cannot leak into another test
  // that shares this module instance.
  setAccount({ signedIn: false });
  resetSession();
});

test("signing out clears the blocked flag, so a different account gets its own answer", () => {
  resetSession();
  markBlocked();
  assert.equal(accountBlocked(), true);

  // signOut() itself just forgets the account the same way — this pins the
  // underlying rule (cleared the moment the store says nobody is signed in)
  // without touching the DOM signOut() also updates.
  setAccount({ signedIn: false });
  assert.equal(accountBlocked(), false, "a fresh sign-in must not inherit the last account's refusal");
  assert.equal(canSendChat(true), true);

  resetSession();
});
