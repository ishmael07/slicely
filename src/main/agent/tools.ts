// Tool definitions for the Slicely agent, plus the executor that runs each one
// against the providers / PrusaSlicer modules. The agent loop streams the
// structured results back to the UI in addition to feeding them to the model.
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  SliceParams,
  PrintGoal,
  PrintMaterial,
  ModelInfo,
} from "../../shared/types";
import { searchModels, downloadModel, type SourceFilter } from "../providers";
import {
  getStatus,
  getModelInfo,
  slicePlates,
  openInGui,
  recommendSettings,
  recommendForPlate,
  type RecommendInput,
} from "../prusaslicer";
import {
  getProfileState,
  resolveSliceConfig,
  KNOWN_PRINTERS,
} from "../profiles";
import { sessionState } from "./state";

const GOALS: PrintGoal[] = ["draft", "quality", "functional"];
const MATERIALS: PrintMaterial[] = ["PLA", "PETG", "ABS"];

/** Mesh formats PrusaSlicer slices directly (STEP is GUI-import only). */
const SLICEABLE_PART_EXTS = new Set([".stl", ".3mf", ".obj", ".amf"]);

function extLower(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

/** Filename stem (no directory, no extension) for naming output gcode. */
function baseStem(p: string): string {
  const file = p.split(/[/\\]/).pop() ?? "model";
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Build a RecommendInput from tool input, defaulting gracefully. Pulls the
 *  bed size + nozzle from the session's chosen printer so the bed-fit check and
 *  layer-height bounds match the user's actual machine. */
function recommendInput(input: Record<string, unknown>): RecommendInput {
  const out: RecommendInput = {};
  if (typeof input.goal === "string" && (GOALS as string[]).includes(input.goal)) {
    out.goal = input.goal as PrintGoal;
  }
  if (
    typeof input.material === "string" &&
    (MATERIALS as string[]).includes(input.material)
  ) {
    out.material = input.material as PrintMaterial;
  }

  // Printer geometry: explicit nozzle wins, else the chosen printer's nozzle.
  const printer = sessionState.printerKey
    ? KNOWN_PRINTERS[sessionState.printerKey]
    : undefined;
  if (typeof input.nozzleMm === "number") out.nozzleMm = input.nozzleMm;
  else if (typeof input.nozzleDiameterMm === "number")
    out.nozzleMm = input.nozzleDiameterMm;
  else if (printer) out.nozzleMm = printer.nozzleMm;
  if (printer) out.bed = printer.bed;

  return out;
}

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
    name: "check_printer_setup",
    description:
      "Check whether the user has a usable PrusaSlicer printer profile configured (they ran the setup " +
      "wizard / exported a config). Use this BEFORE the first slice for a new user. If they have nothing " +
      "set up, ask which printer they have and call set_printer — otherwise slices use generic defaults and " +
      "estimates won't match their machine. Returns the config state plus the list of printers Slicely knows.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_printer",
    description:
      "Set the user's printer when they don't have a PrusaSlicer profile configured. Slicely synthesizes a " +
      "config (bed size + nozzle) so slices are realistic for their machine. Use the printer key from " +
      "check_printer_setup, or 'generic' if unknown.",
    input_schema: {
      type: "object",
      properties: {
        printerKey: {
          type: "string",
          description:
            "A printer key from check_printer_setup (e.g. 'prusa-mk4', 'ender-3', 'bambu-a1', 'generic').",
        },
      },
      required: ["printerKey"],
    },
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
      "Analyze a model's geometry and recommend accurate, print-safe slicing settings (layer height, " +
      "infill density + pattern, walls, solid layers, supports, brim) with a plain-language rationale AND " +
      "warnings (bed fit, non-watertight mesh, material gotchas). Pass the user's goal/material/nozzle when " +
      "known — they materially change the result. Inspects the model first if needed. Use this before slicing " +
      "so you can explain WHY the settings fit the print.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to a model file. Omit to use the active (imported/uploaded) model.",
        },
        goal: {
          type: "string",
          enum: ["draft", "quality", "functional"],
          description:
            "What the print is for: draft = fast/rough, quality = looks/detail, functional = strong/load-bearing. Default quality.",
        },
        material: {
          type: "string",
          enum: ["PLA", "PETG", "ABS"],
          description: "Filament family. Default PLA.",
        },
        nozzleMm: {
          type: "number",
          description: "Nozzle diameter in mm (default 0.4). Bounds the layer height.",
        },
      },
    },
  },
  {
    name: "slice_model",
    description:
      "Slice the active model into G-code with PrusaSlicer and return real metrics: estimated print time, " +
      "filament used (mm and grams), filament cost, and layer count. If no settings are given it auto-applies " +
      "the geometry/goal-aware recommended settings (including supports + brim, decided from the model — and " +
      "for multi-part models aggregated across ALL parts), so 'just slice it' always works. Multi-part models " +
      "and copies are arranged automatically, and SPLIT ACROSS MULTIPLE PLATES when they don't fit one bed — " +
      "you get one metrics result per plate. Pass goal/material to shape the recommendation, or explicit " +
      "values to override individual settings. You can also make copies, scale, rotate, merge parts, or set a " +
      "preview filament colour.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the model file. Omit to use the active (imported/uploaded) model (and to auto-include its parts on one plate).",
        },
        goal: {
          type: "string",
          enum: ["draft", "quality", "functional"],
          description: "Print goal driving the recommended baseline. Default quality.",
        },
        material: {
          type: "string",
          enum: ["PLA", "PETG", "ABS"],
          description: "Filament family. Default PLA. Also improves weight/cost accuracy.",
        },
        layerHeightMm: { type: "number", description: "Override, e.g. 0.2" },
        fillDensityPct: {
          type: "number",
          description: "Override infill density as a percent, 0–100 (e.g. 20).",
        },
        fillPattern: {
          type: "string",
          description: "Override infill pattern, e.g. gyroid, rectilinear, grid, honeycomb.",
        },
        perimeters: { type: "integer", description: "Override wall count." },
        supportMaterial: { type: "boolean", description: "Override supports on/off." },
        brimWidthMm: { type: "number", description: "Override brim width; 0 for none." },
        nozzleDiameterMm: { type: "number", description: "e.g. 0.4" },
        copies: {
          type: "integer",
          description:
            "Print N auto-arranged copies of a single model on the plate (e.g. 4). Ignored for multi-part models.",
        },
        scale: {
          type: "number",
          description: "Uniform scale factor (1 = 100%, 0.5 = half size, 2 = double).",
        },
        rotateDeg: {
          type: "number",
          description: "Rotate the model around the Z axis by this many degrees.",
        },
        merge: {
          type: "boolean",
          description: "Merge multiple parts into one object after arranging.",
        },
        arrangeParts: {
          type: "boolean",
          description: "Auto-arrange multiple parts on the bed (default true). Set false to keep original positions.",
        },
        filamentColour: {
          type: "string",
          description:
            'Filament colour as hex, e.g. "#33aaff". PREVIEW-ONLY on a single-extruder printer — does not change the physical print.',
        },
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
      // Track every sliceable mesh part so a later slice can arrange them all
      // onto one plate. STEP parts are GUI-only, so exclude them from the
      // headless slice set (but they're still on disk).
      const parts = result.parts ?? [
        { localPath: result.localPath, ext: extLower(result.fileName) },
      ];
      sessionState.lastModelParts = parts
        .filter((p) => SLICEABLE_PART_EXTS.has(extLower(p.localPath)))
        .map((p) => p.localPath);
      if (sessionState.lastModelParts.length === 0) {
        // No directly-sliceable part (e.g. all STEP) — fall back to primary.
        sessionState.lastModelParts = [result.localPath];
      }
      if (model) {
        emit({ type: "download", model, result });
      }
      const count = result.parts?.length ?? 1;
      return (
        `Downloaded "${result.fileName}" (${formatBytes(result.sizeBytes)})` +
        (count > 1
          ? ` plus ${count - 1} more part(s) — ${count} parts total. They'll be arranged onto one plate when sliced.`
          : ".") +
        ` It is now the active model for inspect/slice.`
      );
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

    case "check_printer_setup": {
      const state = getProfileState();
      const printerList = Object.entries(KNOWN_PRINTERS)
        .map(([key, p]) => `  ${key}: ${p.label}`)
        .join("\n");
      if (sessionState.printerKey) {
        const p = KNOWN_PRINTERS[sessionState.printerKey];
        return `Printer already set this session: ${p?.label ?? sessionState.printerKey}. Good to slice.`;
      }
      if (state.userConfigIni) {
        return `The user has their own exported PrusaSlicer config (PRUSASLICER_CONFIG_INI) — slices will use it. No setup needed.`;
      }
      if (state.hasUsablePrinter) {
        return `The user has PrusaSlicer profiles configured${
          state.selectedPrinter ? ` (selected: "${state.selectedPrinter}")` : ""
        }. You can slice; results use PrusaSlicer's own defaults. If estimates seem off, offer to set their exact printer.`;
      }
      return (
        `The user has NO usable PrusaSlicer printer profile (never ran the setup wizard). ` +
        `Ask which printer they have, then call set_printer so slices are realistic. Known printers:\n` +
        printerList +
        `\nIf they don't know, use 'generic'.`
      );
    }

    case "set_printer": {
      const key = String(input.printerKey ?? "");
      if (!KNOWN_PRINTERS[key]) {
        return `Unknown printer "${key}". Valid keys: ${Object.keys(KNOWN_PRINTERS).join(", ")}.`;
      }
      sessionState.printerKey = key;
      // Invalidate any cached recommendation — nozzle/bed may have changed.
      sessionState.lastRecommendation = {};
      const p = KNOWN_PRINTERS[key];
      return `Printer set to ${p.label} (${p.bed.x}×${p.bed.y}×${p.bed.z} mm bed, ${p.nozzleMm} mm nozzle). Slices will now match this machine.`;
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
      const rec = recommendSettings(info, recommendInput(input));
      sessionState.lastRecommendation = rec.params;
      const a = rec.assumptions;
      return (
        `Recommended for a ${a.goal} ${a.material} print (${a.nozzleMm} mm nozzle):\n` +
        `  layer height: ${rec.params.layerHeightMm} mm\n` +
        `  infill: ${rec.params.fillDensityPct}% ${rec.params.fillPattern}\n` +
        `  walls: ${rec.params.perimeters}, solid top/bottom: ${rec.params.topSolidLayers}/${rec.params.bottomSolidLayers}\n` +
        `  supports: ${rec.params.supportMaterial ? `yes (${rec.params.supportThresholdDeg}° threshold)` : "no"}\n` +
        `  brim: ${rec.params.brimWidthMm} mm\n` +
        `Rationale:\n- ${rec.rationale.join("\n- ")}` +
        (rec.warnings.length
          ? `\nWarnings:\n- ${rec.warnings.join("\n- ")}`
          : "")
      );
    }

    case "slice_model": {
      const path = resolvePath(input.path);

      // Explicit per-setting overrides the user/agent passed on this call.
      const explicit: SliceParams = {
        ...numParam(input, "layerHeightMm"),
        ...numParam(input, "fillDensityPct"),
        ...numParam(input, "brimWidthMm"),
        ...numParam(input, "nozzleDiameterMm"),
        ...numParam(input, "perimeters"),
        ...numParam(input, "copies"),
        ...numParam(input, "scale"),
        ...numParam(input, "rotateDeg"),
        ...(typeof input.fillPattern === "string"
          ? { fillPattern: input.fillPattern }
          : {}),
        ...(typeof input.filamentColour === "string"
          ? { filamentColour: input.filamentColour }
          : {}),
        ...(typeof input.merge === "boolean" ? { merge: input.merge } : {}),
        ...(typeof input.arrangeParts === "boolean"
          ? { arrange: input.arrangeParts }
          : {}),
        ...(typeof input.supportMaterial === "boolean"
          ? { supportMaterial: input.supportMaterial }
          : {}),
      };
      const hasExplicit = Object.keys(explicit).length > 0;
      const reInput = recommendInput(input);
      if (reInput.material) sessionState.material = reInput.material;

      // The full set of distinct sliceable parts to print. When using the
      // active model, that's all its parts; otherwise just the given path.
      const usingActive = !input.path;
      const allParts =
        usingActive && sessionState.lastModelParts.length > 1
          ? sessionState.lastModelParts
          : [path];
      const isMultiPart = allParts.length > 1;

      // Build a goal/geometry-aware baseline. For a multi-part plate, aggregate
      // supports/brim across ALL parts so a tricky part isn't left unsupported.
      const infos: ModelInfo[] = [];
      for (const p of allParts) infos.push(await getModelInfo(p));
      emit({ type: "info", info: infos[0] });
      const rec = isMultiPart
        ? recommendForPlate(infos, reInput)
        : recommendSettings(infos[0], reInput);
      const baselineWarnings = rec.warnings;
      sessionState.lastRecommendation = rec.params;

      const params: SliceParams = { ...rec.params, ...explicit };

      // Config: user's own → synthesized (printer + material) → defaults.
      const resolved = resolveSliceConfig(
        sessionState.printerKey,
        sessionState.material,
      );
      // Usable bed area = printer bed minus a margin (defaults to MK-class).
      const bedDim = resolved.printer?.bed ?? { x: 250, y: 210, z: 210 };
      const bed = { w: bedDim.x, d: bedDim.y };

      // Slice — splitting across multiple plates when parts/copies overflow one bed.
      const stem = `${baseStem(allParts[0])}${isMultiPart ? "-plate" : ""}`;
      const job = await slicePlates(
        allParts,
        params,
        bed,
        resolved.configIni,
        stem,
      );

      // Emit one metrics panel per plate.
      for (const m of job.plates) emit({ type: "metrics", metrics: m });

      const plateCount = job.plates.length;
      const colourNote = params.filamentColour
        ? " Colour set for the preview only — it doesn't change a single-extruder print."
        : "";
      const configNote =
        resolved.source !== "user-config"
          ? " (Estimates use a generic profile — for best accuracy, export your PrusaSlicer config and set PRUSASLICER_CONFIG_INI.)"
          : "";
      const oversizedNote = job.oversized.length
        ? `\n⚠ ${job.oversized.length} part(s) are bigger than the bed and were skipped — scale them down or split them.`
        : "";
      const plateNote =
        plateCount > 1
          ? ` Split across ${plateCount} plates (they don't all fit one bed) — print them one after another.`
          : isMultiPart
            ? ` ${allParts.length} parts arranged on one plate.`
            : params.copies && params.copies > 1
              ? ` ${params.copies} copies auto-arranged.`
              : "";

      const usedLine =
        `Used settings: ${params.layerHeightMm ?? "default"} mm layers, ` +
        `${params.fillDensityPct ?? "default"}% ${params.fillPattern ?? ""} infill, ` +
        `${params.perimeters ?? "default"} walls, ` +
        `supports ${params.supportMaterial ? "on" : "off"}, ` +
        `brim ${params.brimWidthMm ?? 0} mm` +
        (hasExplicit ? " (your overrides applied)" : " (recommended)") +
        "." +
        plateNote +
        colourNote +
        (baselineWarnings.length ? `\nHeads up: ${baselineWarnings.join(" ")}` : "") +
        oversizedNote;

      // Summarize each plate's metrics.
      const plateLines = job.plates
        .map((m) => {
          const label =
            plateCount > 1 ? `Plate ${m.plateIndex}/${m.plateCount}: ` : "";
          return (
            `${label}` +
            (m.estimatedPrintTime ? `${m.estimatedPrintTime}` : "time n/a") +
            (m.filamentUsedG !== undefined ? `, ${m.filamentUsedG.toFixed(1)} g` : "") +
            (m.filamentCost !== undefined ? `, ${m.filamentCost.toFixed(2)} cost` : "") +
            (m.layerCount !== undefined ? `, ${m.layerCount} layers` : "")
          );
        })
        .join("\n");

      return `Sliced successfully.\n${usedLine}${configNote}\n${plateLines}`;
    }

    case "open_in_slicer": {
      // Open the whole plate (all parts) when using the active multi-part model.
      const usingActive = !input.path;
      const paths =
        usingActive && sessionState.lastModelParts.length > 1
          ? sessionState.lastModelParts
          : resolvePath(input.path);
      await openInGui(paths);
      const n = Array.isArray(paths) ? paths.length : 1;
      return n > 1
        ? `Opened ${n} parts as one arranged plate in PrusaSlicer — tweak and print from there.`
        : `Opened ${Array.isArray(paths) ? paths[0] : paths} in PrusaSlicer.`;
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
    case "check_printer_setup":
      return "Checking your printer setup…";
    case "set_printer":
      return "Configuring your printer…";
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
