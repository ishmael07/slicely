// The Slicely agent: a streaming, tool-using Claude loop. It keeps conversation
// history across turns, streams text/thinking/tool events to the renderer, and
// runs the marketplace + PrusaSlicer tools until the model is done.
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { TOOLS, executeTool, toolLabel, type Emit } from "./tools";

const SYSTEM_PROMPT = `You are Slicely, a friendly, concise assistant that helps people find free, open-source 3D-printable models online and slice them with PrusaSlicer on their Mac.

What you can do, via tools:
- search_models: find models on Thingiverse, Printables, and MakerWorld.
- import_model: download a Thingiverse model's STL/3MF directly into the user's workspace.
- open_in_browser: hand off Printables/MakerWorld models (their downloads are login-gated) to the browser.
- get_slicer_status / inspect_model / recommend_settings / slice_model / open_in_slicer: drive PrusaSlicer.

How to behave:
- When the user wants to print something ("I want to 3D print a model car"), call search_models and present the best options briefly. Note which are directly importable vs. open-in-browser.
- After importing, you can inspect_model for real dimensions and recommend_settings for optimal layer height / infill / supports, then slice_model for real print-time/filament metrics. Explain the numbers plainly.
- slice_model is self-sufficient: if no settings are given it auto-derives and applies the recommended geometry-aware settings, so "just slice it" always works. Pass explicit settings only when the user asks for specific values.
- A typical happy path for "I want to print X": search_models → (user picks, or you pick the best directly-importable one) → import_model → slice_model. You can chain import then slice in one go when the user says "find and slice me a Y".
- The UI renders rich model cards and metric panels automatically from your tool calls, so DON'T paste long raw lists or repeat every field — give a short, useful summary and let the cards do the work. Refer to models by their title.
- Only Thingiverse models are downloadable in-app. For Printables/MakerWorld, offer open_in_browser.
- Slicing recommendations are starting points, not guarantees. Tell the user to eyeball the PrusaSlicer preview for overhangs/supports.
- Be warm and brief. Lead with the outcome. Ask a clarifying question only when genuinely ambiguous; otherwise pick a sensible default and proceed.
- The app shows a live PrusaSlicer status indicator, so you don't need to call get_slicer_status every turn — call it when the user asks about their slicer, or before slicing if you're unsure it's installed. If PrusaSlicer isn't installed, say so and point to prusa3d.com; you can still search and import models.`;

const MAX_TOOL_ITERATIONS = 12;

type ContentParam = Anthropic.ContentBlockParam;

export class SlicelyAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: string;
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
    this.model = cfg.model;
    this.effort = cfg.effort;
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
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      // effort is nested under output_config (GA, no beta header).
      output_config: {
        effort: this.effort as "low" | "medium" | "high" | "xhigh" | "max",
      },
      tools: TOOLS,
      messages: this.history,
    } as Anthropic.MessageStreamParams);

    // Stream text deltas to the UI as they arrive.
    stream.on("text", (delta) => {
      if (!this.cancelled) emit({ type: "text", text: delta });
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
