// ─────────────────────────────────────────────────────────────────────────────
// account-copy.test.ts — the sentences the client says for the eight account
// codes.
//
// A `code` is the contractually stable half of a wire error, and the client
// authors its own sentence for each one (see CODE_COPY in api.ts). That is only
// safe if the sentence AGREES with the one the server was specified to send: a
// user who is told two different things about the same refusal, depending on
// which door it came through, has found a real bug.
//
// So this file pins them to the design spec, verbatim
// (docs/superpowers/specs/2026-09-15-accounts-free-tier-design.md §10.5 and the
// plan's Task C1), and pins the house rules for any sentence a user reads: short
// enough to take in at a glance, no jargon, no machine unit, no path, and never
// the word "error" — the card it lands in is already an error.
//
// It runs in Node (tsconfig.json compiles the client to CommonJS under
// dist/web alongside the server's tests) and touches no DOM: api.ts's module
// body is constants and functions only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeMessage } from "./api.js";

/** The eight new stable codes and the exact sentence each must read as. Copied
 *  from the spec, not from the implementation — a test that reads the source it
 *  checks proves nothing. */
const ACCOUNT_CODE_COPY: Record<string, string> = {
  signin_required: "Sign in to start — you get free credit to try Slicely.",
  credit_exhausted: "You've used your free credit. Add your own API key to keep going.",
  free_tier_paused:
    "Free usage is busy today. Add your own API key to keep going, or come back tomorrow.",
  signup_limited:
    "Too many new accounts from your network today. Try again tomorrow, or use your own API key.",
  email_unverified:
    "That account has no verified email address. Verify one with your provider, or try the other button.",
  email_blocked: "That email address can't be used here. Try another, or use your own API key.",
  oauth_failed: "That sign-in didn't complete. Try again.",
  // The eighth, added after the spec was written: a blocked ACCOUNT, refused by
  // funding.ts before any provider call and before the own-key branch. It is the
  // one sentence here that offers no way out, because there is none the reader
  // can take alone — and it must not hint at one, or a blocked person spends the
  // afternoon pasting keys.
  account_blocked: "This account can't use Slicely.",
};

test("every new account code has the spec's sentence, to the byte", () => {
  for (const [code, sentence] of Object.entries(ACCOUNT_CODE_COPY)) {
    assert.equal(codeMessage(code), sentence, code);
  }
});

test("the waitlist's own 400 has a sentence too — it is shown under a field", () => {
  // `email_invalid` is a waitlist-only 400 and is deliberately NOT a chat code,
  // but the sheet still has to say something when an address is refused.
  assert.equal(codeMessage("email_invalid"), "That doesn't look like an email address.");
});

test("no sentence is long, jargon, a path, or calls itself an error", () => {
  for (const code of Object.keys(ACCOUNT_CODE_COPY)) {
    const said = codeMessage(code);
    assert.ok(said && said.length > 0, `${code} says nothing`);
    assert.ok(said.length <= 160, `${code} is ${said.length} characters — too long to read at a glance`);
    assert.ok(!said.includes("µ¢"), `${code} leaks the meter's unit`);
    assert.ok(!said.includes("/"), `${code} contains a path or a slash`);
    assert.ok(!/error/i.test(said), `${code} says "error" — the card it lands in already does`);
    assert.ok(/[.!]$/.test(said), `${code} is not a sentence`);
  }
});

test("the codes that were already stable still read the way they did", () => {
  // The additions must not disturb what the existing failures say.
  assert.equal(codeMessage("key_rejected"), "Your API key was rejected — update it in Settings.");
  assert.equal(codeMessage("no_session"), "Reload Slicely to start a new session.");
  assert.equal(codeMessage("rate_limited"), "Slow down a little — try again in a few seconds");
  assert.equal(codeMessage("no_key"), undefined, "no_key keeps the server's own, provider-naming sentence");
});
