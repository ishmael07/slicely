// Capping a conversation so it stops growing forever.
//
// The message array is the part of a request that CANNOT be cached — it changes
// every turn by definition — so it is re-billed in full, at the full input rate,
// on every one of up to twelve provider calls per user message. A long tool
// result therefore gets paid for dozens of times, and a long conversation pays
// for its own beginning over and over.
//
// The danger in fixing that is worse than the cost: drop half of a
// tool_use/tool_result pair and BOTH providers answer 400 — on this turn and on
// every reopening of the saved chat. So nothing here removes a block. Old bodies
// are truncated in place, and the cut at the front lands only where the history
// is legal to start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capHistory, TRUNCATED_NOTE } from "./history";
import type { NeutralBlock, NeutralMessage } from "./provider";

/** One tool round: an assistant turn making `n` parallel calls, and the user
 *  message answering all of them. */
function round(i: number, n = 1, body = "x".repeat(4000)): NeutralMessage[] {
  const calls: NeutralBlock[] = [];
  const results: NeutralBlock[] = [];
  for (let c = 0; c < n; c++) {
    const id = `call_${i}_${c}`;
    calls.push({ type: "tool_use", id, name: "find_models", input: { query: "cube" } });
    results.push({ type: "tool_result", id, content: `${body}-${id}` });
  }
  return [
    { role: "assistant", content: calls },
    { role: "user", content: results },
  ];
}

/** A conversation of `n` user→assistant exchanges, each with one tool round. */
function conversation(n: number, parallel = 1): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `ask ${i}` }] });
    out.push(...round(i, parallel));
    out.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
  }
  return out;
}

function allResults(messages: NeutralMessage[]): Array<Extract<NeutralBlock, { type: "tool_result" }>> {
  return messages.flatMap((m) =>
    m.content.filter((b: NeutralBlock): b is Extract<NeutralBlock, { type: "tool_result" }> => b.type === "tool_result"),
  );
}

test("a long history is cut to the most recent turns, and starts somewhere legal", () => {
  const history = conversation(10); // 40 messages
  const capped = capHistory(history, { maxTurns: 12 });

  assert.ok(capped.length <= 24, `kept ${capped.length} messages`);
  // The LAST ones: the newest message survives, or the cap has cut the wrong end.
  assert.deepEqual(capped.at(-1), history.at(-1));
  // A history that starts on an assistant turn is a 400 on both providers, and
  // so is one that starts on a tool_result whose call is gone.
  assert.equal(capped[0].role, "user");
  assert.equal(
    capped[0].content.some((b) => b.type === "tool_result"),
    false,
    "the first message must not be an answer to a call that was cut away",
  );
});

test("every call still has its answer, and every answer still has its call", () => {
  // Three parallel calls per round, because a partial batch is the shape that
  // breaks: cutting between the assistant turn and its results orphans three at
  // once. maxTurns 5 is chosen so the naive cut point (length - 2 × maxTurns)
  // lands exactly on a tool_result message — the case a plain slice gets wrong.
  const history = conversation(10, 3);
  assert.ok(
    history[history.length - 10].content.some((b) => b.type === "tool_result"),
    "the fixture must put a tool_result at the naive cut point, or this proves nothing",
  );
  const capped = capHistory(history, { maxTurns: 5 });
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of capped) {
    for (const b of m.content) {
      if (b.type === "tool_use") uses.add(b.id);
      else if (b.type === "tool_result") results.add(b.id);
    }
  }
  assert.deepEqual([...uses].sort(), [...results].sort());
  assert.ok(uses.size > 0, "the fixture must actually contain tool calls");
});

test("an old tool result keeps its block and its id, and loses only its body", () => {
  const capped = capHistory(conversation(6), { maxTurns: 12, keepBodies: 2, maxResultChars: 2000 });
  const results = allResults(capped);
  const trimmed = results.filter((r) => r.content.endsWith(TRUNCATED_NOTE));
  assert.ok(trimmed.length > 0, "nothing was trimmed — the fixture is too small");
  for (const r of trimmed) {
    assert.ok(r.content.length <= 2000, `a trimmed result is still ${r.content.length} chars`);
    assert.match(r.id, /^call_\d+_\d+$/, "the id must survive, or the pair is orphaned");
  }
});

test("the newest rounds keep their bodies byte-for-byte", () => {
  const history = conversation(6);
  const capped = capHistory(history, { maxTurns: 12, keepBodies: 2, maxResultChars: 2000 });
  const original = allResults(history);
  const kept = allResults(capped).slice(-2);
  const originalTail = original.slice(-2);
  assert.deepEqual(kept, originalTail);
});

test("a reasoning block is never truncated, reordered or dropped", () => {
  // Its bytes are what make the next turn legal — a signature (Anthropic) or
  // encrypted content (OpenAI) that cannot be rebuilt.
  const reasoning: NeutralBlock = { type: "reasoning", opaque: { id: "rs_1", data: "y".repeat(5000) } };
  const history: NeutralMessage[] = [
    ...conversation(4),
    { role: "user", content: [{ type: "text", text: "again" }] },
    { role: "assistant", content: [reasoning, { type: "tool_use", id: "call_z", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: "call_z", content: "z" }] },
  ];
  const capped = capHistory(history, { maxTurns: 12 });
  const last = capped.at(-2);
  assert.deepEqual(last?.content[0], reasoning);
});

test("capping twice is capping once — a trimmed note is never re-trimmed", () => {
  const once = capHistory(conversation(8), { maxTurns: 6, keepBodies: 2, maxResultChars: 500 });
  const twice = capHistory(once, { maxTurns: 6, keepBodies: 2, maxResultChars: 500 });
  assert.deepEqual(twice, once);
});

test("an empty history, and a history of one message, come back as they were", () => {
  assert.deepEqual(capHistory([]), []);
  const one: NeutralMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  assert.deepEqual(capHistory(one), one);
});

test("the input array is never mutated — the user's own transcript depends on it", () => {
  const history = conversation(8);
  const before = structuredClone(history);
  capHistory(history, { maxTurns: 4, keepBodies: 1, maxResultChars: 100 });
  assert.deepEqual(history, before);
});
