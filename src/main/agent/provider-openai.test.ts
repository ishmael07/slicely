// The OpenAI provider, entirely offline.
//
// Three things are worth pinning down, and they are the three that break
// silently when you port a tool loop to the Responses API:
//
//  1. THE REQUEST SHAPE. Function tools are flat here, not nested under
//     "function" as in Chat Completions; `store` defaults to TRUE, which would
//     leave 30 days of a user's conversation in OpenAI's dashboard; and with
//     `store: false` there is no server-side state, so reasoning continuity
//     needs `include: ["reasoning.encrypted_content"]` replayed by us.
//  2. THE STREAM. Wire event names are dotted, `error` has no `response.`
//     prefix, and the authoritative item comes on `response.output_item.done`
//     (on `.added` a reasoning item's encrypted content may be incomplete).
//  3. THE FAILURES. A 429 is retryable, but a 429 whose code is a quota/spend
//     limit is not — backing off forever on those is the classic
//     bring-your-own-key bug, so they map to `billing`, not `rate_limited`.
//
// The SSE text below is a recorded-shape fixture, not a live capture; nothing
// here opens a socket and no test needs a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_KEY_RE,
  OPENAI_PROVIDER,
  OpenAiError,
  buildResponsesBody,
  openAiErrorFrom,
  parseSseFrames,
  readErrorBody,
  readTurn,
  toOpenAiInput,
  toOpenAiTools,
} from "./provider-openai";
import type { NeutralMessage, StreamDelta, StreamRequest } from "./provider";

/** Feed a fixture through the parser the way a fetch body would arrive: in
 *  arbitrary chunks, with frame boundaries falling mid-chunk. */
async function* chunked(text: string, size = 37): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

function frame(obj: unknown): string {
  const type = (obj as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** One turn: a reasoning item, some streamed text, a function call, done. */
const TURN_WITH_TOOL_CALL =
  frame({ type: "response.created", sequence_number: 0, response: { id: "resp_1" } }) +
  frame({ type: "response.in_progress", sequence_number: 1, response: { id: "resp_1" } }) +
  frame({
    type: "response.output_item.added",
    sequence_number: 2,
    output_index: 0,
    item: { id: "rs_1", type: "reasoning", summary: [] },
  }) +
  frame({ type: "response.reasoning_summary_text.delta", sequence_number: 3, delta: "Looking for " }) +
  frame({ type: "response.reasoning_summary_text.delta", sequence_number: 4, delta: "a cube." }) +
  frame({
    type: "response.output_item.done",
    sequence_number: 5,
    output_index: 0,
    item: {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Looking for a cube." }],
      encrypted_content: "gAAAAAB-opaque-bytes",
    },
  }) +
  frame({
    type: "response.output_item.added",
    sequence_number: 6,
    output_index: 1,
    item: { id: "msg_1", type: "message", role: "assistant", content: [] },
  }) +
  frame({ type: "response.output_text.delta", sequence_number: 7, output_index: 1, delta: "Searching" }) +
  frame({ type: "response.output_text.delta", sequence_number: 8, output_index: 1, delta: " now." }) +
  frame({ type: "response.output_text.done", sequence_number: 9, output_index: 1, text: "Searching now." }) +
  frame({
    type: "response.output_item.done",
    sequence_number: 10,
    output_index: 1,
    item: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Searching now.", annotations: [] }],
    },
  }) +
  frame({
    type: "response.output_item.added",
    sequence_number: 11,
    output_index: 2,
    item: { id: "fc_1", call_id: "call_abc", type: "function_call", name: "find_models", arguments: "" },
  }) +
  frame({ type: "response.function_call_arguments.delta", sequence_number: 12, item_id: "fc_1", delta: '{"query"' }) +
  frame({ type: "response.function_call_arguments.delta", sequence_number: 13, item_id: "fc_1", delta: ':"cube"}' }) +
  frame({
    type: "response.function_call_arguments.done",
    sequence_number: 14,
    item_id: "fc_1",
    arguments: '{"query":"cube"}',
  }) +
  frame({
    type: "response.output_item.done",
    sequence_number: 15,
    output_index: 2,
    item: {
      id: "fc_1",
      call_id: "call_abc",
      type: "function_call",
      name: "find_models",
      arguments: '{"query":"cube"}',
      status: "completed",
    },
  }) +
  frame({ type: "response.completed", sequence_number: 16, response: { id: "resp_1", status: "completed" } });

test("a streamed turn becomes neutral blocks, streaming text and reasoning as it goes", async () => {
  const deltas: StreamDelta[] = [];
  const { assistant, toolCalls } = await readTurn(parseSseFrames(chunked(TURN_WITH_TOOL_CALL)), (d) => deltas.push(d));

  // Streamed to the UI: the reasoning summary as thinking, the answer as text.
  assert.deepEqual(deltas, [
    { type: "thinking", text: "Looking for " },
    { type: "thinking", text: "a cube." },
    { type: "text", text: "Searching" },
    { type: "text", text: " now." },
  ]);

  // Kept for history: the reasoning item VERBATIM (its encrypted content is the
  // only way the next turn can carry on reasoning with store:false), the text,
  // and the call.
  assert.deepEqual(
    assistant.map((b) => b.type),
    ["reasoning", "text", "tool_use"],
  );
  assert.equal(assistant[0].type === "reasoning" && (assistant[0].opaque as { encrypted_content: string }).encrypted_content, "gAAAAAB-opaque-bytes");
  assert.deepEqual(assistant[1], { type: "text", text: "Searching now." });
  // Correlated on call_id (`call_…`), never the item id (`fc_…`) — they are
  // different values and mixing them up fails silently.
  assert.deepEqual(assistant[2], {
    type: "tool_use",
    id: "call_abc",
    name: "find_models",
    input: { query: "cube" },
  });
  assert.deepEqual(toolCalls, [{ id: "call_abc", name: "find_models", input: { query: "cube" } }]);
});

test("a bare `error` frame and a failed response both raise a classified failure", async () => {
  const errored =
    frame({ type: "response.created", sequence_number: 0, response: { id: "r" } }) +
    // No `response.` prefix on this one — easy to miss in a switch.
    frame({ type: "error", sequence_number: 1, code: "rate_limit_exceeded", message: "Rate limit reached", param: null });
  await assert.rejects(
    () => readTurn(parseSseFrames(chunked(errored)), () => {}),
    (err: unknown) => err instanceof OpenAiError && err.errorCode === "rate_limit_exceeded",
  );

  const failed = frame({
    type: "response.failed",
    sequence_number: 1,
    response: { id: "r", status: "failed", error: { code: "server_error", message: "upstream blew up" } },
  });
  await assert.rejects(
    () => readTurn(parseSseFrames(chunked(failed)), () => {}),
    (err: unknown) => err instanceof OpenAiError && err.errorCode === "server_error",
  );
});

test("`[DONE]` and comment lines are not events", async () => {
  const noise = ": keep-alive\n\n" + frame({ type: "response.completed", response: {} }) + "data: [DONE]\n\n";
  const { assistant } = await readTurn(parseSseFrames(chunked(noise)), () => {});
  assert.deepEqual(assistant, []);
});

// ── the request ──────────────────────────────────────────────────────────────

function request(over: Partial<StreamRequest> = {}): StreamRequest {
  return {
    apiKey: "sk-proj-" + "x".repeat(40),
    model: "gpt-5.6-terra",
    effort: "high",
    system: "You are Slicely.",
    tools: [{ name: "find_models", description: "Search.", schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "find a cube" }] }],
    maxOutputTokens: 16000,
    ...over,
  };
}

test("the request body carries the system prompt, flat tools, and the privacy-critical defaults", () => {
  const body = buildResponsesBody(request());
  assert.equal(body.model, "gpt-5.6-terra");
  // `instructions` is Slicely's system prompt, and it is resent every turn:
  // previous_response_id does not carry it over, and we do not use that anyway.
  assert.equal(body.instructions, "You are Slicely.");
  assert.equal(body.stream, true);
  // `store` DEFAULTS TO TRUE at OpenAI: leaving it out would hand OpenAI ~30
  // days of the user's conversation and surface it in their dashboard, which
  // contradicts "delete my data means all of it". This is a requirement, not an
  // optimisation.
  assert.equal(body.store, false);
  // The consequence of store:false — with no server-side state, reasoning
  // continuity across a tool loop only works if we replay encrypted_content.
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.stream_options, { include_obfuscation: false });
  assert.equal(body.max_output_tokens, 16000);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);

  // A function tool is INTERNALLY tagged in the Responses API. The Chat
  // Completions shape ({type:"function", function:{…}}) is the single most
  // common porting bug and fails at request time.
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "find_models",
      description: "Search.",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ]);
});

test("effort is clamped to what the chosen model accepts", () => {
  // Every OpenAI model in the catalog takes all five tiers, so the tier passes
  // straight through — but the clamp is the shared one, so an unknown model id
  // (a hand-edited settings.json) simply drops the field rather than 400ing.
  assert.deepEqual(buildResponsesBody(request({ effort: "xhigh" })).reasoning, {
    effort: "xhigh",
    summary: "auto",
  });
  assert.equal(buildResponsesBody(request({ model: "gpt-nonexistent" })).reasoning, undefined);
});

test("neutral history maps onto Responses input items, correlated by call_id", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "find a cube" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", opaque: { id: "rs_1", type: "reasoning", encrypted_content: "opaque" } },
        { type: "text", text: "searching" },
        { type: "tool_use", id: "call_abc", name: "find_models", input: { query: "cube" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", id: "call_abc", content: "1 result" }] },
  ];

  assert.deepEqual(toOpenAiInput(messages), [
    { role: "user", content: "find a cube" },
    { id: "rs_1", type: "reasoning", encrypted_content: "opaque" },
    { role: "assistant", content: "searching" },
    { type: "function_call", call_id: "call_abc", name: "find_models", arguments: '{"query":"cube"}' },
    { type: "function_call_output", call_id: "call_abc", output: "1 result" },
  ]);
});

test("a tool spec keeps one shared JSON Schema — strict is off on purpose", () => {
  // strict:true would demand every property in `required` and
  // additionalProperties:false on every object, which Slicely's Anthropic-shaped
  // schemas (with genuinely optional arguments) do not satisfy. One schema
  // source beats two.
  const [tool] = toOpenAiTools([{ name: "x", description: "d", schema: { type: "object" } }]) as Array<
    Record<string, unknown>
  >;
  assert.equal(tool.strict, false);
  assert.equal(tool.type, "function");
  assert.equal(tool.name, "x");
});

// ── failures ─────────────────────────────────────────────────────────────────

test("401 is key_rejected, a plain 429 is rate_limited, and a quota 429 is billing", () => {
  const classify = (status: number, body: unknown) =>
    OPENAI_PROVIDER.classifyError(openAiErrorFrom(status, JSON.stringify(body)));

  assert.deepEqual(
    classify(401, { error: { message: "Incorrect API key provided: sk-proj-abc", type: "invalid_request_error", code: "invalid_api_key" } }),
    { status: 401, message: "Your API key was rejected — update it in Settings.", code: "key_rejected" },
  );

  const limited = classify(429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.code, "rate_limited");

  // NOT retryable: retrying billing, spend or quota errors cannot restore
  // access, so backing off forever is the wrong answer — the user has to top up.
  for (const code of [
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ]) {
    const failure = classify(429, { error: { message: "no credit", type: "insufficient_quota", code } });
    assert.equal(failure?.code, "billing", `${code} must not be treated as a rate limit`);
    assert.equal(failure?.status, 402);
  }

  // A stored key that stops working through no fault of the user (org-mandated
  // expiry, revocation) is still "re-enter your key", never a transient retry.
  assert.equal(classify(403, { error: { message: "not allowed", code: "access_denied" } })?.code, "key_rejected");

  // Our own request-shape bug is nobody's billing problem and nobody's key.
  assert.equal(classify(400, { error: { message: "Unknown parameter: 'foo'", code: "unknown_parameter" } }), undefined);
  // Neither is an outage at OpenAI.
  assert.equal(classify(503, { error: { message: "overloaded" } }), undefined);

  // Somebody else's error is not this provider's to claim.
  assert.equal(OPENAI_PROVIDER.classifyError(new Error("something local")), undefined);
});

test("the error never carries the upstream body into the message it hands out", () => {
  const err = openAiErrorFrom(401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-SECRET" } }));
  const failure = OPENAI_PROVIDER.classifyError(err);
  assert.ok(failure);
  assert.doesNotMatch(failure!.message, /sk-proj|SECRET/);
});

test("a non-JSON error body does not crash the classifier", () => {
  const err = openAiErrorFrom(429, "<html>502 Bad Gateway</html>");
  assert.equal(OPENAI_PROVIDER.classifyError(err)?.code, "rate_limited");
});

// ── the key ──────────────────────────────────────────────────────────────────

test("the key pattern is loose on shape and firm on what cannot work", () => {
  assert.ok(OPENAI_KEY_RE.test("sk-proj-" + "a".repeat(40)));
  assert.ok(OPENAI_KEY_RE.test("sk-" + "a".repeat(40)), "legacy user keys still exist");
  assert.ok(OPENAI_KEY_RE.test("sk-svcacct-" + "a".repeat(40)));

  // An Admin API key cannot be used for non-administration endpoints, so it
  // would only ever produce a confusing 401 at chat time.
  assert.equal(OPENAI_KEY_RE.test("sk-admin-" + "a".repeat(40)), false);
  // A ChatGPT sign-in token is not an API key, and OpenAI's subscription
  // credential cannot run a custom system prompt at all.
  assert.equal(OPENAI_KEY_RE.test("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop"), false);
  assert.equal(OPENAI_KEY_RE.test("sk-ant-api03-" + "a".repeat(40)), false, "an Anthropic key is not an OpenAI key");
  assert.equal(OPENAI_KEY_RE.test("sk-short"), false);

  assert.match(OPENAI_PROVIDER.keyHelp.formatMessage("sk-admin-" + "a".repeat(40)), /admin/i);
  assert.match(OPENAI_PROVIDER.keyHelp.formatMessage(""), /Paste/i);
  assert.match(OPENAI_PROVIDER.keyHelp.formatMessage("nonsense"), /platform\.openai\.com/);
  // The disappointment worth pre-empting: people expect their ChatGPT Plus to
  // work here, and it cannot.
  assert.match(OPENAI_PROVIDER.keyHelp.formatMessage("nonsense"), /ChatGPT/);
  assert.equal(OPENAI_PROVIDER.keyHelp.placeholder, "sk-…");
  assert.match(OPENAI_PROVIDER.keyHelp.consoleUrl, /platform\.openai\.com/);
});

// ── cancellation and timeouts ────────────────────────────────────────────────
//
// A `fetch` with no signal cannot be cancelled and cannot time out: pressing
// Stop left the socket open and a stalled upstream held a turn (and a session's
// chat slot) forever. Both are wired through `StreamRequest.signal`, combined
// with a hard per-turn ceiling so nothing hangs even when nobody presses Stop.

/** A fake `fetch` standing in for undici: it records what it was called with,
 *  and — like the real one — ERRORS ITS BODY when the signal aborts, which is
 *  what makes an abort mid-stream observable at all. */
function fakeFetch(bodyText: string, keepOpen = false): {
  install: () => void;
  restore: () => void;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const real = globalThis.fetch;
  return {
    calls,
    install() {
      globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        const signal = init.signal as AbortSignal | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(bodyText));
            if (!keepOpen) {
              c.close();
              return;
            }
            // An upstream that has stopped talking but not hung up — the state
            // an abort is the only way out of.
            signal?.addEventListener("abort", () =>
              c.error(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
            );
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = real;
    },
  };
}

test("the stream request carries an abort signal even when the caller supplies none", async () => {
  const fake = fakeFetch(
    frame({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hi" }] } }) +
      frame({ type: "response.completed", response: { id: "r", status: "completed" } }),
  );
  fake.install();
  try {
    const { assistant } = await OPENAI_PROVIDER.stream(request(), () => {});
    assert.deepEqual(assistant, [{ type: "text", text: "hi" }]);
    const signal = fake.calls[0].init.signal as AbortSignal;
    assert.ok(signal instanceof AbortSignal, "an unattended turn still gets the per-turn ceiling");
    assert.equal(signal.aborted, false);
  } finally {
    fake.restore();
  }
});

test("cancelling mid-stream aborts the fetch and ends the turn", async () => {
  const fake = fakeFetch(frame({ type: "response.output_text.delta", delta: "thinking…" }), true);
  fake.install();
  const caller = new AbortController();
  try {
    const deltas: StreamDelta[] = [];
    await assert.rejects(
      OPENAI_PROVIDER.stream({ ...request(), signal: caller.signal }, (d) => {
        deltas.push(d);
        caller.abort();
      }),
      (err: Error) => err.name === "AbortError" || /abort/i.test(err.message),
    );
    assert.deepEqual(deltas, [{ type: "text", text: "thinking…" }]);
    // The signal handed to fetch is a COMPOSITE (caller + ceiling), not the
    // caller's own, and the caller's abort still reaches it.
    const signal = fake.calls[0].init.signal as AbortSignal;
    assert.notEqual(signal, caller.signal);
    assert.equal(signal.aborted, true);
  } finally {
    fake.restore();
  }
});

test("validateKey does not wait forever either", async () => {
  const real = globalThis.fetch;
  const seen: Array<AbortSignal | undefined> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    seen.push(init.signal as AbortSignal | undefined);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await OPENAI_PROVIDER.validateKey("sk-proj-" + "a".repeat(40)), "ok");
    assert.ok(seen[0] instanceof AbortSignal);
  } finally {
    globalThis.fetch = real;
  }
});

// ── truncation ───────────────────────────────────────────────────────────────

test("a response cut short by the output cap returns what it produced", async () => {
  // `max_output_tokens` INCLUDES reasoning tokens on this API, so a long think
  // can end a turn early. A truncated answer is worth far more to the user than
  // the generic 500 a thrown error becomes.
  const truncated =
    frame({
      type: "response.output_item.done",
      item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Here's as far as I got" }] },
    }) +
    frame({
      type: "response.incomplete",
      response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    });
  const { assistant, toolCalls } = await readTurn(parseSseFrames(chunked(truncated)), () => {});
  assert.deepEqual(assistant, [{ type: "text", text: "Here's as far as I got" }]);
  assert.deepEqual(toolCalls, []);
});

test("a response cut short for any other reason is still a failure", async () => {
  const filtered = frame({
    type: "response.incomplete",
    response: { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" } },
  });
  await assert.rejects(readTurn(parseSseFrames(chunked(filtered)), () => {}), OpenAiError);
});

test("the per-turn output cap is the provider's own, and higher than Anthropic's", () => {
  // Reasoning tokens count against this one, so the same 16000 that is generous
  // for Anthropic can truncate an OpenAI answer before it starts speaking.
  assert.equal(OPENAI_PROVIDER.maxOutputTokens, 32000);
  assert.equal(buildResponsesBody(request({ maxOutputTokens: OPENAI_PROVIDER.maxOutputTokens })).max_output_tokens, 32000);
});

// ── reasoning replay ─────────────────────────────────────────────────────────

test("reasoning is replayed only on the newest assistant turn, and only with its tool call", () => {
  // The Responses API requires a reasoning item to be followed by the function
  // call it reasoned about. Replaying every past turn's reasoning puts one in
  // front of a plain user message, which is a 400 — the failure that makes a
  // second message in a chat impossible.
  const reasoning = (id: string) => ({ type: "reasoning" as const, opaque: { id, type: "reasoning", encrypted_content: id } });
  const threeTurns: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "turn one" }] },
    {
      role: "assistant",
      content: [reasoning("rs_1"), { type: "tool_use", id: "call_1", name: "find_models", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", id: "call_1", content: "found" }] },
    { role: "assistant", content: [reasoning("rs_2"), { type: "text", text: "here you go" }] },
    { role: "user", content: [{ type: "text", text: "turn two" }] },
    { role: "assistant", content: [reasoning("rs_3"), { type: "text", text: "and again" }] },
    { role: "user", content: [{ type: "text", text: "turn three" }] },
  ];

  // The newest assistant turn has NO tool call, so every reasoning item goes.
  assert.deepEqual(toOpenAiInput(threeTurns), [
    { role: "user", content: "turn one" },
    { type: "function_call", call_id: "call_1", name: "find_models", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
    { role: "assistant", content: "here you go" },
    { role: "user", content: "turn two" },
    { role: "assistant", content: "and again" },
    { role: "user", content: "turn three" },
  ]);

  // Mid-tool-loop: the newest assistant turn DOES have a tool call, so its own
  // reasoning is replayed — that is the continuity `store:false` costs us — and
  // the older turn's is still dropped.
  const midLoop = threeTurns.slice(0, 3);
  const items = toOpenAiInput([
    ...midLoop,
    { role: "assistant", content: [reasoning("rs_9"), { type: "tool_use", id: "call_9", name: "find_models", input: {} }] },
    { role: "user", content: [{ type: "tool_result", id: "call_9", content: "found" }] },
  ]) as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.filter((i) => i.type === "reasoning").map((i) => i.id),
    ["rs_9"],
  );
});

// ── error bodies ─────────────────────────────────────────────────────────────

test("an enormous error body is read only up to 64 KB", async () => {
  // A misconfigured proxy can answer a failure with megabytes of HTML. The body
  // is read for its `error.code` and nothing else, so there is no reason to buffer
  // all of it into this process.
  const text = await readErrorBody(new Response("x".repeat(500_000), { status: 502 }));
  assert.ok(text.length > 0);
  assert.ok(text.length <= 64 * 1024, `read ${text.length} bytes`);
  // A body with no stream at all (a fake, a 204) still reads without throwing.
  const none = await readErrorBody({ text: async () => '{"error":{"code":"invalid_api_key"}}' } as Response);
  assert.equal(openAiErrorFrom(401, none).errorCode, "invalid_api_key");
});
