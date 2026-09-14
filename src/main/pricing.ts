// What a thousand tokens costs — the one place Slicely writes prices down.
//
// Every number below is a LIST PRICE IN INTEGER CENTS PER 1,000,000 TOKENS.
// The owner may edit this table when a provider changes its rates, and nothing
// else in the codebase needs to change: the meter, the balance display and the
// free tier all read it from here.
//
// Money is counted in µ¢ — millionths of a cent, 1,000,000 µ¢ = 1¢. Because a
// price is cents per 1M tokens, `tokens × rate` IS the cost in µ¢: integer
// arithmetic from end to end, no division, no float, nothing rounding to zero.
// That is the whole reason the unit exists.
//
// A MODEL WITH NO ROW IS NEVER METERED — it is not given away free. `priceFor`
// throws `UnpricedModelError`, the funding resolver turns that into a paused
// free tier, and the completeness test in pricing.test.ts fails for any model
// in MODEL_CATALOG that is missing here. Metering an unpriced model at zero is
// the one failure mode that costs the owner real money silently.
//
// One honest imprecision, on the OpenAI side: OPENAI DOES NOT ITEMISE CACHE
// WRITES. Its `usage.input_tokens` is the total, with
// `input_tokens_details.cached_tokens` broken out of it, so the 1.25× premium
// on writing a cold prefix is invisible to us and `cacheWriteTokens` is always
// 0 for an OpenAI turn. The meter therefore under-reports an OpenAI turn by at
// most 25% of one prefix per cache epoch (30 minutes), which the global daily
// spend cap bounds. Anthropic reports writes explicitly, so this does not
// apply there.
//
// Sources, checked 2026-09-14: Anthropic list prices per the current model
// table (input/output), with cached reads at 0.1× and cache writes at 1.25× of
// the input rate, which is Anthropic's published multiplier for every model
// here. OpenAI figures from developers.openai.com/api/docs/pricing, recorded in
// .superpowers/sdd/2026-09-12-public-launch/research-openai-signin.md §4.4
// (luna's cache write is that page's 1.25× multiplier, not a separate figure).

/** Cents per 1,000,000 tokens. Integers, so `tokens × rate` is the cost in µ¢
 *  (millionths of a cent) with no division and no float. */
export interface ModelPrice {
  input: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  // $2 / $0.20 / $2.50 / $10 per 1M
  "claude-sonnet-5": { input: 200, cachedRead: 20, cacheWrite: 250, output: 1000 },
  // $5 / $0.50 / $6.25 / $25 per 1M
  "claude-opus-4-8": { input: 500, cachedRead: 50, cacheWrite: 625, output: 2500 },
  // $3 / $0.30 / $3.75 / $15 per 1M
  "claude-sonnet-4-6": { input: 300, cachedRead: 30, cacheWrite: 375, output: 1500 },
  // $1 / $0.10 / $1.25 / $5 per 1M
  "claude-haiku-4-5": { input: 100, cachedRead: 10, cacheWrite: 125, output: 500 },
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // $2 / $0.20 / $2.50 / $12 per 1M
  "gpt-5.6-terra": { input: 200, cachedRead: 20, cacheWrite: 250, output: 1200 },
  // $0.20 / $0.02 / $0.25 / $1.20 per 1M
  "gpt-5.6-luna": { input: 20, cachedRead: 2, cacheWrite: 25, output: 120 },
  // $10 / $1 / $12.50 / $50 per 1M
  "gpt-6-astra": { input: 1000, cachedRead: 100, cacheWrite: 1250, output: 5000 },
};

/** Thrown when a model has no row in PRICE_TABLE. Never charge nothing for a
 *  call we cannot price — pause the free tier and say so instead. */
export class UnpricedModelError extends Error {
  constructor(readonly model: string) {
    super(
      `No price for model "${model}". Add a row to PRICE_TABLE in src/main/pricing.ts.`,
    );
    this.name = "UnpricedModelError";
  }
}

/** The price row for a model. Throws `UnpricedModelError` if there isn't one. */
export function priceFor(model: string): ModelPrice {
  const price = PRICE_TABLE[model];
  if (!price) throw new UnpricedModelError(model);
  return price;
}

/** Can this model be metered at all? Ask before offering it on free credit. */
export function isPriced(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICE_TABLE, model);
}

/** What one provider call consumed. Lives here, not in provider.ts, so the
 *  meter and the providers share one shape without provider.ts having to
 *  import the price table. */
export interface TurnUsage {
  /** Input tokens billed at the full rate (i.e. NOT served from cache). */
  inputTokens: number;
  /** Input tokens served from the prompt cache, at the cheap read rate. */
  cachedInputTokens: number;
  /** Tokens written to the cache, at the write premium. Always 0 on OpenAI —
   *  see the file header. */
  cacheWriteTokens: number;
  /** Output tokens, reasoning tokens included. */
  outputTokens: number;
}

/**
 * A token count as a provider claimed it, turned into something the ledger can
 * hold: a non-negative integer.
 *
 * `costMicros` multiplies straight through with no division, which is what keeps
 * money integral end to end — so one float, one numeric string or one negative
 * from an upstream shape change would quietly stop the ledger being integral,
 * and a negative would be a negative CHARGE. Anything that is not a finite
 * number counts as nothing reported for that field.
 */
export function tokenCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.trunc(raw));
}

/**
 * Build a `TurnUsage` with every field clamped by `tokenCount`.
 *
 * THE ONLY SANCTIONED WAY TO MAKE ONE. Both providers go through it, so neither
 * can hand the meter a number the other couldn't, and the guard sits next to the
 * function whose arithmetic depends on the invariant. It lives here rather than
 * in provider.ts because provider.ts builds `PROVIDERS` at module load from the
 * two provider modules, so a runtime import back from them would be a cycle —
 * and pricing.ts is a leaf, which is the whole reason `TurnUsage` is here too.
 */
export function toTurnUsage(parts: {
  inputTokens: unknown;
  cachedInputTokens: unknown;
  cacheWriteTokens: unknown;
  outputTokens: unknown;
}): TurnUsage {
  return {
    inputTokens: tokenCount(parts.inputTokens),
    cachedInputTokens: tokenCount(parts.cachedInputTokens),
    cacheWriteTokens: tokenCount(parts.cacheWriteTokens),
    outputTokens: tokenCount(parts.outputTokens),
  };
}

/** The cost of one provider call, in µ¢. Every component is charged at its own
 *  rate; `tokens × centsPer1M` is already µ¢, so there is nothing to divide. */
export function costMicros(model: string, usage: TurnUsage): number {
  const price = priceFor(model);
  return (
    usage.inputTokens * price.input +
    usage.cachedInputTokens * price.cachedRead +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.outputTokens * price.output
  );
}

/** 1,000,000 µ¢ = 1¢. */
export const MICROS_PER_CENT = 1_000_000;

/** A whole-cent amount (an env var, a grant) as µ¢. */
export function centsToMicros(cents: number): number {
  return cents * MICROS_PER_CENT;
}

/** µ¢ as money a person reads: 5,000,000 → "$0.05". Floors rather than
 *  rounding, so a balance never reads higher than it is, and clamps at zero so
 *  a small end-of-turn overshoot shows as "$0.00" rather than a negative. All
 *  integer maths — no float drift. */
export function formatMoney(micros: number): string {
  const cents = Math.floor(Math.max(0, micros) / MICROS_PER_CENT);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
