import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG } from "./settings";
import {
  PRICE_TABLE,
  priceFor,
  isPriced,
  costMicros,
  formatMoney,
  centsToMicros,
  MICROS_PER_CENT,
  UnpricedModelError,
  type TurnUsage,
} from "./pricing";

test("every model a user can pick has a price — an unpriced model would meter at zero", () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(isPriced(m.id), `${m.id} has no row in PRICE_TABLE`);
  }
  assert.ok(isPriced("claude-sonnet-5"), "the free-tier Anthropic model must be priced");
  assert.ok(isPriced("gpt-5.6-luna"), "the free-tier OpenAI model must be priced");
});

test("an unpriced model is refused, never silently free", () => {
  assert.equal(isPriced("claude-imaginary-9"), false);
  assert.throws(() => priceFor("claude-imaginary-9"), UnpricedModelError);
});

test("Sonnet 5 costs what Anthropic charges, expressed as cents per million", () => {
  assert.deepEqual(PRICE_TABLE["claude-sonnet-5"], {
    input: 200,
    cachedRead: 20,
    cacheWrite: 250,
    output: 1000,
  });
  assert.deepEqual(PRICE_TABLE["gpt-5.6-luna"], {
    input: 20,
    cachedRead: 2,
    cacheWrite: 25,
    output: 120,
  });
});

test("the worked example from the spec costs exactly 4,714,000 µ¢", () => {
  // Spec §4.3: one "find me a phone stand" turn, four provider calls.
  const usage: TurnUsage = {
    inputTokens: 8_670,
    cachedInputTokens: 18_000,
    cacheWriteTokens: 6_000,
    outputTokens: 1_120,
  };
  assert.equal(costMicros("claude-sonnet-5", usage), 4_714_000);
  // 4.714¢ — so a 50¢ grant is ten and a bit turns like this.
  assert.equal(
    Math.floor(centsToMicros(50) / costMicros("claude-sonnet-5", usage)),
    10,
  );
});

test("the same turn with no caching costs 7,654,000 µ¢ — caching is what buys the trial", () => {
  const uncached: TurnUsage = {
    inputTokens: 6_000 * 4 + 8_670,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_120,
  };
  assert.equal(costMicros("claude-sonnet-5", uncached), 7_654_000);
});

test("money reads like money, and integer maths has no rounding surprises", () => {
  assert.equal(MICROS_PER_CENT, 1_000_000);
  assert.equal(centsToMicros(50), 50_000_000);
  assert.equal(formatMoney(50_000_000), "$0.50");
  assert.equal(formatMoney(42_400_000), "$0.42"); // floors, never rounds up
  assert.equal(formatMoney(999_999), "$0.00");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(-5), "$0.00"); // a small overshoot shows as empty, not negative
});

test("a zero usage costs zero, and every component is charged at its own rate", () => {
  const zero: TurnUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
  assert.equal(costMicros("claude-sonnet-5", zero), 0);
  assert.equal(
    costMicros("claude-sonnet-5", { ...zero, inputTokens: 1_000_000 }),
    200_000_000,
  );
  assert.equal(
    costMicros("claude-sonnet-5", { ...zero, cachedInputTokens: 1_000_000 }),
    20_000_000,
  );
  assert.equal(
    costMicros("claude-sonnet-5", { ...zero, cacheWriteTokens: 1_000_000 }),
    250_000_000,
  );
  assert.equal(
    costMicros("claude-sonnet-5", { ...zero, outputTokens: 1_000_000 }),
    1_000_000_000,
  );
});
