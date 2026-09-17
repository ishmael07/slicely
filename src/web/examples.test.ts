// The empty state's example prompts are drawn from a pool. What has to hold:
// three lines, all distinct, all from the pool, and the draw actually varies
// with the randomness it is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_POOL, pickExamples } from "./onboarding";

function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

test("three distinct prompts, every one from the pool", () => {
  for (let seed = 1; seed < 50; seed++) {
    const picked = pickExamples(3, seeded(seed));
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3);
    for (const p of picked) assert.ok(EXAMPLE_POOL.includes(p), p);
  }
});

test("different randomness gives different draws", () => {
  const draws = new Set(Array.from({ length: 30 }, (_, i) => pickExamples(3, seeded(i + 1)).join("|")));
  assert.ok(draws.size > 10, `only ${draws.size} distinct draws in 30`);
});

test("the pool is large enough that the same three are rare", () => {
  assert.ok(EXAMPLE_POOL.length >= 15);
  assert.equal(new Set(EXAMPLE_POOL).size, EXAMPLE_POOL.length);
});
