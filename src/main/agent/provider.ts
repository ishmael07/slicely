// ─────────────────────────────────────────────────────────────────────────────
// The seam between Slicely's agent loop and whoever is actually answering.
//
// Until this file existed, `agent.ts` WAS an Anthropic client: the history was
// typed `Anthropic.MessageParam[]`, the tools were `Anthropic.Tool[]`, the
// thinking blocks were Anthropic's, and `errors.ts` mapped failures by
// `instanceof Anthropic.*`. Adding a second provider meant either a second copy
// of the loop or a pile of branches inside it.
//
// So the loop now speaks NEUTRAL blocks — text, an opaque reasoning blob, a tool
// call, a tool result — and each provider translates them to and from its own
// wire shapes. The rules that make that safe:
//
//  • REASONING IS OPAQUE. A thinking block carries a signature (Anthropic) or
//    encrypted content (OpenAI) that only its own provider can read, and
//    dropping it makes the NEXT turn illegal. So it is stored verbatim as
//    `{ type: "reasoning", opaque }` and handed back untouched — never parsed,
//    never rewritten, never shown to the other provider.
//  • A TOOL CALL IS KEYED BY ONE ID. Anthropic's `tool_use.id` and OpenAI's
//    `call_id` both land in `NeutralBlock.id`, and the result is correlated on
//    that and nothing else. (OpenAI also has an item `id` — `fc_…` — which is a
//    different value and correlating on it fails silently.)
//  • HISTORY BELONGS TO A PROVIDER. Because of the two rules above, a
//    conversation cannot be moved between providers; `agent.ts` tags an exported
//    history with the provider that produced it and starts fresh on a switch.
//
// Everything provider-specific lives in provider-anthropic.ts /
// provider-openai.ts. Nothing else in the codebase imports a provider SDK.
// ─────────────────────────────────────────────────────────────────────────────
import type { EffortLevel, ProviderId } from "../../shared/types";
import { MODEL_CATALOG } from "../settings";
import { ANTHROPIC_PROVIDER } from "./provider-anthropic";
import { OPENAI_PROVIDER } from "./provider-openai";

/** One piece of a conversation, in the only shapes the loop knows about. */
export type NeutralBlock =
  | { type: "text"; text: string }
  /** A provider's own reasoning item, kept verbatim. See the header. */
  | { type: "reasoning"; opaque: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

export interface NeutralMessage {
  role: "user" | "assistant";
  content: NeutralBlock[];
}

/** A tool as the agent declares it, before any provider has shaped it. `schema`
 *  is a JSON Schema object — Anthropic calls the field `input_schema`, OpenAI
 *  calls it `parameters`. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** Everything one model call needs. No provider-specific field appears here:
 *  effort is Slicely's tier and each provider clamps or renames it. */
export interface StreamRequest {
  apiKey: string;
  model: string;
  effort: EffortLevel;
  /** The system prompt. Resent on every turn, by both providers. */
  system: string;
  tools: ToolSpec[];
  messages: NeutralMessage[];
  maxOutputTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnResult {
  /** The assistant turn, ready to push onto history unchanged. */
  assistant: NeutralBlock[];
  /** The subset of `assistant` that has to run before the next turn. */
  toolCalls: ToolCall[];
}

/** Streamed deltas, for the UI only — never for history (the authoritative
 *  blocks come back in `TurnResult`, which is what a provider's own
 *  end-of-item events carry). */
export type StreamDelta = { type: "text" | "thinking"; text: string };
export type StreamEmit = (delta: StreamDelta) => void;

/** What one key-validation attempt concluded. "unreachable" is deliberately NOT
 *  "rejected": refusing a good key because our own egress was down would send
 *  the user hunting for a key they don't need. */
export type KeyVerdict = "ok" | "rejected" | "unreachable";

/** Everything the UI and the key route need to talk about one provider's key,
 *  so neither has to branch on the provider id. */
export interface KeyHelp {
  /** Field label, e.g. "Anthropic API key". */
  label: string;
  /** Input placeholder, e.g. "sk-ant-…". */
  placeholder: string;
  consoleUrl: string;
  /** How to name that URL in prose, e.g. "console.anthropic.com". */
  consoleLabel: string;
  /** Why a paste was refused, in terms of what to do next. */
  formatMessage(key: string): string;
}

/** A provider failure translated into the wire contract: a stable code plus the
 *  status and the sentence the user gets. Deliberately DE-BRANDED — errors.ts
 *  does not know which provider a session is on, and the fix is the same for
 *  both. */
export interface ProviderFailure {
  status: number;
  message: string;
  code: string;
}

export interface Provider {
  readonly id: ProviderId;
  /** How the provider is named in the UI, e.g. "Anthropic". */
  readonly label: string;
  /** A cheap local sanity check on a pasted key. Deliberately loose: the real
   *  validation is `validateKey`, and over-strict patterns age badly. */
  readonly keyPattern: RegExp;
  readonly keyHelp: KeyHelp;
  /** One streamed model call. Deltas go to `emit`; the authoritative blocks come
   *  back in the result. */
  stream(req: StreamRequest, emit: StreamEmit): Promise<TurnResult>;
  /** One cheap real call with the key, so a user learns at paste time. */
  validateKey(apiKey: string): Promise<KeyVerdict>;
  /** This provider's own failure translated for the wire, or undefined when the
   *  error is not one of this provider's. */
  classifyError(err: unknown): ProviderFailure | undefined;
}

/** Every provider Slicely can chat through. Order is UI order. */
export const PROVIDERS: readonly Provider[] = [ANTHROPIC_PROVIDER, OPENAI_PROVIDER];

/** The provider a user gets when nothing says otherwise — and the one an
 *  untagged (pre-provider-seam) saved chat is assumed to have come from. */
export const DEFAULT_PROVIDER_ID: ProviderId = "anthropic";

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.some((p) => p.id === value);
}

export function getProvider(id: ProviderId): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  // Unreachable through `isProviderId`, but a corrupt settings.json is not a
  // reason to crash a request.
  return found ?? PROVIDERS[0];
}

/**
 * Which provider owns a model id.
 *
 * The catalog is the single source of truth (settings.ts), so adding a model is
 * a one-line data change and no request builder ever hardcodes a model name.
 * An unknown id — a hand-edited settings.json, a model retired upstream —
 * resolves to the default rather than throwing.
 */
export function providerForModel(model: string): Provider {
  const entry = MODEL_CATALOG.find((m) => m.id === model);
  return getProvider(entry?.provider ?? DEFAULT_PROVIDER_ID);
}

/** Ask every provider whether this failure is one of theirs. The first claim
 *  wins; nothing claiming it means errors.ts treats it as a bug. */
export function classifyProviderError(err: unknown): ProviderFailure | undefined {
  for (const provider of PROVIDERS) {
    const failure = provider.classifyError(err);
    if (failure) return failure;
  }
  return undefined;
}
