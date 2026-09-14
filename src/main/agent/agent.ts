// The Slicely agent: a streaming, tool-using loop. It keeps conversation history
// across turns, streams text/thinking/tool events to the renderer, and runs the
// marketplace + PrusaSlicer tools until the model is done.
//
// It talks to a PROVIDER, not to Anthropic (see ./provider.ts). The history it
// keeps is neutral, the tools it declares are neutral, and which provider
// answers is decided per turn from the user's chosen model — so a user with two
// keys can switch model mid-session and the next turn simply goes elsewhere.
import { createHash } from "node:crypto";
import { getUserApiKey, NoApiKeyError } from "../userkey";
import { costMicros, type TurnUsage } from "../pricing";
import { currentSessionId } from "../session-context";
import { getSettings, getPreferences } from "../settings";
import { seedSessionFromPreferences } from "./state";
import { TOOLS, executeTool, toolLabel, type Emit } from "./tools";
import { SYSTEM_PROMPT } from "./prompt";
import { capHistory } from "./history";
import { logTurnCost } from "./cost-log";
import { stripPaths, toWire } from "../../server/errors";
import { fromAnthropicHistory } from "./provider-anthropic";
import {
  DEFAULT_PROVIDER_ID,
  isProviderId,
  providerForModel,
  type NeutralBlock,
  type NeutralMessage,
  type Provider,
} from "./provider";
import type { AgentEvent, ProviderId } from "../../shared/types";

const MAX_TOOL_ITERATIONS = 12;

/** What a tool call that never ran is told, so the provider still sees a result
 *  for every call it made. Not an error: nothing went wrong, the user changed
 *  their mind, and `is_error` would invite the model to apologise for a failure. */
const CANCELLED_RESULT = "Cancelled by the user.";

/** Stands in for a reply that never arrived, so the saved history still
 *  alternates. Written as the assistant's own words because that is where it
 *  sits, and the user has already seen why (a Stop, or an error frame). */
const INTERRUPTED_REPLY = "(This reply was interrupted.)";

/** What the user is told when a turn came back with NOTHING — no text, no
 *  reasoning, no call. It happens for real: `max_output_tokens` counts reasoning
 *  tokens on the Responses API, so a max-effort turn can spend the whole budget
 *  thinking and be cut off before its first word. A silent `done` reads as the
 *  assistant ignoring them, so one line says what happened and what to try. */
const EMPTY_TURN_NOTICE =
  "The reply was cut off before it started — try again, or use a smaller effort.";

/** The current shape of an exported history. v1 was a bare
 *  `Anthropic.MessageParam[]` with nothing saying so. */
const HISTORY_VERSION = 2;

/**
 * A saved conversation, as it goes into chats.json.
 *
 * TAGGED, because a history is not portable: reasoning blocks are opaque to
 * every provider but the one that wrote them, and tool ids are correlated by
 * each provider's own rules. Reopening a chat has to know whether the messages
 * in it may be replayed at all — and a file written before this existed is a
 * bare array, which is exactly how an untagged history is recognised.
 */
export interface ExportedHistory {
  version: typeof HISTORY_VERSION;
  provider: ProviderId;
  messages: NeutralMessage[];
}

export interface AgentOptions {
  /**
   * Resolve the provider for a model id. TESTS ONLY — it lets the loop be
   * exercised against a scripted fake with no SDK, no key and no network. In
   * production this is the catalog lookup in provider.ts.
   */
  resolveProvider?: (model: string) => Provider;
}

export class SlicelyAgent {
  private history: NeutralMessage[] = [];
  /** Which provider produced `history`. Undefined while it is empty. */
  private historyProvider: ProviderId | undefined;
  private cancelled = false;
  /**
   * The abort handle for the turn in flight, handed to the provider.
   *
   * `cancelled` alone only stopped Slicely from PAINTING the rest of a turn: the
   * provider's HTTP request ran to completion, still billing the user's account,
   * and a stalled upstream held the session's chat slot with nothing to end it.
   * Replaced per turn, so a cancel can never poison the next one.
   */
  private inFlight = new AbortController();
  /**
   * The text of the turn in flight, as the user watched it arrive.
   *
   * Kept because the history is otherwise written only from what the provider
   * COLLECTS, and a turn can be killed after streaming half a sentence — a Stop,
   * a dropped socket, a token ceiling that cut the item the sentence lived in. On
   * every one of those the user is looking at words the model never got credited
   * with, and the next turn would carry on with no idea it had said them.
   * Cleared as soon as an assistant turn is recorded.
   */
  private streamed = "";
  private readonly resolveProvider: (model: string) => Provider;

  constructor(opts: AgentOptions = {}) {
    this.resolveProvider = opts.resolveProvider ?? providerForModel;
    // The key belongs to the USER, not the deployment: it comes from this
    // session's encrypted secrets (userkey.ts), never from the server's
    // environment. No key is a normal, expected state for a fresh visitor —
    // hence a typed error the HTTP layer turns into 409 `no_key` and the UI
    // turns into the "connect your key" card, rather than a crash or a message
    // about server-side files the user has no access to.
    //
    // Checked HERE as well as per turn so the 409 is answered before /api/chat
    // has written a single SSE header.
    const provider = this.resolveProvider(getSettings().model);
    if (!this.keyFor(provider)) {
      throw new NoApiKeyError(`Connect your ${provider.label} API key in Settings to chat.`);
    }
    // Seed the session from the user's saved printer/material so a returning
    // user is never asked to re-state their setup.
    const prefs = getPreferences();
    seedSessionFromPreferences({
      printer: prefs.printer,
      material: prefs.material,
    });
  }

  private keyFor(provider: Provider): string | undefined {
    return getUserApiKey(provider.id);
  }

  /**
   * Forget this conversation.
   *
   * "New chat" has to clear the MODEL's memory too, not just the transcript on
   * screen — otherwise the next message still carries every earlier turn, and
   * the user gets answers about a model they thought they had left behind
   * (while paying for those tokens on every request).
   */
  reset(): void {
    this.history = [];
    this.historyProvider = undefined;
    this.cancelled = false;
    this.streamed = "";
  }

  /** The conversation so far, for storing against a saved chat. */
  exportHistory(): ExportedHistory {
    return {
      version: HISTORY_VERSION,
      provider: this.historyProvider ?? DEFAULT_PROVIDER_ID,
      messages: this.history,
    };
  }

  /** Restore a previously saved conversation, so reopening a chat continues it
   *  rather than starting over with the transcript merely redrawn. An UNTAGGED
   *  history is a v1 file: raw Anthropic messages, from the only provider that
   *  existed when it was written. */
  importHistory(history: unknown): void {
    this.cancelled = false;
    this.streamed = "";
    const tagged = asExported(history);
    if (tagged) {
      this.history = tagged.messages;
      this.historyProvider = tagged.provider;
      return;
    }
    this.history = fromAnthropicHistory(history);
    this.historyProvider = this.history.length ? DEFAULT_PROVIDER_ID : undefined;
  }

  cancel(): void {
    this.cancelled = true;
    this.inFlight.abort();
  }

  /**
   * Leave the history REPLAYABLE, whatever just happened to this turn.
   *
   * Both providers require the roles to alternate, and a turn that ends without
   * an assistant reply — a cancel that aborted the socket, a key revoked
   * mid-stream, twelve tool iterations spent — leaves the history ending on a
   * user message. The NEXT message then appends a second one and the provider
   * answers 400 on a history the user can neither see nor fix. One stub closes
   * it; a normal turn always ends on the assistant, so this is a no-op there.
   */
  private closeTurn(): void {
    // FIRST the calls, because a history that ends on an unanswered `tool_use`
    // is the same 400 as one that ends on a user message, and a throw between
    // the assistant push and the tool-results push leaves exactly that. So does
    // a cancel, and so does reopening a chat whose file was written mid-loop.
    this.answerOpenCalls();
    if (this.history.at(-1)?.role !== "user") return;
    // The half sentence the user watched arrive is the assistant's own words,
    // and it goes in FRONT of the stub: dropping it would leave the model
    // carrying on from a reply the user can still see on screen but the model
    // was never told it made.
    const content: NeutralBlock[] = [];
    if (this.streamed.trim()) content.push({ type: "text", text: this.streamed });
    content.push({ type: "text", text: INTERRUPTED_REPLY });
    this.streamed = "";
    this.history.push({ role: "assistant", content });
  }

  /**
   * Answer every `tool_use` in the final assistant turn that nothing came back
   * for.
   *
   * A `function_call` (or `tool_use`) with no matching output is a 400 on the
   * NEXT message, on both providers — and the history is what gets SAVED, so an
   * unanswered call does not just break this turn, it breaks the chat every time
   * it is reopened. The loop below fills them in where the turn ran normally;
   * this is the same thing for a turn that never got there at all.
   */
  private answerOpenCalls(): void {
    const last = this.history.at(-1);
    // Only the LAST message can be fixed by appending: a tool_result has to sit
    // in the message immediately after its call, so an orphan deeper in the
    // history is not something a stub at the end would make legal.
    if (last?.role !== "assistant") return;
    const calls = last.content.filter(
      (b): b is Extract<NeutralBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (!calls.length) return;
    const results: NeutralBlock[] = [];
    answerEveryCall(calls, results);
    this.history.push({ role: "user", content: results });
  }

  /** Run one user turn to completion, streaming events via `emit`. */
  async send(userMessage: string, emit: Emit): Promise<void> {
    this.cancelled = false;
    this.inFlight = new AbortController();

    try {
      // Read the user's live model + effort choice ONCE per turn: the provider
      // is decided by the model, so re-reading it mid-tool-loop could send half
      // a conversation to a different API.
      const { model, effort } = getSettings();
      const provider = this.resolveProvider(model);
      // SWITCHING PROVIDER RESETS THE CHAT. The history holds reasoning blocks
      // and tool ids only its own provider can read (see provider.ts), so
      // replaying it elsewhere is a 400 at best and a silently wrong
      // conversation at worst. Say so rather than dropping it quietly: the user
      // is about to notice the assistant has forgotten everything.
      if (this.historyProvider && this.historyProvider !== provider.id) {
        this.history = [];
        this.historyProvider = undefined;
        emit({
          type: "text",
          text: `Switched to ${provider.label} — starting a fresh conversation, since chat history can't move between providers.\n\n`,
        });
      }

      const apiKey = this.keyFor(provider);
      if (!apiKey) {
        throw new NoApiKeyError(`Connect your ${provider.label} API key in Settings to chat.`);
      }

      this.history.push({ role: "user", content: [{ type: "text", text: userMessage }] });
      this.historyProvider = provider.id;

      // A prompt-cache routing hint, stable for as long as the session is — so
      // every call of every turn in one conversation prefers the machine that
      // already holds this session's prefix. HASHED, and truncated, because it
      // goes to a third party and is not needed there in any readable form: a
      // session id is a capability in this codebase, not a label.
      const cacheKey = createHash("sha256").update(currentSessionId()).digest("hex").slice(0, 32);

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelled) break;

        // Kept whole rather than destructured, because the result now also
        // carries what the call COST (`usage`) — and that is charged per call,
        // not per turn: a twelve-iteration tool loop on an empty balance would
        // otherwise overspend twelvefold before anyone noticed.
        const turn = await provider.stream(
          {
            apiKey,
            model,
            effort,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            // CAPPED FOR THE WIRE ONLY. `this.history` stays complete, because it
            // is what `exportHistory()` writes to the user's saved chat and what
            // their transcript is rebuilt from — losing a turn from THAT to save
            // a few tokens would be trading the product for the bill. What the
            // provider sees is a copy with the oldest turns dropped and older
            // tool_result bodies stubbed; no block is ever removed, so no call is
            // ever orphaned (see history.ts).
            messages: capHistory(this.history),
            maxOutputTokens: provider.maxOutputTokens,
            signal: this.inFlight.signal,
            cacheKey,
          },
          (delta) => {
            if (this.cancelled) return;
            // Remembered as well as painted — see `streamed`.
            if (delta.type === "text") this.streamed += delta.text;
            emit({ type: delta.type, text: delta.text });
          },
        );
        const { assistant, toolCalls } = turn;
        reportCost(model, turn.usage, i);

        // Record the assistant turn (text + reasoning + any tool calls).
        // NEVER EMPTY: `content: []` is a 400 on both providers, so a turn that
        // collected nothing must not become a message. That is not a
        // hypothetical — `max_output_tokens` counts reasoning tokens on the
        // Responses API, and a cut-off item is dropped rather than replayed
        // (provider-openai.ts), so a max-effort turn really can come back with
        // no blocks at all.
        if (assistant.length > 0) {
          this.history.push({ role: "assistant", content: assistant });
          this.streamed = "";
        } else if (this.streamed.trim()) {
          // Nothing collected, but the user watched text arrive: keep what they
          // saw, so the model and the transcript agree on what it said.
          this.history.push({ role: "assistant", content: [{ type: "text", text: this.streamed }] });
          this.streamed = "";
        } else {
          // Nothing at all. Say so — a bare `done` after a long wait reads as
          // the assistant ignoring the question — and let closeTurn put the stub
          // in the history.
          emit({ type: "text", text: EMPTY_TURN_NOTICE });
          break;
        }

        if (toolCalls.length === 0) break; // natural end of turn

        // Execute each requested tool, collect results for the next turn.
        const toolResults: NeutralBlock[] = [];
        for (const call of toolCalls) {
          if (this.cancelled) break;
          emit({ type: "tool_start", tool: call.name, label: toolLabel(call.name, call.input) });
          try {
            const out = await executeTool(call.name, call.input, emit);
            emit({ type: "tool_end", tool: call.name, ok: true });
            toolResults.push({ type: "tool_result", id: call.id, content: out });
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            emit({ type: "tool_end", tool: call.name, ok: false, summary: msg });
            // A missing slicer is the one failure the user can actually fix, so
            // give them the install page as a button instead of leaving the fix
            // as a sentence inside an error string.
            if (/prusaslicer not found|not installed/i.test(msg)) {
              emit({
                type: "action",
                label: "Download PrusaSlicer",
                kind: "install",
                href: "https://www.prusa3d.com/page/prusaslicer_424/",
                hint: "Slicely needs PrusaSlicer to slice. Searching and importing work without it.",
              });
            }
            toolResults.push({
              type: "tool_result",
              id: call.id,
              // SCRUBBED for the MODEL, not just for the wire. A thrown error is
              // the one tool result nobody writes by hand — PrusaSlicer's
              // stderr, a driver's "no such file", Node's ENOENT — and each of
              // them quotes an absolute path. The `tool_end` frame carrying the
              // same text is scrubbed on its way out (routes/chat.ts), but the
              // model reads THIS copy and then quotes it in its own prose, which
              // is prose no field-level scrub can rewrite.
              content: `Error: ${stripPaths(msg)}`,
              isError: true,
            });
          }
        }

        // ANSWER EVERY CALL, even the ones that never ran — the cancel above
        // deliberately skips the rest of a parallel batch, and an unanswered
        // call would brick the conversation it was only meant to interrupt.
        answerEveryCall(toolCalls, toolResults);

        this.history.push({ role: "user", content: toolResults });
      }
    } catch (err) {
      // A cancel the user asked for is not news. Whatever the provider threw as
      // the socket closed under it is the consequence, not a failure to report.
      if (this.cancelled && isAbort(err)) return;
      // EVERY OTHER FAILURE GOES THROUGH THE SAME CLASSIFIER THE ROUTES USE.
      // This used to emit `err.message` raw, which meant a key revoked mid-chat
      // arrived with no `key_rejected` code (so no key card, just red prose) and
      // carrying the provider's own sentence — "Incorrect API key provided:
      // sk-proj-…" — into the browser. `toWire` maps what it recognises to the
      // user's next action, generalises what it doesn't, and logs the stack
      // server-side either way.
      const { body } = toWire(err);
      const event: AgentEvent = { type: "error", message: body.error };
      if (body.code) event.code = body.code;
      emit(event);
    } finally {
      this.closeTurn();
      emit({ type: "done" });
    }
  }
}

/**
 * Log what one provider call cost, whoever is paying.
 *
 * BOTH FUNDING SOURCES, because the paid path's cost is exactly as interesting to
 * the owner as the free one — it is how a runaway tool loop gets noticed at all.
 *
 * A call the provider reported NO usage for is logged as an anomaly rather than
 * priced: charging a number we invented is the one failure mode worth refusing
 * outright. An unpriced model is the same case — `costMicros` throws for a model
 * with no row in the price table, and a missing price must not be able to fail
 * a turn the user has already been given.
 *
 * `source` is hard-coded to "user" here and stays that way until the accounts lane
 * lands the funding resolver, which is what knows whether the owner's free credit
 * paid for this call.
 */
function reportCost(model: string, usage: TurnUsage | undefined, iteration: number): void {
  if (!usage) {
    process.stderr.write(`[cost] model=${model} it=${iteration} usage=none (not charged)\n`);
    return;
  }
  try {
    logTurnCost({ model, usage, micros: costMicros(model, usage), source: "user", iteration });
  } catch {
    // An unpriced model. Say so once, loudly enough to grep, and carry on.
    process.stderr.write(`[cost] model=${model} it=${iteration} usage=unpriced (not charged)\n`);
  }
}

/**
 * Fill in a stub `tool_result` for every call in `calls` that `results` has no
 * answer for.
 *
 * Not an error: nothing went wrong with the tool, the turn ended around it, and
 * `is_error` would invite the model to apologise for a failure that never
 * happened. Used on both exit paths — the loop's own, and closeTurn's.
 */
function answerEveryCall(calls: Array<{ id: string }>, results: NeutralBlock[]): void {
  for (const call of calls) {
    const answered = results.some((r) => r.type === "tool_result" && r.id === call.id);
    if (!answered) results.push({ type: "tool_result", id: call.id, content: CANCELLED_RESULT });
  }
}

/**
 * Was this failure the abort we asked for?
 *
 * Checked only once the user has already cancelled, so it can afford to be loose:
 * `fetch` raises a `DOMException` named "AbortError", while the Anthropic SDK's
 * `APIUserAbortError` reports the unhelpful `name` of "Error" and says so only in
 * its message. Duck-typed rather than `instanceof`, because the whole point of
 * the provider seam is that this file imports no SDK.
 */
function isAbort(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; constructor?: { name?: unknown } } | undefined;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  if (e?.constructor?.name === "APIUserAbortError") return true;
  return typeof e?.message === "string" && /abort/i.test(e.message);
}

/** A stored history in the tagged v2 shape, or undefined for anything else
 *  (a v1 array, an empty placeholder, a corrupt file). */
function asExported(raw: unknown): ExportedHistory | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const h = raw as { version?: unknown; provider?: unknown; messages?: unknown };
  if (h.version !== HISTORY_VERSION || !isProviderId(h.provider) || !Array.isArray(h.messages)) {
    return undefined;
  }
  return { version: HISTORY_VERSION, provider: h.provider, messages: h.messages as NeutralMessage[] };
}
