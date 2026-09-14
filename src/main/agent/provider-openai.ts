// ─────────────────────────────────────────────────────────────────────────────
// The OpenAI provider: `POST /v1/responses` with `stream: true`, behind the same
// `Provider` interface Anthropic sits behind.
//
// BRING-YOUR-OWN API KEY, AND ONLY THAT. "Sign in with ChatGPT" is identity-only
// and partner-gated; the Codex subscription credential is a loopback-only
// browser flow that REJECTS a custom system prompt ("custom instructions are
// supported when using the API key" — OpenAI's own Codex lead). A find→slice→
// print assistant is defined by its instructions and its tools, so that path
// cannot work here, and impersonating Codex's client id to try is a terms
// violation. A user pastes an API key, exactly as they do for Anthropic.
//
// RAW FETCH, NOT THE `openai` PACKAGE. Everything below is one POST, one GET and
// an SSE reader; the parts that need testing (the request body, the stream, the
// error mapping) are pure functions fed fixtures, which is what a fixture-driven
// test needs anyway. That also keeps the dependency list — and the lockfile —
// where they were.
//
// Four details are load-bearing, each one a silent failure if missed:
//
//  • `store` DEFAULTS TO TRUE. Left alone, OpenAI retains the user's input and
//    output for ~30 days and shows it in their dashboard. Slicely promises that
//    deleting your data deletes all of it, so `store: false` is a requirement.
//  • WITH `store: false` THERE IS NO SERVER-SIDE STATE, so reasoning continuity
//    across a tool loop only works if we ask for
//    `include: ["reasoning.encrypted_content"]` and replay the reasoning item
//    ourselves — taken from `response.output_item.done`, because on `.added` it
//    may still be incomplete.
//  • A FUNCTION TOOL IS FLAT here (`{type, name, description, parameters}`), not
//    nested under `"function"` as in Chat Completions.
//  • A TOOL RESULT IS CORRELATED ON `call_id` (`call_…`), never on the item `id`
//    (`fc_…`). They are different values and mixing them up fails silently.
// ─────────────────────────────────────────────────────────────────────────────
import { resolveEffort } from "../settings";
import { tokenCount, toTurnUsage } from "../pricing";
import type {
  KeyVerdict,
  NeutralBlock,
  NeutralMessage,
  Provider,
  ProviderFailure,
  StreamEmit,
  StreamRequest,
  ToolCall,
  ToolSpec,
  TurnResult,
  TurnUsage,
} from "./provider";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELS_URL = "https://api.openai.com/v1/models?limit=1";
const CONSOLE_URL = "https://platform.openai.com/api-keys";

/** How long to wait on OpenAI before calling it unreachable. Long enough for a
 *  slow TLS handshake, short enough that a paste doesn't hang the UI. */
const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * The hard ceiling on ONE streamed turn.
 *
 * Generous on purpose — a max-effort reasoning turn with a dozen tool calls is a
 * slow thing, and cutting a real answer off is worse than waiting. But it exists,
 * because a `fetch` with no signal has no timeout at all: a stalled upstream
 * would hold the socket, the turn and the session's chat slot indefinitely, with
 * nothing on either end to notice.
 */
const STREAM_TIMEOUT_MS = 10 * 60_000;

/** How much of a failure's body to read. It is parsed for its `error.code` and
 *  nothing else, so buffering a misconfigured proxy's megabytes of HTML into this
 *  process buys nothing. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * A cheap local sanity check on a pasted OpenAI key — deliberately LOOSE.
 *
 * OpenAI documents only the `sk-` prefix (and `sk-admin-`) in its own OpenAPI
 * spec; `sk-proj-`, `sk-svcacct-` and `sk-None-` are observed but undocumented,
 * key length is documented nowhere and has changed repeatedly, and workload
 * identity federation now issues credentials that are not `sk-…` at all. An
 * exact pattern would age badly and reject good keys, so the real validation is
 * `validateKey` below — one live call.
 *
 * Two prefixes are worth acting on, and the lookahead refuses both:
 * `sk-admin-`, because Admin API keys "cannot be used for non-administration
 * endpoints" and accepting one buys the user nothing but a confusing 401 at chat
 * time; and `sk-ant-`, because an Anthropic key pasted into the OpenAI card is
 * the most likely mistake with two cards on screen, and it is one we can name.
 * `keyHelp.formatMessage` says which happened. A ChatGPT session/OAuth token (a
 * JWT, `eyJ…`) fails the `sk-` prefix and is refused for the same reason it is
 * refused on the Anthropic side: it is a subscription credential, not an API
 * key.
 */
export const OPENAI_KEY_RE = /^sk-(?!admin-|ant-)(?:proj-)?[A-Za-z0-9_-]{20,}$/;

// ── errors ───────────────────────────────────────────────────────────────────

/** An HTTP failure from OpenAI. `errorCode` is the body's `error.code`, which is
 *  what separates a retryable 429 from an out-of-credit one. */
export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

/** Slicely could not reach OpenAI at all. Distinct from a rejection: refusing a
 *  good key because our own egress was down sends the user hunting for a key
 *  they don't need. */
export class OpenAiUnreachableError extends Error {
  constructor(message = "Couldn't reach OpenAI.") {
    super(message);
    this.name = "OpenAiUnreachableError";
  }
}

/**
 * Read a failure's body, up to `MAX_ERROR_BODY_BYTES`.
 *
 * `response.text()` would buffer whatever the other end sends — and the other end
 * of a failure is often not OpenAI at all but a proxy answering with an HTML
 * error page. Exported for its own test; a body with no readable stream (a 204, a
 * fake) still comes back through `text()`.
 */
export async function readErrorBody(response: Response): Promise<string> {
  const body = response.body as unknown as AsyncIterable<Uint8Array> | null | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    return response.text().then((t) => t.slice(0, MAX_ERROR_BODY_BYTES)).catch(() => "");
  }
  const decoder = new TextDecoder();
  let out = "";
  let read = 0;
  try {
    for await (const chunk of body) {
      read += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
      // `break` on a ReadableStream cancels it, so the rest is never transferred.
      if (read >= MAX_ERROR_BODY_BYTES) break;
    }
  } catch {
    /* a truncated error body is still an error — the status is the whole story */
  }
  return out.slice(0, MAX_ERROR_BODY_BYTES);
}

/** Build an `OpenAiError` from a response's status and raw body. The body is
 *  parsed for its `code` only — its prose is upstream's, never forwarded. */
export function openAiErrorFrom(status: number, bodyText: string): OpenAiError {
  let code: string | undefined;
  let message = `OpenAI responded ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
    const err = parsed.error ?? {};
    if (typeof err.code === "string") code = err.code;
    else if (typeof err.type === "string") code = err.type;
    if (typeof err.message === "string") message = err.message;
  } catch {
    /* a proxy's HTML error page, an empty body — the status is the whole story */
  }
  return new OpenAiError(status, code, message);
}

/**
 * The 429 sub-codes that retrying cannot fix.
 *
 * OpenAI is explicit: "Retrying billing, spend, or quota errors won't restore
 * API access." A generic 429 or `slow_down` is a rate limit; these are an empty
 * account, and telling the user to "try again in a moment" would be a lie they
 * would keep believing.
 */
const BILLING_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
]);

function classifyError(err: unknown): ProviderFailure | undefined {
  if (!(err instanceof OpenAiError)) return undefined;
  const code = err.errorCode ?? "";
  if (err.status === 401 || err.status === 403) {
    // Including a stored key that stops working through no fault of the user:
    // an org-mandated expiry or a revocation takes effect within seconds, and
    // "re-enter your key" is the only useful thing to say.
    return { status: 401, message: "Your API key was rejected — update it in Settings.", code: "key_rejected" };
  }
  if (err.status === 402 || BILLING_CODES.has(code) || /insufficient[_ ]quota|credit|billing/i.test(code)) {
    return { status: 402, message: "The account behind your API key has no available credit.", code: "billing" };
  }
  if (err.status === 429) {
    return {
      status: 429,
      message: "Your AI account is being rate-limited. Try again in a moment.",
      code: "rate_limited",
    };
  }
  // A 400 (our request shape), a 404 (a model id the catalog has outlived) and a
  // 5xx (an outage) are all "nothing the user can do", and none of them is worth
  // a wrong instruction. errors.ts logs them and answers generically.
  return undefined;
}

// ── neutral → Responses ──────────────────────────────────────────────────────

export function toOpenAiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.schema,
    // strict:false ON PURPOSE. Strict mode demands every property in `required`
    // and additionalProperties:false on every nested object; Slicely's schemas
    // have genuinely optional arguments (goal, material, colours…). One shared
    // schema source beats two that can drift.
    strict: false,
  }));
}

/**
 * Which assistant turn (if any) may still carry its reasoning items.
 *
 * THE RULE THE RESPONSES API ENFORCES: a reasoning item must be followed by the
 * function call it reasoned about. Replay every past turn's reasoning and the
 * second message in any chat 400s, because turn one's reasoning item is now
 * followed by a plain user message.
 *
 * So reasoning is replayed for exactly one turn: the MOST RECENT assistant turn,
 * and only when that turn also holds a `tool_use` — i.e. we are mid-tool-loop and
 * the next thing in `input` is that call. Every older turn's reasoning is
 * stripped. That costs nothing but the continuity `store: false` already costs
 * us, and it is the difference between a tool loop that works and a chat that
 * cannot take a second message.
 */
function reasoningTurnIndex(messages: NeutralMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    return messages[i].content.some((b) => b.type === "tool_use") ? i : -1;
  }
  return -1;
}

export function toOpenAiInput(messages: NeutralMessage[]): unknown[] {
  const items: unknown[] = [];
  const replayReasoningAt = reasoningTurnIndex(messages);
  for (const [index, message] of messages.entries()) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          items.push({ role: message.role, content: block.text });
          break;
        case "reasoning":
          // VERBATIM, and only where it came from: the encrypted content is the
          // whole point, and rebuilding the item would invalidate it. Only on the
          // one turn that is allowed to have it — see reasoningTurnIndex.
          if (index === replayReasoningAt) items.push(block.opaque);
          break;
        case "tool_use":
          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        case "tool_result":
          items.push({ type: "function_call_output", call_id: block.id, output: block.content });
          break;
      }
    }
  }
  return items;
}

export function buildResponsesBody(req: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    // The system prompt, resent every turn. `instructions` is fully ours on this
    // path — which is the entire reason Slicely uses an API key rather than a
    // subscription credential.
    instructions: req.system,
    input: toOpenAiInput(req.messages),
    tools: toOpenAiTools(req.tools),
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    // Off: per-frame random padding is a compression side-channel mitigation we
    // don't need on a TLS connection we aren't compressing, and it is pure
    // bandwidth on a phone.
    stream_options: { include_obfuscation: false },
    // See the header: this one is a privacy requirement, not a tuning knob.
    store: false,
    include: ["reasoning.encrypted_content"],
    // Upper bound INCLUDING reasoning tokens, unlike Anthropic's max_tokens.
    max_output_tokens: req.maxOutputTokens,
  };
  const effort = resolveEffort(req.model, req.effort);
  // `summary: "auto"` is what produces the reasoning summary deltas the UI shows
  // as thinking; without it a reasoning model streams nothing until it answers.
  if (effort) body.reasoning = { effort, summary: "auto" };
  return body;
}

// ── the stream ───────────────────────────────────────────────────────────────

/**
 * Split an SSE byte stream into its `data:` payloads.
 *
 * Frames are separated by a blank line and can straddle chunk boundaries, so the
 * buffer is carried across chunks. `event:` lines are ignored: every Responses
 * event repeats its name in the payload's `type`, and one source of truth beats
 * two that can disagree. Comments (`:` keep-alives) and the `[DONE]` sentinel
 * are not events.
 */
export async function* parseSseFrames(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    // Tolerate CRLF, which some proxies rewrite to.
    let sep = findSeparator(buffer);
    while (sep) {
      const raw = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep.length);
      const payload = dataOf(raw);
      if (payload !== undefined) yield payload;
      sep = findSeparator(buffer);
    }
  }
  const tail = dataOf(buffer);
  if (tail !== undefined) yield tail;
}

function findSeparator(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** The joined `data:` lines of one frame, or undefined when the frame carries no
 *  event (a comment, a blank, the `[DONE]` sentinel). */
function dataOf(frame: string): string | undefined {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).trimStart());
  }
  if (!parts.length) return undefined;
  const joined = parts.join("\n");
  return joined === "[DONE]" || joined === "" ? undefined : joined;
}

/**
 * Turn one response's event stream into a `TurnResult`.
 *
 * Deltas go to `emit` for the UI; the blocks kept for history come from
 * `response.output_item.done`, which carries the COMPLETE item. Accumulating
 * the deltas into blocks ourselves would work for text and be wrong for
 * reasoning (whose encrypted content is only complete on `.done`) and fragile
 * for arguments (a JSON string that must not be parsed until it is whole).
 */
export async function readTurn(frames: AsyncIterable<string>, emit: StreamEmit): Promise<TurnResult> {
  const assistant: NeutralBlock[] = [];
  const toolCalls: ToolCall[] = [];
  let usage: TurnUsage | undefined;

  for await (const payload of frames) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // an unparseable frame is not worth failing a whole turn over
    }
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string" && event.delta) emit({ type: "text", text: event.delta });
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (typeof event.delta === "string" && event.delta) emit({ type: "thinking", text: event.delta });
    } else if (type === "response.output_item.done") {
      collectItem(event.item, assistant, toolCalls);
    } else if (type === "response.completed") {
      usage = usageFromResponse(event.response) ?? usage;
    } else if (type === "error") {
      // Bare `error`, with no `response.` prefix — the one event name that
      // breaks a switch written from the others.
      throw errorFromEvent(event);
    } else if (type === "response.failed" || type === "response.incomplete") {
      const response = (event.response ?? {}) as { error?: unknown; incomplete_details?: { reason?: unknown } };
      // A TRUNCATED ANSWER IS STILL AN ANSWER. `max_output_tokens` counts
      // reasoning tokens on this API, so a long think can end a turn early
      // through no fault of the user — and handing them the half-sentence the
      // model did produce beats the generic 500 a thrown error becomes. Every
      // other reason (a content filter, an aborted upstream) really is a failure.
      if (type === "response.incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
        // READ THE USAGE BEFORE BREAKING OUT. A turn that hit the output ceiling
        // is a real, billable call — the most expensive kind there is, since it
        // spent the whole output budget — and breaking first would hand the owner
        // the bill with no record of it.
        usage = usageFromResponse(event.response) ?? usage;
        break;
      }
      throw errorFromEvent((response.error ?? event) as Record<string, unknown>);
    }
  }

  const result: TurnResult = { assistant, toolCalls };
  if (usage) result.usage = usage;
  return result;
}

/**
 * `response.usage` as a `TurnUsage`, or undefined when the response carried none.
 *
 * THE SUBTRACTION IS THE POINT. OpenAI's `input_tokens` is the TOTAL, with
 * `input_tokens_details.cached_tokens` broken out OF it — the opposite of
 * Anthropic, where the cached read is already excluded. Billing the total at the
 * full input rate would over-charge a cache hit by ten times.
 *
 * `cacheWriteTokens` is always 0: OpenAI does not itemise writes, so the 1.25×
 * premium on a cold prefix is invisible to us. pricing.ts's header records the
 * bound on that under-report.
 */
function usageFromResponse(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = (raw as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return undefined;
  const usage = u as { input_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown }; output_tokens?: unknown };
  const cached = tokenCount(usage.input_tokens_details?.cached_tokens);
  return toTurnUsage({
    // Clamped, because `cached > total` is a shape we should never see and a
    // negative uncached count would be a NEGATIVE charge in the ledger.
    inputTokens: Math.max(0, tokenCount(usage.input_tokens) - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: usage.output_tokens,
  });
}

function errorFromEvent(event: Record<string, unknown>): OpenAiError {
  const code = typeof event.code === "string" ? event.code : undefined;
  const message = typeof event.message === "string" ? event.message : "OpenAI ended the response early.";
  // Status 0: this failure arrived inside a 200 stream, so there is no HTTP
  // status to speak of. classifyError keys on the code for these.
  return new OpenAiError(statusForStreamCode(code), code, message);
}

/** A mid-stream error names itself but carries no status, so infer the one the
 *  classifier needs from the code. Anything unrecognised stays a non-status. */
function statusForStreamCode(code: string | undefined): number {
  if (!code) return 0;
  if (BILLING_CODES.has(code)) return 402;
  if (/rate_limit|slow_down/i.test(code)) return 429;
  if (/api_key|authentication|access_denied|permission/i.test(code)) return 401;
  return 0;
}

function collectItem(raw: unknown, assistant: NeutralBlock[], toolCalls: ToolCall[]): void {
  if (!raw || typeof raw !== "object") return;
  const item = raw as Record<string, unknown>;
  // A CUT-OFF ITEM IS NOT AN ITEM. When a response ends on `max_output_tokens`
  // the item it was part-way through still arrives on `.done`, marked
  // `status: "incomplete"` — and for a `function_call` that means `arguments` is
  // a truncated JSON string, which `parseArguments` turns into `{}`. Executing
  // that would run a real tool with silently wrong arguments (slice the wrong
  // file, search for nothing) and then hand the model an answer to a question it
  // never finished asking. Replaying a half-written reasoning or message item is
  // the same bet with less to gain. Whatever the user actually WATCHED arrive is
  // not lost by this: the deltas were already streamed, and the agent keeps them
  // (see agent.ts) when a turn collects nothing.
  if (item.status === "incomplete") return;
  switch (item.type) {
    case "message": {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text) {
          assistant.push({ type: "text", text: part.text });
        }
      }
      return;
    }
    case "reasoning":
      assistant.push({ type: "reasoning", opaque: item });
      return;
    case "function_call": {
      // `call_id`, NOT `id`. See the header.
      const id = typeof item.call_id === "string" ? item.call_id : undefined;
      const name = typeof item.name === "string" ? item.name : undefined;
      if (!id || !name) return;
      const input = parseArguments(item.arguments);
      assistant.push({ type: "tool_use", id, name, input });
      toolCalls.push({ id, name, input });
      return;
    }
    default:
      // A refusal, a web-search call, a future item type: not part of a Slicely
      // turn, and replaying it as something it isn't would be worse than
      // dropping it.
      return;
  }
}

/** `arguments` is a JSON-encoded STRING. A model that emits malformed JSON gets
 *  an empty object and a tool that complains, rather than a thrown turn. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ── the provider ─────────────────────────────────────────────────────────────

export const OPENAI_PROVIDER: Provider = {
  id: "openai",
  label: "OpenAI",
  keyPattern: OPENAI_KEY_RE,
  // TWICE ANTHROPIC'S, on purpose: `max_output_tokens` is an upper bound on
  // reasoning tokens AND the reply, so a max-effort turn can spend most of a
  // 16000 budget thinking and then get cut off mid-sentence. The cap is a
  // safety rail against a runaway turn, not a budget the user is meant to feel.
  maxOutputTokens: 32_000,
  keyHelp: {
    label: "OpenAI API key",
    // Deliberately not "sk-proj-…": project keys are the default today, but
    // legacy and service-account keys are valid too and the prefix has changed
    // before.
    placeholder: "sk-…",
    consoleUrl: CONSOLE_URL,
    consoleLabel: "platform.openai.com/api-keys",
    formatMessage(key: string): string {
      if (!key) return "Paste your OpenAI API key.";
      if (key.startsWith("sk-admin-")) {
        return "That's an OpenAI Admin key, which only works on administration endpoints. Create a standard secret key at platform.openai.com/api-keys.";
      }
      if (key.startsWith("sk-ant-")) {
        return "That's an Anthropic key — paste it in the Anthropic card instead. An OpenAI key comes from platform.openai.com/api-keys.";
      }
      return "That doesn't look like an OpenAI API key. Create one at platform.openai.com/api-keys — it starts with \"sk-\". A ChatGPT Plus/Pro subscription can't be used here: OpenAI allows subscription sign-in only in its own apps.";
    },
  },

  async stream(req: StreamRequest, emit: StreamEmit): Promise<TurnResult> {
    // The caller's cancel AND a ceiling, so a turn ends whether or not anybody is
    // watching. `AbortSignal.any` keeps both live: whichever fires first wins,
    // and the composite is what the socket is bound to — a `fetch` with no signal
    // could be neither cancelled nor timed out. (It landed in Node 20.3, which is
    // why package.json now states an `engines.node`: on an older runtime this is
    // `undefined is not a function` on the first chat turn, not a build error.)
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)])
      : AbortSignal.timeout(STREAM_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(RESPONSES_URL, {
        method: "POST",
        signal,
        headers: {
          // These two headers are the whole set: the Responses API is GA (no
          // OpenAI-Beta), and `stream: true` in the body is what switches on
          // SSE (no Accept header).
          Authorization: `Bearer ${req.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildResponsesBody(req)),
      });
    } catch (err) {
      // An abort is not an outage: the user pressed Stop (or the ceiling fired),
      // and calling that "couldn't reach OpenAI" would send them looking for a
      // network problem they don't have.
      if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") throw err;
      throw new OpenAiUnreachableError((err as Error).message);
    }

    if (!response.ok || !response.body) {
      // Read the body for its `code` only — its prose is upstream's, and
      // errors.ts would not forward it anyway. Capped: see readErrorBody.
      throw openAiErrorFrom(response.status, await readErrorBody(response));
    }

    return readTurn(parseSseFrames(response.body as unknown as AsyncIterable<Uint8Array>), emit);
  },

  /**
   * One `GET /v1/models` with the user's key. No retries: this runs while
   * someone watches a spinner, and a retry storm on a bad key just delays the
   * "that key is wrong" they need to see.
   *
   * A restricted-permission key can pass this and still fail on
   * `/v1/responses`; that shows up as a mapped `key_rejected` on the first chat
   * turn rather than being worth a second billable call at paste time.
   */
  async validateKey(apiKey: string): Promise<KeyVerdict> {
    try {
      const response = await fetch(MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) return "rejected";
      // Anything else (a 429 on the user's account, a 500 at OpenAI, an
      // unexpected shape) says nothing about the KEY. Accept it and let the
      // first real chat turn surface the actual problem with a mapped error.
      return "ok";
    } catch {
      // A timeout or a DNS/TLS failure is OUR egress, not their key.
      return "unreachable";
    }
  },

  classifyError,
};
