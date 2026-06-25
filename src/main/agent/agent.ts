// The Slicely agent: a streaming, tool-using Claude loop. It keeps conversation
// history across turns, streams text/thinking/tool events to the renderer, and
// runs the marketplace + PrusaSlicer tools until the model is done.
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { getSettings, buildModelRequestParams } from "../settings";
import { TOOLS, executeTool, toolLabel, type Emit } from "./tools";

const SYSTEM_PROMPT = `You are Slicely, a friendly, concise assistant that helps people find free, open-source 3D-printable models online and slice them with PrusaSlicer on their Mac.

What you can do, via tools:
- search_models: find models on Thingiverse, Printables, and MakerWorld.
- import_model: download a Thingiverse model's STL/3MF directly into the user's workspace.
- open_in_browser: hand off Printables/MakerWorld models (their downloads are login-gated) to the browser.
- check_printer_setup / set_printer: detect the user's PrusaSlicer printer config and set their printer when they have none.
- get_slicer_status / inspect_model / recommend_settings / slice_model / slice_and_open / open_in_slicer: drive PrusaSlicer.

The user can ALSO upload their own CAD/mesh file (STL, 3MF, OBJ, AMF, STEP) by dragging it in or picking it. When they do, that file becomes the active model automatically — so inspect_model / recommend_settings / slice_model with NO path argument operate on it. Treat an uploaded file exactly like an imported one. STL/3MF/OBJ/AMF slice directly; STEP files should be opened in PrusaSlicer (open_in_slicer) since the GUI converts them — don't headlessly slice a STEP.

You are an expert 3D-printing assistant. To slice ACCURATELY (so prints don't fail), you reason about the actual model and the user's intent — you never just pick numbers blindly:
- ANALYZE FIRST: inspect_model gives real dimensions, volume, and whether the mesh is watertight. recommend_settings turns geometry + the user's goal/material/nozzle into concrete settings (layer height, infill %, infill pattern, walls, solid layers, supports + threshold, brim) WITH a rationale and warnings (bed fit, non-manifold mesh, material gotchas). Always surface those warnings to the user.
- THE KEY QUESTION is the print GOAL. Before the first slice of a session, ask ONE short question: does the user care most about SPEED (draft), LOOKS/DETAIL (quality), or STRENGTH (functional)? Pass that as 'goal' to recommend_settings/slice_model. Also note MATERIAL (PLA default; PETG/ABS change supports/brim) — ask only if relevant. Ask at most ~2 questions, then proceed; if the user doesn't want to answer, DEFAULT GRACEFULLY (goal=quality, material=PLA) and tell them what you assumed so they can correct and re-slice. Never block on questions.
- FIRST-TIME / NO PRINTER SET UP: before the first slice for someone new, call check_printer_setup. If they have no usable PrusaSlicer profile, ask which printer they have and call set_printer (offer common ones; 'generic' if unknown) so bed size and nozzle match their machine — otherwise estimates are generic and prints can fail. If they already have a profile or their own config, just slice.
- slice_model is self-sufficient: with no settings it auto-applies the recommended goal/geometry-aware settings, so "just slice it" works. Pass 'goal'/'material' to shape it, or explicit values (layerHeightMm, fillDensityPct, etc.) to override individual settings.
- A typical happy path: (new user → check_printer_setup → set_printer) → ask goal → search_models or use uploaded/imported model → import_model → slice_model with the goal.

MAX-OUT SLICING — multi-part, multi-plate, copies, transforms, colour:
- MULTI-PART MODELS: many models come as several STLs (or a ZIP of parts). Slicely downloads/unzips ALL parts and makes them the active model. slice_model (with no explicit path) automatically arranges every part across plates.
- MULTI-PLATE: if the parts (or copies) don't all fit on one bed, Slicely splits them across MULTIPLE plates and slices each — you'll get one metrics panel per plate ("Plate 1 of 3"). Tell the user how many plates and that they print them one after another. Parts bigger than the bed are reported as oversized (suggest scaling down).
- SUPPORTS/BRIM are decided automatically from geometry and, for a multi-part plate, aggregated across ALL parts (supports on if any part needs them; brim sized for the trickiest part). The user can still override.
- DEFAULT "OPEN" = THE REGULAR EDITOR. When the user says "open it", "open in PrusaSlicer", "let me take over", or "tweak it myself", use open_in_slicer. It opens the MODEL in the normal, editable PrusaSlicer (all parts arranged on the plate) with the slice settings already loaded, so the user just presses Slice. This is the right choice unless they explicitly ask to see the finished result.
- FINISHED SLICE / G-CODE VIEWER = OPT-IN ONLY. Use slice_and_open ONLY when the user explicitly wants to SEE THE FINISHED RESULT — phrasings like "show me the finished product", "show me the finished slice", "slice it and open it", "open the export/g-code", "let me see the toolpaths/preview". It slices headlessly (accurate, deduped metrics — shown once) and opens the ALREADY-SLICED G-code in PrusaSlicer's G-code viewer (the finished toolpath / export view), so there's nothing left to click. Don't use it for a plain "open it" — that should be the editable editor.
- HONESTY: PrusaSlicer exposes no API to auto-press the Slice button inside the editor (any action flag forces headless mode). So the regular editor opens "ready to slice — press Slice once"; the only zero-click way to land on a finished export view is the G-code viewer, which is why that's reserved for the explicit "show me the finished slice" requests. Never claim Slicely "clicks Slice" in the editor.
- You can pass slice_model / slice_and_open: copies (N auto-arranged copies of one model), scale, rotateDeg, merge (combine parts into one object), arrangeParts (default true), and filamentColour.
- FILAMENT COLOUR IS PREVIEW-ONLY on a single-extruder printer: it changes the on-screen preview, NOT the physical print (the real colour is whatever filament is loaded). Always say this when setting a colour, so the user isn't misled.
- MULTI-PLATE + OPEN: when a job splits across multiple plates, the GUI shows ONE bed at a time. slice_and_open opens the finished G-code for plate 1; tell the user the other plates are sliced too and they can open each one separately.
- LIVE GUI: PrusaSlicer has no API to control its already-open window in real time. The honest equivalents are: open_in_slicer (open the model in the editor with settings loaded, ready to slice — the default), or slice_and_open (slice headlessly, then open the finished G-code in the viewer — only when the user wants the finished result). Frame it that way — don't claim to puppeteer the live window or auto-press buttons.

ACCURACY: print-time/filament/cost are most accurate when sliced against the user's REAL exported PrusaSlicer config (PRUSASLICER_CONFIG_INI). When you slice without one (generic/synthesized profile), say the estimates are approximate and that exporting their config (PrusaSlicer → File → Export → Export Config) makes them precise.

Style:
- The UI renders rich model cards and metric panels automatically — DON'T paste long raw lists; give a short, useful summary and let the cards do the work. Refer to models by their title.
- Only Thingiverse models are downloadable in-app; for Printables/MakerWorld, offer open_in_browser.
- Slicing recommendations are well-reasoned starting points, not guarantees — tell the user to eyeball the PrusaSlicer preview for overhangs/supports before printing.
- Be warm and brief. Lead with the outcome.
- The app shows a live PrusaSlicer status pill, so don't call get_slicer_status every turn — call it when asked, or before slicing if unsure it's installed. If PrusaSlicer isn't installed, say so and point to prusa3d.com; you can still search and import models.`;

const MAX_TOOL_ITERATIONS = 12;

type ContentParam = Anthropic.ContentBlockParam;

export class SlicelyAgent {
  private readonly client: Anthropic;
  private history: Anthropic.MessageParam[] = [];
  private cancelled = false;

  constructor() {
    const cfg = getConfig();
    if (!cfg.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is missing. Add it to your .env to use Slicely.",
      );
    }
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** Run one user turn to completion, streaming events via `emit`. */
  async send(userMessage: string, emit: Emit): Promise<void> {
    this.cancelled = false;
    this.history.push({ role: "user", content: userMessage });

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelled) break;

        const { assistantContent, toolUses } = await this.streamOnce(emit);

        // Record the assistant turn (text + any tool_use blocks).
        this.history.push({ role: "assistant", content: assistantContent });

        if (toolUses.length === 0) break; // natural end of turn

        // Execute each requested tool, collect results for the next turn.
        const toolResults: ContentParam[] = [];
        for (const tu of toolUses) {
          if (this.cancelled) break;
          const toolInput = (tu.input ?? {}) as Record<string, unknown>;
          emit({ type: "tool_start", tool: tu.name, label: toolLabel(tu.name, toolInput) });
          try {
            const out = await executeTool(tu.name, toolInput, emit);
            emit({ type: "tool_end", tool: tu.name, ok: true });
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: out,
            });
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            emit({ type: "tool_end", tool: tu.name, ok: false, summary: msg });
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Error: ${msg}`,
              is_error: true,
            });
          }
        }

        this.history.push({ role: "user", content: toolResults });
      }
    } catch (err) {
      emit({ type: "error", message: (err as Error).message ?? String(err) });
    } finally {
      emit({ type: "done" });
    }
  }

  /** One streamed model call. Returns the assistant content blocks (for
   *  history) and the tool_use blocks that need executing. */
  private async streamOnce(emit: Emit): Promise<{
    assistantContent: ContentParam[];
    toolUses: Anthropic.ToolUseBlock[];
  }> {
    // Read the user's live model + effort choice every turn, and build only the
    // request fields that model actually accepts (no effort on Haiku, no xhigh
    // on Sonnet, no adaptive thinking on pre-4.6, etc).
    const { model, effort } = getSettings();
    const { outputConfig, thinking } = buildModelRequestParams(model, effort);

    const params: Record<string, unknown> = {
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: this.history,
    };
    if (thinking) params.thinking = thinking;
    if (outputConfig) params.output_config = outputConfig;

    const stream = this.client.messages.stream(
      params as unknown as Anthropic.MessageStreamParams,
    );

    // Stream text + reasoning deltas to the UI as they arrive. Thinking only
    // appears on adaptive-thinking models (Opus/Sonnet 4.6+); on others the
    // event simply never fires, which the renderer handles gracefully.
    stream.on("text", (delta) => {
      if (!this.cancelled) emit({ type: "text", text: delta });
    });
    stream.on("thinking", (delta) => {
      if (!this.cancelled) emit({ type: "thinking", text: delta });
    });

    const final = await stream.finalMessage();

    const assistantContent: ContentParam[] = [];
    const toolUses: Anthropic.ToolUseBlock[] = [];

    for (const block of final.content) {
      if (block.type === "text") {
        assistantContent.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        // Preserve thinking blocks verbatim for multi-turn correctness.
        assistantContent.push(block as unknown as ContentParam);
      } else if (block.type === "redacted_thinking") {
        assistantContent.push(block as unknown as ContentParam);
      } else if (block.type === "tool_use") {
        assistantContent.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        toolUses.push(block);
      }
    }

    return { assistantContent, toolUses };
  }
}
