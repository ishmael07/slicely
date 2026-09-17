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
import { SYSTEM_PROMPT, buildSystemPrompt, estimateTokens, staticPrefixTokens } from "./prompt";

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

test("BOTH modes stay inside the window, and share their cached bytes", () => {
  // The prompt differs by mode now, and each deployment pays for its own
  // variant — so the budget is a property of both, not of whichever one this
  // test process happens to be running as.
  const hosted = buildSystemPrompt("hosted");
  const desktop = buildSystemPrompt("desktop");
  for (const [mode, prompt] of [["hosted", hosted], ["desktop", desktop]] as const) {
    const n = estimateTokens(prompt + JSON.stringify(TOOLS));
    assert.ok(n >= CACHE_FLOOR, `${mode} prefix is ${n} tokens — under ${CACHE_FLOOR} it will not cache`);
    assert.ok(n <= CEILING, `${mode} prefix is ${n} tokens — over budget`);
    assert.ok(Buffer.byteLength(prompt) <= 7_000, `${mode} prompt is ${Buffer.byteLength(prompt)} bytes`);
  }
  // A SUFFIX, so the two variants are the same bytes up to the difference — and
  // so a mode note can never quietly rewrite a rule stated above it.
  assert.ok(hosted.startsWith(desktop), "the hosted prompt must be the desktop one plus a suffix");
  assert.ok(hosted.length > desktop.length, "hosted must actually say the extra thing");
});

test("hosted tells the model it has no screen to open anything on", () => {
  // The bug this pins: a browser user was told three times in one turn that
  // PrusaSlicer was now open in front of them. The tools no longer say it; the
  // prompt is what stops the model saying it unprompted.
  const hosted = buildSystemPrompt("hosted");
  assert.match(hosted, /server/i, "it must say where it runs");
  assert.match(hosted, /never say you opened|cannot open|can open/i, "it must say what it cannot do");
  assert.match(hosted, /\.3mf/, "and what open_in_slicer really produces there");
  assert.ok(
    !/YOU ARE RUNNING ON A SERVER/.test(buildSystemPrompt("desktop")),
    "the Mac app must not be told it is a server",
  );
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
