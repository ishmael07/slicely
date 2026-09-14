// One line per provider call, saying what it cost.
//
// Prompt caching is invisible when it works and invisible when it stops: the
// request still succeeds, the answers are still good, and the only symptom is a
// bill 60% higher. A per-call line is how the owner notices from the logs instead
// of from the invoice — `grep '\[cost\]'` and the cache-read column tells the
// story at a glance.
//
// IT CARRIES NO CONTENT AND NO IDENTITY. Not the prompt, not the reply, not the
// key, not the email, not the account id, not the session id. These lines are
// shipped to wherever logs are shipped, for every call of every visitor's turn,
// so the only safe rule is that they hold nothing but numbers and a model name.
// cost-budget.test.ts asserts exactly that.
import type { TurnUsage } from "../pricing";

export interface CostLine {
  model: string;
  usage: TurnUsage;
  /** The call's cost in µ¢, from `costMicros`. */
  micros: number;
  /** Whose credit paid: the visitor's own key, or the owner's free tier. */
  source: "user" | "free";
  /** Which iteration of the tool loop this was, from 0. */
  iteration: number;
}

/**
 * The ceiling one user turn may cost, in µ¢ — 6¢.
 *
 * Sized against the spec's §4.3 worked turn: 4.71¢ with caching, 7.65¢ without.
 * The budget sits between them ON PURPOSE, so the test that guards it fails when
 * caching stops working rather than only when a price moves.
 */
export const TURN_BUDGET_MICROS = 6_000_000;

/**
 * Write one cost line to stderr.
 *
 * stderr rather than stdout because this is operational, not output, and one
 * `write` rather than `console.log` so the line cannot be interleaved with a
 * concurrent visitor's.
 */
export function logTurnCost(line: CostLine): void {
  const u = line.usage;
  process.stderr.write(
    `[cost] model=${line.model} src=${line.source} it=${line.iteration}` +
      ` in=${u.inputTokens} cacheRead=${u.cachedInputTokens} cacheWrite=${u.cacheWriteTokens}` +
      ` out=${u.outputTokens} micros=${line.micros}\n`,
  );
}
