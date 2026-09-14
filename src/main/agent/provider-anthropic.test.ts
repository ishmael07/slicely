// Block-mapping parity for the Anthropic provider: the neutral history the
// agent keeps has to survive a round trip through Anthropic's own shapes
// without losing a thinking block, a tool id, or an is_error flag — because a
// dropped thinking block is a 400 on the next turn and a dropped tool id is a
// silent mis-correlation.
//
// Nothing here touches the network: the mappers are pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_KEY_RE,
  buildAnthropicParams,
  fromAnthropicHistory,
  fromAnthropicMessage,
  toAnthropicMessages,
  toAnthropicTools,
} from "./provider-anthropic";
import { getProvider } from "./provider";
import type { NeutralMessage, StreamRequest } from "./provider";

test("neutral messages map onto Anthropic content params, losing nothing", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig" };
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "slice it" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", opaque: thinking },
        { type: "text", text: "on it" },
        { type: "tool_use", id: "toolu_1", name: "slice_model", input: { path: "uploads/a.stl" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", id: "toolu_1", content: "done" },
        { type: "tool_result", id: "toolu_2", content: "Error: nope", isError: true },
      ],
    },
  ];

  const out = toAnthropicMessages(messages) as unknown as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { role: "user", content: [{ type: "text", text: "slice it" }] });
  // A reasoning block is replayed VERBATIM — its signature is what makes the
  // next turn legal.
  assert.deepEqual(out[1].content[0], thinking);
  assert.deepEqual(out[1].content[2], {
    type: "tool_use",
    id: "toolu_1",
    name: "slice_model",
    input: { path: "uploads/a.stl" },
  });
  assert.deepEqual(out[2].content[0], { type: "tool_result", tool_use_id: "toolu_1", content: "done" });
  assert.deepEqual(out[2].content[1], {
    type: "tool_result",
    tool_use_id: "toolu_2",
    content: "Error: nope",
    is_error: true,
  });
});

test("an Anthropic final message becomes neutral blocks plus the tool calls to run", () => {
  const final = {
    content: [
      { type: "thinking", thinking: "reasoned", signature: "sig" },
      { type: "text", text: "here you go" },
      { type: "tool_use", id: "toolu_9", name: "find_models", input: { query: "cube" } },
      { type: "redacted_thinking", data: "opaque-bytes" },
    ],
  };

  const { assistant, toolCalls } = fromAnthropicMessage(final as never);
  assert.deepEqual(
    assistant.map((b) => b.type),
    ["reasoning", "text", "tool_use", "reasoning"],
  );
  assert.deepEqual(assistant[0], { type: "reasoning", opaque: final.content[0] });
  assert.deepEqual(assistant[3], { type: "reasoning", opaque: final.content[3] });
  assert.deepEqual(toolCalls, [{ id: "toolu_9", name: "find_models", input: { query: "cube" } }]);
});

test("a v1 (untagged Anthropic) history imports as neutral messages", () => {
  // Chats saved before the provider seam existed hold raw Anthropic
  // MessageParam[], including the string-content form.
  const v1 = [
    { role: "user", content: "find me a cube" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "toolu_3", name: "find_models", input: { query: "cube" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "1 result", is_error: false }] },
  ];

  const neutral = fromAnthropicHistory(v1);
  assert.equal(neutral.length, 3);
  assert.deepEqual(neutral[0], { role: "user", content: [{ type: "text", text: "find me a cube" }] });
  assert.deepEqual(neutral[1].content[1], {
    type: "tool_use",
    id: "toolu_3",
    name: "find_models",
    input: { query: "cube" },
  });
  assert.deepEqual(neutral[2].content[0], { type: "tool_result", id: "toolu_3", content: "1 result" });

  // Garbage in a hand-edited chats.json must not throw — it just yields nothing.
  assert.deepEqual(fromAnthropicHistory("nonsense"), []);
  assert.deepEqual(fromAnthropicHistory([{ role: "nobody" }]), []);
});

test("a ToolSpec becomes an Anthropic tool with input_schema", () => {
  const [tool] = toAnthropicTools([
    { name: "slice_model", description: "Slice it.", schema: { type: "object", properties: {} } },
  ]) as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(tool, {
    name: "slice_model",
    description: "Slice it.",
    input_schema: { type: "object", properties: {} },
    // The LAST tool closes the cached prefix; with one tool, that is this one.
    cache_control: { type: "ephemeral" },
  });
});

test("the key pattern still refuses subscription tokens, and the help names the console", () => {
  assert.ok(ANTHROPIC_KEY_RE.test("sk-ant-api03-" + "a".repeat(40)));
  assert.equal(ANTHROPIC_KEY_RE.test("sk-ant-oat01-" + "a".repeat(40)), false);

  const provider = getProvider("anthropic");
  assert.equal(provider.id, "anthropic");
  assert.equal(provider.keyPattern.source, ANTHROPIC_KEY_RE.source);
  assert.match(provider.keyHelp.consoleUrl, /console\.anthropic\.com/);
  assert.match(provider.keyHelp.formatMessage("sk-ant-oat01-xxxx"), /Pro\/Max|subscription/i);
  assert.match(provider.keyHelp.formatMessage(""), /Paste/i);
});

test("an unreadable block in a tool pair drops the whole pair, not just the block", () => {
  // Dropping one block silently was the quiet bug: a `tool_use` whose sibling
  // block failed to convert left a `tool_result` referring to a call that no
  // longer exists, and Anthropic answers that with a 400 on the very next
  // message. Both halves go, or neither.
  const v1 = [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling a tool" },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
        { type: "tool_use", id: "toolu_bad", name: "find_models", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bad", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  const neutral = fromAnthropicHistory(v1);
  const kinds = neutral.map((m) => m.content.map((b) => b.type).join("+"));
  assert.deepEqual(kinds, ["text", "text"], "the lossy pair and its result are both gone");
  assert.deepEqual(neutral[1], { role: "assistant", content: [{ type: "text", text: "done" }] });

  // A clean pair is untouched...
  const clean = fromAnthropicHistory([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "n", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ]);
  assert.equal(clean.length, 2);

  // ...and an unanswered tool_use goes too: history that ends on one is a 400
  // as soon as the next user message is appended.
  const unanswered = fromAnthropicHistory([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "t2", name: "n", input: {} }] },
  ]);
  assert.deepEqual(unanswered, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "on it" }] },
  ]);

  // An unrecognised block OUTSIDE a tool pair is still just dropped — there is
  // no counterpart for it to invalidate.
  const prose = fromAnthropicHistory([
    { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "something_new" }] },
  ]);
  assert.deepEqual(prose, [{ role: "assistant", content: [{ type: "text", text: "hello" }] }]);
});

test("each provider owns its per-turn output cap", () => {
  // Anthropic's max_tokens counts only the reply; OpenAI's max_output_tokens
  // also counts reasoning, so one number cannot serve both.
  assert.equal(getProvider("anthropic").maxOutputTokens, 16000);
  assert.ok(getProvider("openai").maxOutputTokens > getProvider("anthropic").maxOutputTokens);
});

// ── usage ────────────────────────────────────────────────────────────────────

test("a final message's token usage comes back as a TurnUsage", () => {
  // Anthropic's `input_tokens` ALREADY EXCLUDES the cached part, so the four
  // fields map across one-for-one with no subtraction. Getting that wrong the
  // other way (subtracting the cache read) would under-bill every call.
  const final = {
    content: [{ type: "text", text: "done" }],
    usage: {
      input_tokens: 400,
      cache_read_input_tokens: 6000,
      cache_creation_input_tokens: 0,
      output_tokens: 250,
    },
  };
  const { usage } = fromAnthropicMessage(final as never);
  assert.deepEqual(usage, {
    inputTokens: 400,
    cachedInputTokens: 6000,
    cacheWriteTokens: 0,
    outputTokens: 250,
  });
});

test("a message with no usage reports NOTHING, not zero", () => {
  // The difference is load-bearing: "nothing reported" is an anomaly that is
  // charged nothing and logged, while "nothing used" is a real free call. A
  // zeroed object would hide the first inside the second.
  const { usage } = fromAnthropicMessage({ content: [{ type: "text", text: "hi" }] } as never);
  assert.equal(usage, undefined);
});

test("a nonsense usage report is clamped to non-negative integers", () => {
  // costMicros multiplies straight through, so one float or one negative here
  // stops the ledger being integral. The guard belongs where usage is BUILT.
  const final = {
    content: [{ type: "text", text: "x" }],
    usage: {
      input_tokens: -5,
      cache_read_input_tokens: 10.7,
      cache_creation_input_tokens: null,
      output_tokens: "250",
    },
  };
  const { usage } = fromAnthropicMessage(final as never);
  assert.deepEqual(usage, {
    inputTokens: 0,
    cachedInputTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
});

// ── prompt caching ───────────────────────────────────────────────────────────

/** A minimal request, so each test names only the field it cares about. */
function request(over: Partial<StreamRequest> = {}): StreamRequest {
  return {
    apiKey: "sk-ant-api03-test",
    model: "claude-sonnet-5",
    effort: "medium",
    system: "You are Slicely.",
    tools: [
      { name: "find_models", description: "Search every source.", schema: { type: "object", properties: {} } },
      { name: "slice_model", description: "Slice it.", schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "find a cube" }] }],
    maxOutputTokens: 16_000,
    ...over,
  };
}

test("the system prompt is one cached text block, byte-identical to what was asked for", () => {
  const params = buildAnthropicParams(request()) as unknown as {
    system: Array<{ type: string; text: string; cache_control?: unknown }>;
  };
  assert.ok(Array.isArray(params.system), "a cache breakpoint needs a block array, not a bare string");
  assert.equal(params.system.length, 1);
  assert.equal(params.system[0].type, "text");
  // BYTE-FOR-BYTE. A cache hit is a prefix match on the rendered bytes, so any
  // trimming, joining or normalising here silently costs the whole prefix.
  assert.equal(params.system[0].text, "You are Slicely.");
  assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
});

test("exactly one tool carries the breakpoint, and it is the last one", () => {
  const tools = buildAnthropicParams(request()).tools as Array<Record<string, unknown>>;
  // The render order is tools → system → messages, so a breakpoint on the LAST
  // tool covers every tool before it. On the first tool it would cover one.
  assert.equal(tools.filter((t) => t.cache_control).length, 1);
  assert.deepEqual(tools[tools.length - 1].cache_control, { type: "ephemeral" });
  assert.equal(tools[0].cache_control, undefined);
});

test("the whole request carries exactly two cache breakpoints", () => {
  // Anthropic allows four. This is not a place to be sloppy: a fifth is a 400,
  // and a breakpoint on something volatile is a prefix that never matches.
  const json = JSON.stringify(buildAnthropicParams(request()));
  assert.equal(json.split('"cache_control"').length - 1, 2);
});

test("no message block is ever marked cacheable", () => {
  // The messages are the volatile part. A breakpoint inside them would be
  // rewritten every turn, which is a cache write with no read to follow it.
  const params = buildAnthropicParams(
    request({
      messages: [
        { role: "user", content: [{ type: "text", text: "find a cube" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "slice_model", input: {} }] },
        { role: "user", content: [{ type: "tool_result", id: "toolu_1", content: "sliced" }] },
      ],
    }),
  );
  assert.equal(JSON.stringify(params.messages).includes("cache_control"), false);
});

test("the cached prefix is byte-stable across turns, whatever the conversation does", () => {
  // THE INVARIANT THAT MAKES CACHING WORK AT ALL. Two turns of the same session
  // differ only in their messages; if the tools or the system block differ by one
  // byte, the prefix is re-billed at full price on every call.
  const first = buildAnthropicParams(request());
  const second = buildAnthropicParams(
    request({
      messages: [
        { role: "user", content: [{ type: "text", text: "something else entirely" }] },
        { role: "assistant", content: [{ type: "text", text: "sure" }] },
        { role: "user", content: [{ type: "text", text: "and again" }] },
      ],
    }),
  );
  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools));
  assert.deepEqual(second.system, first.system);
});

test("the same tools serialise identically twice — order is never left to chance", () => {
  const tools = request().tools;
  assert.equal(
    JSON.stringify(buildAnthropicParams(request({ tools })).tools),
    JSON.stringify(buildAnthropicParams(request({ tools })).tools),
  );
});
