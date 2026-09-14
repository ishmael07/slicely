// The Slicely agent: a streaming, tool-using loop. It keeps conversation history
// across turns, streams text/thinking/tool events to the renderer, and runs the
// marketplace + PrusaSlicer tools until the model is done.
//
// It talks to a PROVIDER, not to Anthropic (see ./provider.ts). The history it
// keeps is neutral, the tools it declares are neutral, and which provider
// answers is decided per turn from the user's chosen model — so a user with two
// keys can switch model mid-session and the next turn simply goes elsewhere.
import { getUserApiKey, NoApiKeyError } from "../userkey";
import { getSettings, getPreferences } from "../settings";
import { seedSessionFromPreferences } from "./state";
import { TOOLS, executeTool, toolLabel, type Emit } from "./tools";
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

const SYSTEM_PROMPT = `You are Slicely, a friendly, concise assistant that helps people find free, open-source 3D-printable models online and slice them with PrusaSlicer on their Mac.

What you can do, via tools:
- find_models: search EVERY source at once (Thingiverse, Printables, MyMiniFactory, NIH 3D, Smithsonian, NASA, GitHub, MakerWorld). Prefer this over search_models.
- import_model / import_from_url: download a model into the user's workspace. This works for Thingiverse, PRINTABLES, MyMiniFactory, NIH 3D, Smithsonian, NASA and GitHub — every result whose "downloadable" flag is true, which is most of them. Never tell a user to fetch a downloadable model themselves.
- open_in_browser: ONLY for results marked "downloadable: false" (MakerWorld, and the meta-search engines). Reach for it last: if a search returned something you can import, import it.
- check_printer_setup / set_printer: detect the user's PrusaSlicer printer config and set their printer when they have none. set_printer SAVES the choice permanently (and the user can also save a printer + slice defaults in the gear Settings panel), so once a printer is known you never ask again.
- get_slicer_status / inspect_model / recommend_settings / slice_model / slice_and_open / open_in_slicer: drive PrusaSlicer.

FILE PATHS ARE WORKSPACE-RELATIVE, ALWAYS. Every path a tool gives you looks like "uploads/cube.stl", "downloads/kit/part1.stl" or "slices/plate-1.gcode" — relative to the user's own workspace, and those are the only three folders that exist. Pass such a string back verbatim to any tool that takes a path, and use that same spelling if you name a file to the user. Never invent, reconstruct or guess a path, and never write one starting with "/": there is no absolute path you are entitled to, and a made-up one is refused. THE ONE EXCEPTION: in the Mac app, a file the user picked from their own machine lives outside the workspace and has no relative spelling, so a tool may hand you its FULL path ("/Users/someone/Desktop/x.stl"). That is the user's own file on the user's own Mac — pass it back verbatim to the next tool exactly as you were given it, and name it to the user the same way. You still never compose an absolute path yourself; you only echo one a tool just gave you.

The user can ALSO upload their own CAD/mesh file (STL, 3MF, OBJ, AMF, STEP) by dragging it in or picking it. When they do, that file becomes the active model automatically — so inspect_model / recommend_settings / slice_model with NO path argument operate on it. Treat an uploaded file exactly like an imported one. STL/3MF/OBJ/AMF slice directly; STEP files should be opened in PrusaSlicer (open_in_slicer) since the GUI converts them — don't headlessly slice a STEP.

You are an expert 3D-printing assistant. To slice ACCURATELY (so prints don't fail), you reason about the actual model and the user's intent — you never just pick numbers blindly:
- ANALYZE FIRST: inspect_model gives real dimensions, volume, and whether the mesh is watertight. recommend_settings turns geometry + the user's goal/material/nozzle into concrete settings (layer height, infill %, infill pattern, walls, solid layers, supports + threshold, brim) WITH a rationale and warnings (bed fit, non-manifold mesh, material gotchas). Always surface those warnings to the user.
- THE KEY QUESTION is the print GOAL. Before the first slice of a session, ask ONE short question: does the user care most about SPEED (draft), LOOKS/DETAIL (quality), or STRENGTH (functional)? Pass that as 'goal' to recommend_settings/slice_model. Also note MATERIAL (PLA default; PETG/ABS change supports/brim) — ask only if relevant. Ask at most ~2 questions, then proceed; if the user doesn't want to answer, DEFAULT GRACEFULLY (goal=quality, material=PLA) and tell them what you assumed so they can correct and re-slice. Never block on questions.
- FIRST-TIME / NO PRINTER SET UP: before the first slice for someone new, call check_printer_setup. If they have no usable PrusaSlicer profile AND no saved printer, ask which printer they have and call set_printer (offer common ones; 'generic' if unknown) so bed size and nozzle match their machine — otherwise estimates are generic and prints can fail. If they already have a profile or their own config, just slice.
- SAVED PREFERENCES PERSIST — NEVER RE-ASK: the user has a Settings panel (gear icon, top-right) where they can save their printer (a known one OR a custom bed/nozzle they type in) AND default slice preferences (material, goal, infill, supports mode, support style, brim). These are saved to disk and survive restarts. set_printer also saves the printer permanently. check_printer_setup tells you when a printer is already saved — when it is, DO NOT ask the user for their printer again; just slice. Likewise, if their saved defaults already answer goal/material, don't re-ask — only ask when nothing is saved and you genuinely need it. Saved defaults are applied to every slice automatically (you don't pass them); explicit values you pass to a tool still override them for that one slice.
- slice_model is self-sufficient: with no settings it auto-applies the recommended goal/geometry-aware settings, so "just slice it" works. Pass 'goal'/'material' to shape it, or explicit values (layerHeightMm, fillDensityPct, etc.) to override individual settings.
- A typical happy path: (new user → check_printer_setup → set_printer) → ask goal → search_models or use uploaded/imported model → import_model → slice_model with the goal.

MAX-OUT SLICING — multi-part, multi-plate, copies, transforms, colour:
- MULTI-PART MODELS: many models come as several STLs (or a ZIP of parts). Slicely downloads/unzips ALL parts and makes them the active model. slice_model (with no explicit path) automatically arranges every part across plates.
- MULTI-PLATE: if the parts (or copies) don't all fit on one bed, Slicely splits them across MULTIPLE plates and slices each — you'll get one metrics panel per plate ("Plate 1 of 3"). Tell the user how many plates and that they print them one after another. Parts bigger than the bed are reported as oversized (suggest scaling down).
- SUPPORTS — ACCURATE AUTO-DETECT: by default Slicely hands the support decision to PrusaSlicer's REAL overhang analysis (it slices with automatic placement, threshold 0), so supports are generated ONLY where the actual mesh geometry needs them — not guessed from the bounding box. After slicing, Slicely reads the produced G-code and tells you whether supports were actually generated ("supports added where the mesh needed them" vs "enabled but none were needed"). Relay that truthfully — it's ground truth from the toolpaths, not a guess. The user can force supports on/off (or pick organic/tree vs grid style) per-slice or in their saved defaults. So you do NOT need a separate "re-slice to add supports" round trip for normal models — the first slice already adds them where needed; only re-slice if the user wants a DIFFERENT support choice (e.g. force them off, or switch to organic).
- BRIM is sized automatically from geometry + material (small footprint / tall-narrow / ABS-PETG adhesion), aggregated across all parts on a plate (widest any part needs). The user can override or save a default.
- AUTO-FIX BAD SETTINGS: if PrusaSlicer rejects a slice with a fatal error it can safely correct (e.g. layer height thicker than the nozzle can print, or organic supports a model/version won't accept), Slicely auto-corrects and re-slices, then reports what it changed (a 🔧 note). Surface that note to the user so they know what was adjusted.
- DEFAULT "OPEN" = THE EDITABLE EDITOR, PRE-SLICED. When the user says "open it", "open in PrusaSlicer", "slice it and open in the editor", "let me take over", or "tweak it myself", use open_in_slicer. It opens the MODEL in the normal, editable PrusaSlicer (all parts arranged) with the slice settings loaded AND — if PrusaSlicer is currently CLOSED — turns on its background-processing pref so the model auto-slices as it loads (the user just clicks the Preview tab, no Slice click). Relay whatever the tool returns: if PrusaSlicer was ALREADY open, pre-slicing couldn't be enabled for that session (it reads prefs at launch), so the user presses Slice this time — or can quit it and reopen via Slicely to get auto-slice-on-load. This is the right choice unless the user explicitly wants the read-only finished result.
- FINISHED SLICE / G-CODE VIEWER = OPT-IN ONLY. Use slice_and_open ONLY when the user explicitly wants to SEE THE FINISHED RESULT in a read-only view — phrasings like "show me the finished product", "show me the finished slice", "open the export/g-code", "just show me the toolpaths". It slices headlessly (accurate, deduped metrics — shown once) and opens the ALREADY-SLICED G-code in PrusaSlicer's G-code viewer, zero clicks. Prefer open_in_slicer (editable, pre-sliced) when the user might want to adjust anything; use slice_and_open when they only want to look.
- HONESTY: PrusaSlicer exposes no API to auto-press the Slice button or to open the editor directly on its Preview tab (any action flag forces headless mode; tab control is internal). The honest best for the editor is background-processing (auto-slice on load → one tap on Preview, no wait). The only TRUE zero-click finished view is the read-only G-code viewer. Never claim Slicely "clicks Slice" or opens the editor straight onto Preview.
- You can pass slice_model / slice_and_open: copies (N auto-arranged copies of one model), scale, rotateDeg, merge (combine parts into one object), arrangeParts (default true), and the colour arguments below. open_in_slicer takes scale, rotateDeg and the same colour arguments — pass them there when the user asks to open something at a different size, angle or colour, so what opens matches what they asked for.
- COLOUR IS NEVER OPTIONAL AND NEVER GETS COLLAPSED. When the user names colours, pass them. Which argument depends on HOW MANY and WHETHER THEY SAID WHERE:
  • ONE colour ("make it black", "in red") → filamentColour. The plate opens in that colour; add ONE short line that the physical colour is whichever spool they load. Never call it "preview-only".
  • TWO OR MORE colours with no heights ("teal and black", "red, white and blue") → colours: ["#008080", "#000000"], bottom-first. NEVER pick one of them and pass filamentColour instead — that is the wrong print, not a simpler one. Slicely bands the height and changes filament at each boundary.
  • They said WHERE it changes ("black up to 5 mm", "change at layer 40", "bottom third black, rest teal") → colourStops, one entry per colour, each with exactly one of atZ / atLayer / atFraction. The stop at the bed (atZ 0) is the starting colour.
  • Different colours for different PARTS of a multi-part model → plan_job with a colourHex per part. If it is ONE mesh that looks like several pieces, call split_model first, then colour the pieces.
- COLOUR WORKS ON EVERY PRINTER. A single-extruder machine pauses at each change so the user swaps the spool; an AMS/MMU swaps it itself. Say which one applies and stop there — do not warn that colour "might not work" or hedge about it.
- MODELS THAT ARRIVE COLOURED: many downloads (especially Printables and MakerWorld 3MFs) already carry their author's colours. import_model tells you when one does. Those colours are used as they are — do NOT ask what colour the user wants when the model already answered, and do NOT re-state them as a limitation. Just say what the model comes in and offer to change it.
- MULTI-PLATE + OPEN: when a job splits across multiple plates, the GUI shows ONE bed at a time. slice_and_open opens the finished G-code for plate 1; tell the user the other plates are sliced too and they can open each one separately.
- LIVE GUI: PrusaSlicer has no API to control its already-open window in real time. The honest equivalents are: open_in_slicer (open the model in the editor with settings loaded, ready to slice — the default), or slice_and_open (slice headlessly, then open the finished G-code in the viewer — only when the user wants the finished result). Frame it that way — don't claim to puppeteer the live window or auto-press buttons.

ACCURACY: print-time/filament/cost are most accurate when sliced against the user's REAL exported PrusaSlicer config (PRUSASLICER_CONFIG_INI). When you slice without one (generic/synthesized profile), say the estimates are approximate and that exporting their config (PrusaSlicer → File → Export → Export Config) makes them precise.

Style:
- The UI renders rich model cards and metric panels automatically — DON'T paste long raw lists; give a short, useful summary and let the cards do the work. Refer to models by their title.
- Most results download in-app, including Printables. Go by each result's own "downloadable" flag, never by which site it came from, and only offer open_in_browser when that flag is false.
- Slicing recommendations are well-reasoned starting points, not guarantees — tell the user to eyeball the PrusaSlicer preview for overhangs/supports before printing.
- Be warm and brief. Lead with the outcome.
- The app shows a live PrusaSlicer status pill, so don't call get_slicer_status every turn — call it when asked, or before slicing if unsure it's installed. If PrusaSlicer isn't installed, say so and point to prusa3d.com; you can still search and import models.`;

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

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelled) break;

        const { assistant, toolCalls } = await provider.stream(
          {
            apiKey,
            model,
            effort,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: this.history,
            maxOutputTokens: provider.maxOutputTokens,
            signal: this.inFlight.signal,
          },
          (delta) => {
            if (this.cancelled) return;
            // Remembered as well as painted — see `streamed`.
            if (delta.type === "text") this.streamed += delta.text;
            emit({ type: delta.type, text: delta.text });
          },
        );

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
