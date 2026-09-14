// A conversation that stops growing forever.
//
// The message array is the one part of a request that CANNOT be cached: it
// changes every turn by definition, so it is re-billed in full, at the full input
// rate, on every one of up to twelve provider calls per user message. A 40 KB
// tool result therefore gets paid for dozens of times before the turn ends, and a
// long conversation keeps paying for its own beginning.
//
// The obvious fix is more dangerous than the cost. Drop half of a
// tool_use/tool_result pair and BOTH providers answer 400 — not just on this turn
// but on every reopening of the saved chat, because the history is what gets
// written to disk. So NOTHING HERE REMOVES A BLOCK. Old bodies are truncated in
// place, keeping the block and its id, and the cut at the front lands only where
// a history is legal to begin.
import type { NeutralBlock, NeutralMessage } from "./provider";

/**
 * How many turns of history to keep. A "turn" is a user message and the
 * assistant's reply, so the message ceiling is twice this.
 *
 * A LOCAL CONSTANT ON PURPOSE, for now: the plan gives this to
 * `getConfig().maxHistoryTurns` (`SLICELY_MAX_HISTORY_TURNS`, default 12), and
 * that field arrives with the accounts lane. When it lands, pass it in at the
 * call site in agent.ts rather than reading the environment from two places.
 */
export const MAX_HISTORY_TURNS = 12;

/** How many recent tool rounds keep their results in full. */
const KEEP_BODIES = 2;

/** The ceiling on one older tool_result's body, in characters. */
const MAX_RESULT_CHARS = 2_000;

export interface CapOptions {
  /** Default `MAX_HISTORY_TURNS`. */
  maxTurns?: number;
  /** How many recent tool rounds keep full results. Default 2. */
  keepBodies?: number;
  /** Per tool_result, for the rounds that are kept. Default 2000. */
  maxResultChars?: number;
}

/**
 * What an older tool result says instead of its body.
 *
 * Addressed to the MODEL, and honest with it: the content is gone, nothing failed,
 * and there is no point asking for it again. Ending the string with this is also
 * how a second pass recognises its own work — see the idempotence note below.
 */
export const TRUNCATED_NOTE = "… (earlier result trimmed to save credit)";

/**
 * Cap a history for sending.
 *
 * Returns a NEW array and never mutates the input, because the caller's copy is
 * the user's transcript and their saved chat — this is what goes on the wire, not
 * what goes on disk. agent.ts keeps both, and the distinction is the whole point.
 *
 * IDEMPOTENT. `capHistory(capHistory(h))` equals `capHistory(h)`: a truncated
 * body is exactly `maxResultChars` characters or fewer, so a second pass finds
 * nothing over the limit and leaves the note alone rather than trimming a trimmed
 * note into nonsense.
 */
export function capHistory(messages: NeutralMessage[], opts: CapOptions = {}): NeutralMessage[] {
  const maxTurns = opts.maxTurns ?? MAX_HISTORY_TURNS;
  const keepBodies = opts.keepBodies ?? KEEP_BODIES;
  const maxResultChars = opts.maxResultChars ?? MAX_RESULT_CHARS;

  const kept = messages.slice(cutFrom(messages, maxTurns));

  // Which messages are tool-result messages, newest last. The last `keepBodies`
  // of them are the rounds the model is still actively working with; everything
  // older is history it has already summarised into its own prose.
  const resultIndices: number[] = [];
  for (const [i, m] of kept.entries()) {
    if (m.content.some((b) => b.type === "tool_result")) resultIndices.push(i);
  }
  const trimBefore = resultIndices.length > keepBodies ? resultIndices[resultIndices.length - keepBodies] : -1;

  return kept.map((m, i) => ({
    role: m.role,
    content: i < trimBefore ? m.content.map((b) => trimBlock(b, maxResultChars)) : [...m.content],
  }));
}

/**
 * Where the kept history starts.
 *
 * Not simply `length - 2 × maxTurns`: that index can land on an assistant turn
 * (a 400 on both providers) or on a `tool_result` message whose `tool_use` has
 * just been cut away (also a 400, and a subtler one). So the cut walks FORWARD
 * from the ideal point to the first user message that carries no tool_result —
 * the only kind of message a conversation may legally begin with. If there is no
 * such message, nothing is cut: a history that cannot be shortened safely is
 * better expensive than broken.
 */
function cutFrom(messages: NeutralMessage[], maxTurns: number): number {
  const ideal = messages.length - 2 * maxTurns;
  if (ideal <= 0) return 0;
  for (let i = ideal; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && !m.content.some((b) => b.type === "tool_result")) return i;
  }
  return 0;
}

/** Truncate one older `tool_result` body. Every other block type is returned
 *  untouched — a reasoning blob's bytes are what make the next turn legal, and a
 *  `tool_use`'s arguments are what its answer is an answer to. */
function trimBlock(block: NeutralBlock, maxResultChars: number): NeutralBlock {
  if (block.type !== "tool_result" || block.content.length <= maxResultChars) return block;
  const head = block.content.slice(0, Math.max(0, maxResultChars - TRUNCATED_NOTE.length));
  const trimmed: NeutralBlock = { type: "tool_result", id: block.id, content: head + TRUNCATED_NOTE };
  if (block.isError) trimmed.isError = true;
  return trimmed;
}
