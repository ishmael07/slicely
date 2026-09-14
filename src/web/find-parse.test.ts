// ─────────────────────────────────────────────────────────────────────────────
// find-parse.test.ts — the composer's decision: search, or conversation?
//
// `deterministicFind` is the only thing standing between a typed line and a
// chat turn that costs money. Its two failure modes are NOT symmetrical:
//
//   • A false NEGATIVE ("find me a vase" → chat) costs a few cents and the user
//     still gets what they asked for.
//   • A false POSITIVE ("find a vase and slice it" → search) silently does HALF
//     of what was asked, with nothing on screen saying the second half was
//     dropped.
//
// So this file spends most of its assertions on the negatives, and the rule under
// test is deliberately narrow: a bare find/search phrase, and nothing else.
//
// Runs in Node (tsconfig.json compiles the client to CommonJS under dist/web)
// and touches no DOM — chat.ts's module body is declarations only, and this test
// calls one pure function.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicFind } from "./chat.js";

/** The line arrives with a transcript already on screen unless a case says
 *  otherwise: mid-conversation is the state the composer is in most of the
 *  time, and the strict one. */
const mid = {};
const opening = { opening: true };

test("a bare find phrase is a search, whatever the phrasing", () => {
  const cases: Array<[string, string]> = [
    ["find me a phone stand", "phone stand"],
    ["find a cable clip", "cable clip"],
    ["search for a vase", "vase"],
    ["search vase", "vase"],
    ["looking for a dice tower", "dice tower"],
    ["look for a wall hook", "wall hook"],
    ["show me a low-poly bunny", "low-poly bunny"],
    ["can you find me a raspberry pi case", "raspberry pi case"],
    ["please find a cable clip", "cable clip"],
    // Case and trailing punctuation are noise: search is case-insensitive at
    // every source, so one normalised form is the answer.
    ["FIND ME A VASE", "vase"],
    ["find me a phone stand.", "phone stand"],
    ["Find me a Phone Stand!", "phone stand"],
  ];
  for (const [typed, want] of cases) {
    assert.equal(deterministicFind(typed, mid), want, `"${typed}" is a search for "${want}"`);
  }
});

test("a second clause or a second job means the model, not the search route", () => {
  const cases = [
    "find a phone stand and slice it for PETG",
    "find me a vase, then slice it",
    "find a cable clip and tell me which is strongest",
    "find me something to print",
    "find a phone stand that fits my desk",
    "search for a vase and compare the two best",
    "find the bracket I downloaded earlier",
  ];
  for (const typed of cases) {
    assert.equal(deterministicFind(typed, mid), undefined, `"${typed}" is more than a search`);
  }
});

test("a question, an empty verb and a paste are all conversation", () => {
  const cases = ["what should I print?", "find me a vase?", "find", "search for", "", "   ", "https://thangs.com/3d-model/vase-1234"];
  for (const typed of cases) {
    assert.equal(deterministicFind(typed, mid), undefined, `"${typed}" names no search`);
  }
});

test("a verb-less noun phrase searches only as the opening line", () => {
  // "phone stand" typed into an empty transcript is a search box being used as
  // a search box. The same two words typed after Slicely asked "what shall I
  // look for?" are an answer, and answering it with twelve cards and no reply
  // would be a regression.
  assert.equal(deterministicFind("phone stand", opening), "phone stand");
  assert.equal(deterministicFind("cable clip", opening), "cable clip");
  assert.equal(deterministicFind("vase", opening), "vase");
  assert.equal(deterministicFind("phone stand", mid), undefined);
  assert.equal(deterministicFind("cable clip", mid), undefined);
});

test("an opening line that is talking, not searching, still goes to the model", () => {
  const cases = [
    "hello",
    "hi there",
    "yes please",
    "thanks",
    "what should i print",
    "can you help me",
    "slice it for PETG",
    "make me a cube",
    "i want a vase",
    "print this",
  ];
  for (const typed of cases) {
    assert.equal(deterministicFind(typed, opening), undefined, `"${typed}" is not a query`);
  }
});

test("a query too long for /api/find is never sent to it", () => {
  // The route refuses over 200 characters, so the client must not offer them —
  // a 400 in the transcript would read as "search is broken".
  const long = `find me a ${"phone stand ".repeat(40)}`;
  assert.equal(deterministicFind(long, opening), undefined);
  // And a sentence-length phrase is a sentence even when it fits.
  assert.equal(deterministicFind("find me a small light strong quiet printable phone stand", mid), undefined);
});
