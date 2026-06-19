// Tool definitions for the Slicely agent, plus the executor that runs each one
// against the providers / PrusaSlicer modules. The agent loop streams the
// structured results back to the UI in addition to feeding them to the model.
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, SliceParams } from "../../shared/types";
import { searchModels, downloadModel, type SourceFilter } from "../providers";
import {
  getStatus,
  getModelInfo,
  slice,
  openInGui,
  recommendSettings,
} from "../prusaslicer";
import { sessionState } from "./state";

/** Emit a structured side-channel event to the renderer. */
export type Emit = (event: AgentEvent) => void;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_models",
    description:
      "Search free, open-source 3D-printable model marketplaces for models matching a query. " +
      "Returns a list of models with titles, creators, licenses, and whether Slicely can download " +
      "them directly. Use this whenever the user wants to find or print something (e.g. 'a model car'). " +
      "Thingiverse models are directly downloadable in-app; Printables and MakerWorld open in the browser.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, e.g. 'low poly model car', 'articulated dragon', 'phone stand'.",
        },
        source: {
          type: "string",
          enum: ["all", "thingiverse", "printables", "makerworld"],
          description:
            "Which marketplace to search. Default 'all'. Prefer 'thingiverse' when the user wants something they can import directly.",
        },
        limit: {
          type: "integer",
          description: "Max results per source (1–30). Default 8.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "import_model",
    description:
      "Download a model's mesh file (STL/3MF) from Thingiverse into the local workspace so it can be " +
      "inspected and sliced. Only works for Thingiverse models (downloadable: true). For Printables/MakerWorld, " +
      "use open_in_browser instead. Returns the local file path.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["thingiverse", "printables", "makerworld"] },
        modelId: { type: "string", description: "The model's id from search_models." },
        fileId: {
          type: "string",
          description: "Optional specific file id; omit to auto-pick the best mesh (prefers .stl).",
        },
      },
      required: ["source", "modelId"],
    },
  },
  {
    name: "open_in_browser",
    description:
      "Open a model's web page in the user's default browser, so they can download it manually. " +
      "Use for Printables and MakerWorld models, whose downloads are login-gated.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The model's webUrl from search_models." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_slicer_status",
    description:
      "Check whether PrusaSlicer is installed, what version, and whether it's currently running. " +
      "Use this to detect the user's slicing software before slicing, or when the user asks what slicer they have.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "inspect_model",
    description:
      "Get the physical dimensions (mm), volume, triangle count, and manifold status of a downloaded " +
      "model file using PrusaSlicer. Use after import_model, or on a path the user provides, to report " +
      "accurate metrics before slicing.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to a downloaded model file. Omit to use the most recently imported model.",
        },
      },
    },
  },
  {
    name: "recommend_settings",
    description:
      "Get recommended slicing settings (layer height, infill, supports, brim) for a model based on its " +
      "dimensions, with a plain-language rationale. Use this to advise the user on optimal settings. " +
      "Inspects the model first if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to a downloaded model file. Omit to use the most recently imported model.",
        },
      },
    },
  },
  {
    name: "slice_model",
    description:
      "Slice a downloaded model into G-code with PrusaSlicer and return real metrics: estimated print " +
      "time, filament used (mm and grams), filament cost, and layer count. Provide any settings the user " +
      "wants; omit a setting to use the recommended/default value.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the model file. Omit to use the most recently imported model.",
        },
        layerHeightMm: { type: "number", description: "e.g. 0.2" },
        fillDensityPct: {
          type: "number",
          description: "Infill density as a percent, 0–100 (e.g. 20).",
        },
        supportMaterial: { type: "boolean" },
        brimWidthMm: { type: "number", description: "0 for no brim." },
        nozzleDiameterMm: { type: "number", description: "e.g. 0.4" },
      },
    },
  },
  {
    name: "open_in_slicer",
    description:
      "Open a downloaded model file in the PrusaSlicer GUI so the user can tweak and print it themselves. " +
      "Use when the user wants to take over manually.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the model. Omit to use the most recently imported model.",
        },
      },
    },
  },
];

/** Execute one tool call. Returns the string fed back to the model as the
 *  tool_result, and emits structured UI events as a side effect. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  emit: Emit,
): Promise<string> {
  switch (name) {
    case "search_models": {
      const query = String(input.query ?? "").trim();
      if (!query) return "Error: empty query.";
      const source = (input.source as SourceFilter) ?? "all";
      const limit = typeof input.limit === "number" ? input.limit : 8;
      const models = await searchModels(query, { source, limit });
      sessionState.lastResults = models;
      emit({ type: "models", models });
      if (models.length === 0) {
        return `No models found for "${query}". Suggest the user try different keywords.`;
      }
      // Compact summary for the model: enough to reference, not the whole blob.
      const lines = models.map(
        (m, i) =>
          `${i + 1}. [${m.source}] id=${m.id} "${m.title}"${
            m.creator ? ` by ${m.creator}` : ""
          } — ${m.downloadable ? "downloadable in-app" : "open in browser"}${
            m.license ? ` — license: ${m.license}` : ""
          }`,
      );
      return `Found ${models.length} models:\n${lines.join("\n")}`;
    }

    case "import_model": {
      const source = String(input.source ?? "");
      const modelId = String(input.modelId ?? "");
      const fileId = input.fileId ? String(input.fileId) : undefined;
      const model =
        sessionState.lastResults.find(
          (m) => m.id === modelId && m.source === source,
        ) ?? sessionState.lastResults.find((m) => m.id === modelId);

      const result = await downloadModel(source, modelId, fileId);
      sessionState.lastModelPath = result.localPath;
      if (model) {
        emit({ type: "download", model, result });
      }
      return `Downloaded "${result.fileName}" (${formatBytes(
        result.sizeBytes,
      )}) to ${result.localPath}. It is now the active model for inspect/slice.`;
    }

    case "open_in_browser": {
      const url = String(input.url ?? "");
      if (!/^https?:\/\//.test(url)) return "Error: invalid URL.";
      sessionState.openExternal?.(url);
      return `Opened ${url} in the user's browser.`;
    }

    case "get_slicer_status": {
      const status = await getStatus();
      emit({ type: "status", status });
      if (!status.installed) {
        return "PrusaSlicer is NOT installed (expected at /Applications/PrusaSlicer.app). Tell the user they need to install it from prusa3d.com to slice.";
      }
      return `PrusaSlicer ${status.version ?? "(unknown version)"} is installed${
        status.running ? " and currently running" : " (not currently running)"
      }.`;
    }

    case "inspect_model": {
      const path = resolvePath(input.path);
      const info = await getModelInfo(path);
      emit({ type: "info", info });
      return (
        `Model "${path}":\n` +
        `  dimensions: ${info.sizeX.toFixed(1)} × ${info.sizeY.toFixed(1)} × ${info.sizeZ.toFixed(
          1,
        )} mm\n` +
        (info.volumeMm3 !== undefined
          ? `  volume: ${(info.volumeMm3 / 1000).toFixed(1)} cm³\n`
          : "") +
        (info.facets !== undefined ? `  triangles: ${info.facets}\n` : "") +
        (info.manifold !== undefined
          ? `  manifold (watertight): ${info.manifold ? "yes" : "no"}\n`
          : "") +
        (info.parts !== undefined ? `  parts: ${info.parts}` : "")
      );
    }

    case "recommend_settings": {
      const path = resolvePath(input.path);
      const info = await getModelInfo(path);
      emit({ type: "info", info });
      const rec = recommendSettings(info);
      sessionState.lastRecommendation = rec.params;
      return (
        `Recommended settings for this model:\n` +
        `  layer height: ${rec.params.layerHeightMm} mm\n` +
        `  infill: ${rec.params.fillDensityPct}%\n` +
        `  supports: ${rec.params.supportMaterial ? "yes" : "no"}\n` +
        `  brim: ${rec.params.brimWidthMm} mm\n` +
        `Rationale:\n- ${rec.rationale.join("\n- ")}`
      );
    }

    case "slice_model": {
      const path = resolvePath(input.path);

      // Did the model pass any explicit setting on this call?
      const explicit: SliceParams = {
        ...numParam(input, "layerHeightMm"),
        ...numParam(input, "fillDensityPct"),
        ...numParam(input, "brimWidthMm"),
        ...numParam(input, "nozzleDiameterMm"),
        ...(typeof input.supportMaterial === "boolean"
          ? { supportMaterial: input.supportMaterial }
          : {}),
      };
      const hasExplicit = Object.keys(explicit).length > 0;

      // Establish a recommended baseline so "just slice it" always uses sensible
      // geometry-aware settings — even if recommend_settings was never called.
      let baseline = sessionState.lastRecommendation;
      if (!baseline || Object.keys(baseline).length === 0) {
        const info = await getModelInfo(path);
        emit({ type: "info", info });
        baseline = recommendSettings(info).params;
        sessionState.lastRecommendation = baseline;
      }

      const params: SliceParams = { ...baseline, ...explicit };
      const metrics = await slice(path, params);
      emit({ type: "metrics", metrics });

      const usedLine =
        `Used settings: ${params.layerHeightMm ?? "default"} mm layers, ` +
        `${params.fillDensityPct ?? "default"}% infill, ` +
        `supports ${params.supportMaterial ? "on" : "off"}, ` +
        `brim ${params.brimWidthMm ?? 0} mm` +
        (hasExplicit ? " (your overrides applied)" : " (recommended)") +
        ".";

      return (
        `Sliced successfully → ${metrics.gcodePath}\n` +
        usedLine +
        "\n" +
        (metrics.estimatedPrintTime
          ? `  print time: ${metrics.estimatedPrintTime}\n`
          : "") +
        (metrics.filamentUsedG !== undefined
          ? `  filament: ${metrics.filamentUsedG.toFixed(1)} g`
          : "") +
        (metrics.filamentUsedMm !== undefined
          ? ` (${(metrics.filamentUsedMm / 1000).toFixed(2)} m)\n`
          : "\n") +
        (metrics.filamentCost !== undefined
          ? `  cost: ${metrics.filamentCost.toFixed(2)}\n`
          : "") +
        (metrics.layerCount !== undefined ? `  layers: ${metrics.layerCount}` : "")
      );
    }

    case "open_in_slicer": {
      const path = resolvePath(input.path);
      await openInGui(path);
      return `Opened ${path} in PrusaSlicer.`;
    }

    default:
      return `Error: unknown tool "${name}".`;
  }
}

/** Short human-facing label for the tool, shown while it runs. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_models":
      return `Searching for "${String(input.query ?? "")}"…`;
    case "import_model":
      return "Downloading model…";
    case "open_in_browser":
      return "Opening in browser…";
    case "get_slicer_status":
      return "Checking PrusaSlicer…";
    case "inspect_model":
      return "Inspecting model…";
    case "recommend_settings":
      return "Working out optimal settings…";
    case "slice_model":
      return "Slicing…";
    case "open_in_slicer":
      return "Opening PrusaSlicer…";
    default:
      return `Running ${name}…`;
  }
}

function resolvePath(p: unknown): string {
  const path = p ? String(p) : sessionState.lastModelPath;
  if (!path) {
    throw new Error(
      "No model file available. Import a model first (or pass an explicit path).",
    );
  }
  return path;
}

function numParam(
  input: Record<string, unknown>,
  key: string,
): Record<string, number> {
  return typeof input[key] === "number"
    ? { [key]: input[key] as number }
    : {};
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
