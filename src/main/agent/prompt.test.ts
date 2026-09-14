// The system prompt as a BUDGET, not just as prose.
//
// Every byte here is resent on every provider call — up to twelve per user
// message — so the prompt and the tool block are the single largest recurring
// cost in the product. These tests are the guard rail: a window rather than a
// maximum, because over-trimming is its own failure (a prefix under 1,024 tokens
// will not be cached at all, and caching is what makes 50 cents of free credit
// buy a real trial).
//
// They also pin the sentences the product depends on. The prompt is the ONLY
// place some of Slicely's rules are stated, so a line disappearing from it is a
// product decision, not a tidy-up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./tools";
import { SYSTEM_PROMPT, estimateTokens, staticPrefixTokens } from "./prompt";

const CACHE_FLOOR = 1024; // claude-sonnet-5 will not cache a shorter prefix
const CEILING = 6000; // our budget — see the spec's worked example

test("the static prefix is small enough to be cheap and big enough to be cacheable", () => {
  const n = staticPrefixTokens(TOOLS);
  assert.ok(n >= CACHE_FLOOR, `prefix is ${n} tokens — under ${CACHE_FLOOR} it will not cache at all`);
  assert.ok(n <= CEILING, `prefix is ${n} tokens — over budget, every call pays for it`);
});

test("the system prompt fits in 7 KB and the tool descriptions in 5 KB", () => {
  assert.ok(Buffer.byteLength(SYSTEM_PROMPT) <= 7_000, `prompt is ${Buffer.byteLength(SYSTEM_PROMPT)} bytes`);
  const descriptions = TOOLS.map((t) => t.description).join("");
  assert.ok(Buffer.byteLength(descriptions) <= 5_000, `descriptions are ${Buffer.byteLength(descriptions)} bytes`);
});

test("trimming did not throw away anything the product depends on", () => {
  // Each entry is a behaviour the prompt is the ONLY place that states. If a line
  // here has to change, that is a product decision, not a tidy-up.
  const required: Array<[string, RegExp]> = [
    ["find, slice, print — and not CAD", /\bno CAD\b|do not (model|design)|never (model|design)/i],
    ["prints are never started unsupervised", /arm(ed)?|never start(s)? a print|only .* asked/i],
    ["model licences must be respected", /licen[cs]e/i],
    ["millimetres", /\bmm\b|millimet/i],
    ["ask before destructive printer actions", /confirm|ask (first|before)/i],
  ];
  for (const [why, re] of required) {
    assert.ok(re.test(SYSTEM_PROMPT), `the prompt no longer says: ${why}`);
  }
});

test("nothing volatile is in the prompt, or caching never hits", () => {
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT), "no date");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(SYSTEM_PROMPT), "no uuid");
  assert.ok(!/\/Users\/|\/home\/|\/data\//.test(SYSTEM_PROMPT), "no absolute path");
});

test("every tool still has a description, and none is a one-word stub", () => {
  for (const t of TOOLS) {
    assert.ok(t.description.trim().length >= 20, `${t.name} lost its description`);
  }
});

test("the estimator is crude but monotonic, and the prefix is the prompt plus the tools", () => {
  // Deliberately bytes/4: an exact count needs the API, and this has to run
  // offline in CI. `npm run tokens` prints the real figure and says how far off
  // this is. Monotonicity is the only property the budget test relies on.
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("a".repeat(400)) === 100);
  assert.ok(staticPrefixTokens(TOOLS) > staticPrefixTokens([]));
  assert.ok(staticPrefixTokens([]) >= estimateTokens(SYSTEM_PROMPT));
});
