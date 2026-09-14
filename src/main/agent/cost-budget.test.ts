// A budget the build enforces.
//
// Prompt caching is invisible when it works and invisible when it stops working:
// the request still succeeds, the answers are still good, and the only symptom is
// a bill that is 60% higher. So the guard is arithmetic over the spec's own worked
// turn (§4.3) — and the assertion that matters is the SECOND one, which says the
// same turn WITHOUT caching busts the budget. That is what makes this a regression
// test for D2 and D3 rather than a restatement of the price table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costMicros, centsToMicros, type TurnUsage } from "../pricing";
import { logTurnCost, TURN_BUDGET_MICROS } from "./cost-log";

/** The free-tier model. The budget is about its bill and nobody else's. */
const MODEL = "claude-sonnet-5";

/**
 * Spec §4.3 — one "find me a phone stand" turn: four provider calls (search,
 * details, slice, answer) over a ~6,000-token static prefix.
 *
 *   call      cache write   cache read   uncached in   out
 *   search        6,000          —            400      250
 *   details         —          6,000        1,550      200
 *   slice           —          6,000        2,950      220
 *   answer          —          6,000        3,770      450
 *   total         6,000       18,000        8,670    1,120
 */
const CACHED: TurnUsage = {
  cacheWriteTokens: 6_000,
  cachedInputTokens: 18_000,
  inputTokens: 8_670,
  outputTokens: 1_120,
};

/** The same four calls with caching off: the prefix is re-read at the full input
 *  rate on every one of them, so 6,000 × 4 lands in `inputTokens` instead. */
const UNCACHED: TurnUsage = {
  cacheWriteTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 6_000 * 4 + 8_670,
  outputTokens: 1_120,
};

test("a typical turn stays inside the per-turn budget, with caching", () => {
  //   6,000 × 250  = 1,500,000  cache write
  //  18,000 ×  20  =   360,000  cache read
  //   8,670 × 200  = 1,734,000  uncached input
  //   1,120 × 1000 = 1,120,000  output
  //                  ─────────
  //                  4,714,000 µ¢ = 4.71¢
  const micros = costMicros(MODEL, CACHED);
  assert.equal(micros, 4_714_000);
  assert.ok(micros <= TURN_BUDGET_MICROS, `${micros} µ¢ is over the ${TURN_BUDGET_MICROS} µ¢ budget`);
});

test("THE SAME TURN WITHOUT CACHING BUSTS THE BUDGET — which is the point", () => {
  // (6,000 × 4 + 8,670) × 200 + 1,120,000 = 7,654,000 µ¢ = 7.65¢.
  // If prompt caching silently stops working — a marker dropped from the
  // Anthropic request, a byte moving in the OpenAI prefix — this is what every
  // turn costs. The test fails on that, not merely on a price change.
  const micros = costMicros(MODEL, UNCACHED);
  assert.equal(micros, 7_654_000);
  assert.ok(
    micros > TURN_BUDGET_MICROS,
    "the uncached turn must be OVER budget, or the budget is not protecting anything",
  );
});

test("fifty cents of free credit buys between 8 and 12 turns like this", () => {
  // The range the owner signed off. If a price change or a prompt change moves it
  // outside, someone has to look at it rather than discover it from the bill.
  const turns = Math.floor(centsToMicros(50) / costMicros(MODEL, CACHED));
  assert.ok(turns >= 8 && turns <= 12, `50¢ buys ${turns} turns`);
});

test("a cost line is one line, greppable, and carries nothing private", () => {
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  try {
    logTurnCost({ model: MODEL, usage: CACHED, micros: 4_714_000, source: "free", iteration: 2 });
  } finally {
    (process.stderr as { write: unknown }).write = real;
  }

  assert.equal(written.length, 1, "one call, one line");
  const line = written[0];
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trimEnd().includes("\n"), false, "the line must stay greppable");
  assert.match(line, /micros=4714000/);
  assert.match(line, /model=claude-sonnet-5 src=free it=2/);
  assert.match(line, /in=8670 cacheRead=18000 cacheWrite=6000 out=1120/);

  // NOTHING PRIVATE. This runs on the owner's server, in logs that get shipped
  // somewhere, for every call of every visitor's turn.
  for (const forbidden of ["sk-", "@", "prompt", "Bearer"]) {
    assert.equal(line.includes(forbidden), false, `the cost line leaked: ${forbidden}`);
  }
  assert.doesNotMatch(line, /[0-9a-f]{32}/, "no account id, session id or key hash");
});
