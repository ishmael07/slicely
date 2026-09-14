// ─────────────────────────────────────────────────────────────────────────────
// The Anthropic provider: everything that used to be welded into agent.ts,
// errors.ts and routes/key.ts, in one place behind the `Provider` interface.
//
// Nothing here is new behaviour. The streaming call, the adaptive-thinking and
// effort parameters, the `input_schema` tool shape, the `instanceof
// Anthropic.*` error classification and the `models.list` key check are the same
// ones Slicely has always made — they just no longer leak into the loop.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";
import { buildModelRequestParams } from "../settings";
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
} from "./provider";

/**
 * A personal Anthropic API key: `sk-ant-api` + a two-digit version + the secret
 * body. Nothing else is accepted — notably not `sk-ant-oat…` subscription
 * tokens, which are Claude.ai credentials, not API keys, and which Anthropic's
 * terms forbid routing third-party traffic through. The regex demanding
 * `sk-ant-api` is the enforcement, not an accident of pattern-writing.
 */
export const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;

const CONSOLE_URL = "https://console.anthropic.com/settings/keys";

/** How long to wait on Anthropic before calling it unreachable. Long enough for
 *  a slow TLS handshake, short enough that a paste doesn't hang the UI. */
const VALIDATE_TIMEOUT_MS = 10_000;

// ── neutral → Anthropic ──────────────────────────────────────────────────────

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as Anthropic.Tool["input_schema"],
  }));
}

function toContentParam(block: NeutralBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      // VERBATIM. A `thinking` block's signature (or a `redacted_thinking`
      // block's bytes) is what makes the next turn legal; rebuilding it would
      // invalidate it.
      return block.opaque as Anthropic.ContentBlockParam;
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return block.isError
        ? { type: "tool_result", tool_use_id: block.id, content: block.content, is_error: true }
        : { type: "tool_result", tool_use_id: block.id, content: block.content };
  }
}

export function toAnthropicMessages(messages: NeutralMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content.map(toContentParam) }));
}

// ── Anthropic → neutral ──────────────────────────────────────────────────────

export function fromAnthropicMessage(final: Anthropic.Message): TurnResult {
  const assistant: NeutralBlock[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of final.content) {
    if (block.type === "text") {
      assistant.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      assistant.push({ type: "reasoning", opaque: block });
    } else if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      assistant.push({ type: "tool_use", id: block.id, name: block.name, input });
      toolCalls.push({ id: block.id, name: block.name, input });
    }
    // Anything else (a server_tool_use block, a future type) is not part of a
    // Slicely turn and is dropped rather than replayed as something it isn't.
  }
  return { assistant, toolCalls };
}

/**
 * Read a v1 saved history — raw `Anthropic.MessageParam[]`, which is what every
 * chats.json written before the provider seam existed holds.
 *
 * Deliberately forgiving: a hand-edited or half-written file must reopen as a
 * chat with a shorter memory, never as an exception on the way to the user's
 * transcript.
 *
 * Forgiving is NOT the same as lossy-in-place, though. Dropping one unreadable
 * block out of a tool pair used to leave the other half behind — a `tool_result`
 * naming a call that no longer exists, or a `tool_use` nobody answered — and
 * both of those are a 400 on the user's very next message, which is the worst
 * possible way to lose a conversation. So a call id survives only if BOTH halves
 * do, and a lossy half takes its partner with it.
 */
export function fromAnthropicHistory(raw: unknown): NeutralMessage[] {
  if (!Array.isArray(raw)) return [];

  // Pass 1 — convert, remembering which messages lost a block on the way.
  const converted: Array<{ role: "user" | "assistant"; content: NeutralBlock[]; lossy: boolean }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const msg = entry as { role?: unknown; content?: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content: NeutralBlock[] = [];
    let lossy = false;
    if (typeof msg.content === "string") {
      content.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const block = neutralFromParam(b);
        if (block) content.push(block);
        else lossy = true;
      }
    }
    if (content.length) converted.push({ role: msg.role, content, lossy });
  }

  // Pass 2 — a message that lost a block AND is half of a tool pair goes whole.
  // Prose that lost a block keeps its prose: there is no counterpart for a
  // stray `server_tool_use` or a future block type to invalidate.
  const kept = converted.filter((m) => !(m.lossy && m.content.some(isPairBlock)));

  // Pass 3 — and the other half goes with it. One fixed point, no iteration
  // needed: a call is legal only where both the use and the result survived.
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of kept) {
    for (const b of m.content) {
      if (b.type === "tool_use") uses.add(b.id);
      else if (b.type === "tool_result") results.add(b.id);
    }
  }
  const out: NeutralMessage[] = [];
  for (const m of kept) {
    const content = m.content.filter((b) => !isPairBlock(b) || (uses.has(b.id) && results.has(b.id)));
    if (content.length) out.push({ role: m.role, content });
  }
  return out;
}

/** The two block types that only make sense as a matched pair. */
function isPairBlock(b: NeutralBlock): b is Extract<NeutralBlock, { type: "tool_use" | "tool_result" }> {
  return b.type === "tool_use" || b.type === "tool_result";
}

function neutralFromParam(raw: unknown): NeutralBlock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? { type: "text", text: b.text } : undefined;
    case "thinking":
    case "redacted_thinking":
      return { type: "reasoning", opaque: b };
    case "tool_use":
      return typeof b.id === "string" && typeof b.name === "string"
        ? { type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }
        : undefined;
    case "tool_result": {
      if (typeof b.tool_use_id !== "string") return undefined;
      const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      const block: NeutralBlock = { type: "tool_result", id: b.tool_use_id, content };
      if (b.is_error === true) block.isError = true;
      return block;
    }
    default:
      return undefined;
  }
}

// ── errors ───────────────────────────────────────────────────────────────────

/** True when an Anthropic 400/403 is really "this account can't pay for that". */
function mentionsBilling(err: Error): boolean {
  return /credit|billing|quota|insufficient[_ ]funds|payment/i.test(err.message ?? "");
}

function classifyError(err: unknown): ProviderFailure | undefined {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: "Your API key was rejected — update it in Settings.", code: "key_rejected" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      status: 429,
      message: "Your AI account is being rate-limited. Try again in a moment.",
      code: "rate_limited",
    };
  }
  if (
    err instanceof Anthropic.PermissionDeniedError ||
    (err instanceof Anthropic.BadRequestError && mentionsBilling(err))
  ) {
    return {
      status: 402,
      message: "The account behind your API key has no available credit.",
      code: "billing",
    };
  }
  return undefined;
}

// ── the provider ─────────────────────────────────────────────────────────────

export const ANTHROPIC_PROVIDER: Provider = {
  id: "anthropic",
  label: "Anthropic",
  keyPattern: ANTHROPIC_KEY_RE,
  // `max_tokens` here counts only the reply, so Slicely's long-standing 16000 is
  // ample. (OpenAI's equivalent also counts reasoning — see provider-openai.ts.)
  maxOutputTokens: 16_000,
  keyHelp: {
    label: "Anthropic API key",
    placeholder: "sk-ant-…",
    consoleUrl: CONSOLE_URL,
    consoleLabel: "console.anthropic.com",
    formatMessage(key: string): string {
      if (!key) return "Paste your Anthropic API key.";
      if (key.startsWith("sk-ant-oat")) {
        return 'That\'s a Claude Pro/Max subscription token, which can\'t be used here. Create an API key at console.anthropic.com — it starts with "sk-ant-api".';
      }
      return 'That doesn\'t look like an Anthropic API key. Create one at console.anthropic.com — it starts with "sk-ant-api". Claude Pro/Max subscription tokens can\'t be used here.';
    },
  },

  async stream(req: StreamRequest, emit: StreamEmit): Promise<TurnResult> {
    const client = new Anthropic({ apiKey: req.apiKey });
    // Build only the request fields this model actually accepts (no effort on
    // Haiku, no xhigh on Sonnet, no adaptive thinking pre-4.6).
    const { outputConfig, thinking } = buildModelRequestParams(req.model, req.effort);
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      tools: toAnthropicTools(req.tools),
      messages: toAnthropicMessages(req.messages),
    };
    if (thinking) params.thinking = thinking;
    if (outputConfig) params.output_config = outputConfig;

    // The signal is the agent's: pressing Stop has to close the socket, not just
    // stop painting the deltas (the tokens are billed either way).
    const stream = client.messages.stream(params as unknown as Anthropic.MessageStreamParams, {
      signal: req.signal,
    });
    // Thinking only fires on adaptive-thinking models; on the others the event
    // simply never arrives, which the renderer handles gracefully.
    stream.on("text", (delta) => emit({ type: "text", text: delta }));
    stream.on("thinking", (delta) => emit({ type: "thinking", text: delta }));
    return fromAnthropicMessage(await stream.finalMessage());
  },

  /**
   * One `models.list` call with the user's key. No retries: this runs while
   * someone watches a spinner, and a retry storm on a bad key just delays the
   * "that key is wrong" they need to see.
   */
  async validateKey(apiKey: string): Promise<KeyVerdict> {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: VALIDATE_TIMEOUT_MS });
    try {
      await client.models.list({ limit: 1 });
      return "ok";
    } catch (err) {
      // 401: wrong/revoked key. 403: a key that exists but isn't allowed to do
      // this — a workspace-scoped key, say. Both mean "this key won't work for
      // Slicely", which is the only thing the user can act on.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return "rejected";
      }
      if (err instanceof Anthropic.APIConnectionError) return "unreachable";
      // Anything else (a 429 on the user's account, a 500 at Anthropic, an
      // unexpected shape) says nothing about the KEY. Accept it and let the
      // first real chat turn surface the actual problem with a mapped error.
      return "ok";
    }
  },

  classifyError,
};
