// Tool definitions for the Slicely agent, plus the executor that runs each one
// against the providers / PrusaSlicer modules. The agent loop streams the
// structured results back to the UI in addition to feeding them to the model.
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  SliceMetrics,
  SliceParams,
  PrintGoal,
  PrintMaterial,
  ModelInfo,
} from "../../shared/types";
// The v1 tools use the SAME sourcing layer as find_models. They used to call a
// legacy registry whose Printables client was search-only, so import_model
// could only ever fetch Thingiverse — the agent would try, fail, and send the
// user off to a browser for a file Slicely could have downloaded.
import {
  searchModels as sourcingSearch,
  downloadModel as sourcingDownload,
} from "../sourcing";
import type { SourceId } from "../../shared/sourcing";
import {
  getStatus,
  getModelInfo,
  slicePlates,
  openModelInEditorSliced,
  openGcodeInGui,
  writeEffectiveConfig,
  recommendSettings,
  recommendForPlate,
  type RecommendInput,
  type PlateSliceResult,
} from "../prusaslicer";
import {
  getProfileState,
  resolveSliceConfig,
  KNOWN_PRINTERS,
} from "../profiles";
import { getPreferences, printerGeometry, updatePreferences } from "../settings";
import { sessionState } from "./state";
import { colourRequest, type ColourRequest } from "./colourRequest";
import { join } from "node:path";
import {
  V2_TOOLS,
  V2_TOOL_NAMES,
  executeV2Tool,
  v2ToolLabel,
} from "./tools-v2";

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

/** Build a RecommendInput from tool input, layering precedence so a returning
 *  user never re-states their setup:
 *    explicit call args  >  saved preferences  >  built-in defaults.
 *  Pulls the bed size + nozzle from the session's chosen printer (custom or
 *  catalog) so the bed-fit check and layer-height bounds match the real machine,
 *  and folds in saved goal / material / infill / supports / brim defaults. */
function recommendInput(input: Record<string, unknown>): RecommendInput {
  const prefs = getPreferences();
  const out: RecommendInput = {};

  // Goal: explicit arg, else saved default. (recommendSettings falls back to
  // "quality" when still unset.)
  if (typeof input.goal === "string" && (GOALS as string[]).includes(input.goal)) {
    out.goal = input.goal as PrintGoal;
  } else if (prefs.goal) {
    out.goal = prefs.goal;
  }

  // Material: explicit arg, else session (chat-chosen), else saved default.
  if (
    typeof input.material === "string" &&
    (MATERIALS as string[]).includes(input.material)
  ) {
    out.material = input.material as PrintMaterial;
  } else if (
    sessionState.material &&
    (MATERIALS as string[]).includes(sessionState.material)
  ) {
    out.material = sessionState.material as PrintMaterial;
  } else if (prefs.material) {
    out.material = prefs.material;
  }

  // Printer geometry: explicit nozzle wins, else the chosen printer's geometry
  // (custom typed bed/nozzle, or a known catalog entry).
  const customGeo = printerGeometry(sessionState.customPrinter);
  const known = sessionState.printerKey
    ? KNOWN_PRINTERS[sessionState.printerKey]
    : undefined;
  if (typeof input.nozzleMm === "number") out.nozzleMm = input.nozzleMm;
  else if (typeof input.nozzleDiameterMm === "number")
    out.nozzleMm = input.nozzleDiameterMm;
  else if (customGeo) out.nozzleMm = customGeo.nozzleMm;
  else if (known) out.nozzleMm = known.nozzleMm;
  if (customGeo) out.bed = customGeo.bed;
  else if (known) out.bed = known.bed;

  // Saved slice defaults (no per-call override exists for these in the schema,
  // so they're applied directly; the agent overrides via explicit support/brim
  // booleans/widths, handled in explicitParams).
  if (prefs.supports) out.supports = prefs.supports;
  if (prefs.supportStyle) out.supportStyle = prefs.supportStyle;
  if (prefs.brim) out.brim = prefs.brim;
  if (typeof prefs.brimWidthMm === "number") out.brimWidthMm = prefs.brimWidthMm;
  if (typeof prefs.fillDensityPct === "number")
    out.fillDensityPct = prefs.fillDensityPct;
  if (prefs.fillPattern) out.fillPattern = prefs.fillPattern;

  return out;
}

/** The custom (typed) printer geometry for the session, if one is saved — for
 *  passing to resolveSliceConfig so synthesized configs use the real bed/nozzle. */
function customGeometry():
  | { label?: string; bed: { x: number; y: number; z: number }; nozzleMm: number }
  | undefined {
  const geo = printerGeometry(sessionState.customPrinter);
  if (!geo) return undefined;
  return {
    label: sessionState.customPrinter?.label,
    bed: geo.bed,
    nozzleMm: geo.nozzleMm,
  };
}

/** Emit a structured side-channel event to the renderer. */
export type Emit = (event: AgentEvent) => void;

/** The input properties shared by slice_model and slice_and_open (they take the
 *  exact same settings/transforms — the only difference is whether the GUI is
 *  opened afterward). Defined once so the two tools can never drift apart. */
const SLICE_PROPERTIES: Record<string, unknown> = {
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
  supportMaterial: {
    type: "boolean",
    description:
      "Override supports on/off. By default Slicely enables PrusaSlicer's automatic overhang detection (supports added only where the real mesh needs them); set false to force them off.",
  },
  supportStyle: {
    type: "string",
    enum: ["grid", "organic", "snug"],
    description:
      "Support style when supports are generated: grid (classic), organic (tree — lighter, easier to remove; needs PrusaSlicer ≥ 2.6), or snug. Default grid.",
  },
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
    description:
      "Auto-arrange multiple parts on the bed (default true). Set false to keep original positions.",
  },
  filamentColour: {
    type: "string",
    description:
      'ONE filament colour as hex, e.g. "#33aaff". Use this only when the user names a SINGLE colour. It is ' +
      'written into the config and the plate project, so PrusaSlicer opens showing the part in that colour. ' +
      'For two or more colours use `colours` or `colourStops` — never collapse several colours into this one.',
  },
  colours: {
    type: "array",
    items: { type: "string" },
    description:
      'TWO OR MORE colours for a single model, stacked BOTTOM-FIRST, e.g. ["#000000", "#008080"] for a black ' +
      'base and a teal top. Slicely divides the model\'s height into equal bands and changes filament at each ' +
      'boundary. Use this whenever the user names more than one colour without saying where they change ' +
      '("make it teal and black") — passing just one of them is the wrong print. Works on EVERY printer: on a ' +
      'single-extruder machine the printer pauses so the user swaps the spool; on an AMS/MMU it swaps itself.',
  },
  colourStops: {
    type: "array",
    items: {
      type: "object",
      properties: {
        atZ: { type: "number", description: "Height in mm where this colour starts." },
        atLayer: { type: "integer", description: "First layer number printed in this colour." },
        atFraction: {
          type: "number",
          description: "Fraction of the model height (0-1) where this colour starts, e.g. 0.33.",
        },
        colourHex: { type: "string", description: 'e.g. "#000000".' },
      },
      required: ["colourHex"],
    },
    description:
      'Colour changes at heights the user actually NAMED, rather than at equal fractions: "black up to 5 mm" ' +
      '(atZ 0 black, atZ 5 the next colour), "change at layer 40" (atLayer), "the bottom third in black" ' +
      '(atFraction 0.33). Give exactly one of atZ / atLayer / atFraction per entry. A stop at the bed ' +
      '(atZ 0 / atLayer 1) is the colour the print STARTS in and needs no swap. Prefer this over `colours` ' +
      'whenever the user said WHERE the colour changes.',
  },
};

/** The v1 tool set: search/import, inspect, recommend, slice, and hand off
 *  to the PrusaSlicer GUI. Combined with V2_TOOLS into TOOLS below. */
const V1_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_models",
    description:
      "Search free, open-source 3D-printable model marketplaces for models matching a query. " +
      "Returns a list of models with titles, creators, licenses, and whether Slicely can download " +
      "them directly. Use this whenever the user wants to find or print something (e.g. 'a model car'). " +
      "Trust each result's `downloadable` flag rather than assuming by source: Printables, MyMiniFactory, " +
      "NIH 3D, Smithsonian, NASA and GitHub are all directly downloadable in-app alongside Thingiverse.",
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
          enum: [
            "all", "thingiverse", "printables", "myminifactory", "nih3d",
            "smithsonian", "nasa", "github", "makerworld",
          ],
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
      "inspected and sliced. Works for ANY result whose `downloadable` flag is true — Thingiverse, Printables, " +
      "MyMiniFactory, NIH 3D, Smithsonian, NASA and GitHub. Only fall back to open_in_browser when `downloadable` " +
      "is false. Returns the local file path.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "The result's own `source` value from the search results.",
        },
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
      "Use ONLY for results with `downloadable: false`, whose files really are gated at source. " +
      "If a result is downloadable, import it instead of sending the user off to fetch it themselves.",
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
            "A printer key from check_printer_setup (e.g. 'prusa-mk4', 'ender-3', 'bambu-256', 'bambu-h2d', 'generic').",
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
      properties: SLICE_PROPERTIES,
    },
  },
  {
    name: "slice_and_open",
    description:
      "Slice the active model headlessly for ACCURATE metrics (print time, filament, cost — shown once), THEN open " +
      "the FINISHED result in PrusaSlicer's G-code VIEWER (the toolpath preview / export view). Use this ONLY when " +
      "the user explicitly wants to SEE THE FINISHED RESULT — e.g. 'show me the finished product', 'show me the " +
      "finished slice', 'slice it and open it', 'open the export/g-code', 'let me see the toolpaths/preview'. Do " +
      "NOT use it for a plain 'open it' (that's open_in_slicer — the editable editor). Takes the SAME settings as " +
      "slice_model (goal, material, overrides, copies, scale, rotate, merge, colour). Honest note: this opens the " +
      "already-sliced G-code (the viewer is read-only — toolpaths + export, nothing to click); PrusaSlicer has no " +
      "API to auto-press the Slice button in the editor. For a multi-plate split, the finished G-code for plate 1 " +
      "opens; the rest are sliced too and openable from their panels.",
    input_schema: {
      type: "object",
      properties: SLICE_PROPERTIES,
    },
  },
  {
    name: "open_in_slicer",
    description:
      "Open a MODEL in the regular, EDITABLE PrusaSlicer editor with slicing settings ALREADY APPLIED. This is the " +
      "DEFAULT for 'open it' / 'open in PrusaSlicer' / 'let me tweak it myself' / 'slice it and open in the editor' " +
      "/ 'take over manually'. When PrusaSlicer is closed, Slicely also turns on its background-processing " +
      "preference, so the model auto-slices as it loads — the user just clicks the Preview tab to see the finished " +
      "toolpaths (no Slice click). If PrusaSlicer is already running, pre-slicing can't be set for that session, so " +
      "the user presses Slice (the result message explains this and how to get auto-slice). By default it reuses " +
      "the settings of the most recent slice (or recommends from the model's geometry). Pass any setting below to " +
      "open with that specific value. This keeps the model EDITABLE — for the read-only finished G-code viewer, " +
      "use slice_and_open.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the model. Omit to use the most recently imported model.",
        },
        layerHeightMm: { type: "number", description: "Layer height in mm (e.g. 0.2)." },
        fillDensityPct: { type: "number", description: "Infill density percent 0–100." },
        fillPattern: { type: "string", description: 'Infill pattern, e.g. "gyroid", "grid".' },
        perimeters: { type: "number", description: "Number of perimeter walls." },
        supportMaterial: { type: "boolean", description: "Enable/disable supports." },
        supportStyle: {
          type: "string",
          enum: ["grid", "organic", "snug"],
          description: "Support style: grid (classic), organic (tree), or snug.",
        },
        brimWidthMm: { type: "number", description: "Brim width in mm (0 = none)." },
        nozzleDiameterMm: { type: "number", description: "Nozzle diameter in mm (e.g. 0.4)." },
        // Declared here, not just on slice_model: "make it black and twice as
        // big, then open it" is one request. While these were missing, the
        // model had no way to express them on an open and they were silently
        // dropped — the plate opened at stock size in the default colour.
        filamentColour: SLICE_PROPERTIES.filamentColour,
        colours: SLICE_PROPERTIES.colours,
        colourStops: SLICE_PROPERTIES.colourStops,
        scale: SLICE_PROPERTIES.scale,
        rotateDeg: SLICE_PROPERTIES.rotateDeg,
      },
    },
  },
];

/**
 * Every tool the agent can call: the v1 slicing/inspection set plus the v2
 * sourcing, printer, and job tools.
 */
export const TOOLS: Anthropic.Tool[] = [...V1_TOOLS, ...V2_TOOLS];

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
      const source = input.source ? String(input.source) : "all";
      const limit = typeof input.limit === "number" ? input.limit : 8;
      const outcome = await sourcingSearch(query, {
        limit,
        sources: source === "all" ? undefined : [source as SourceId],
      });
      const models = outcome.results;
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

      const result = await sourcingDownload(source as SourceId, modelId, { fileId });
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
      // Say what the file already knows about its own colours. A user who
      // picked a multi-colour model picked it FOR the colours, and being asked
      // "what colour would you like?" about a model whose author already
      // answered is how those colours got thrown away.
      let colourNote = "";
      try {
        const { summariseModelColours } = await import("../jobs/colouredImport");
        const summary = await summariseModelColours(result.localPath);
        if (summary) {
          colourNote =
            ` ${summary.note} Slicely will use them as they are — say so if you want different colours.`;
        }
      } catch {
        // Never let a colour read cost the user their download.
      }
      return (
        `Downloaded "${result.fileName}" (${formatBytes(result.sizeBytes)})` +
        (count > 1
          ? ` plus ${count - 1} more part(s) — ${count} parts total. They'll be arranged onto one plate when sliced.`
          : ".") +
        ` It is now the active model for inspect/slice.` +
        colourNote
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
      const prefs = getPreferences();
      const printerList = Object.entries(KNOWN_PRINTERS)
        .map(([key, p]) => `  ${key}: ${p.label}`)
        .join("\n");
      // A saved printer (custom or catalog) means the user already told us once —
      // never re-ask. The session was seeded from it at startup.
      if (prefs.printer) {
        const label =
          prefs.printer.label ??
          KNOWN_PRINTERS[prefs.printer.key]?.label ??
          prefs.printer.key;
        return `Printer already saved (persists across sessions): ${label}. Good to slice — don't ask the user again.`;
      }
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
      sessionState.customPrinter = undefined;
      // Invalidate any cached recommendation — nozzle/bed may have changed.
      sessionState.lastRecommendation = {};
      // PERSIST the choice so the user is never asked again across sessions.
      const p = KNOWN_PRINTERS[key];
      updatePreferences({ printer: { key, label: p.label } });
      return `Printer set to ${p.label} (${p.bed.x}×${p.bed.y}×${p.bed.z} mm bed, ${p.nozzleMm} mm nozzle) and saved as your default — I won't ask again. Slices will now match this machine.`;
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
      const { summary } = await runSlice(input, emit);
      return summary;
    }

    case "slice_and_open": {
      // Slice headlessly for accurate metrics (shown once, per the renderer's
      // per-turn dedup), THEN open the prepared result in PrusaSlicer. This is
      // the honest "slice, then open to the export page" flow: PrusaSlicer has
      // no API to auto-press Slice and any action flag forces headless, so we
      // slice first and open the finished G-code — which lands the GUI straight
      // on the toolpath preview / export view with zero Slice clicks.
      const slice = await runSlice(input, emit);

      // STEP can't be sliced headlessly — runSlice already errors for it, so we
      // only reach here with a real sliced result. Open the first plate's G-code
      // into the preview. (A multi-plate split has one .gcode per plate; the GUI
      // shows one bed at a time, so we open plate 1 and tell the user the rest
      // are sliced and revealable.)
      const firstPlate = slice.job.plates[0];
      let openNote: string;
      if (firstPlate?.gcodePath) {
        try {
          await openGcodeInGui(firstPlate.gcodePath);
          openNote =
            slice.job.plates.length > 1
              ? ` Opened the finished plate 1 of ${slice.job.plates.length} in PrusaSlicer's G-code viewer — already sliced, no need to press Slice. The other plates are sliced too; open each from its panel to review them one at a time.`
              : ` Opened the finished slice in PrusaSlicer's G-code viewer — review the toolpaths and export the G-code, no Slice click needed.`;
        } catch (err) {
          openNote = ` (Couldn't open PrusaSlicer automatically: ${(err as Error).message})`;
        }
      } else {
        openNote = "";
      }

      return `${slice.summary}${openNote}`;
    }

    case "open_in_slicer": {
      // Prefer the planned PLATE PROJECT when there is one. It carries the
      // arrangement, the chosen orientations and the requested colours, so
      // PrusaSlicer opens showing what Slicely actually planned — opening the
      // source STLs instead shows an unarranged, uncoloured pile.
      const usingActive = !input.path;
      if (usingActive && sessionState.lastJobId) {
        const { getJob } = await import("../jobs");
        const job = await getJob(sessionState.lastJobId);
        const projects = (job?.plates ?? [])
          .map((pl) => pl.projectPath)
          .filter((x): x is string => Boolean(x));
        if (projects.length > 0) {
          await openModelInEditorSliced(projects[0], sessionState.lastConfigIni);
          // Slicely opened it on the machine running the server. For a browser
          // anywhere else that did nothing visible, so hand over the file too.
          emit({
            type: "action",
            label: "Open in PrusaSlicer",
            kind: "open-project",
            filePath: projects[0],
            hint: "Downloads the plate as a .3mf project — arranged, oriented and coloured as planned.",
          });
          return (
            `Opened plate 1 of "${job?.name ?? "the job"}" in PrusaSlicer — parts arranged, ` +
            `oriented and coloured as planned.` +
            (projects.length > 1
              ? ` This job has ${projects.length} plates; ask to open another by number.`
              : "")
          );
        }
      }
      const paths =
        usingActive && sessionState.lastModelParts.length > 1
          ? sessionState.lastModelParts
          : resolvePath(input.path);
      const primary = Array.isArray(paths) ? paths[0] : paths;

      // Determine the settings to open WITH, so the GUI matches a slice:
      //   • explicit overrides on this call always win;
      //   • else reuse the exact params of the most recent slice;
      //   • else recommend from the model's geometry (skip for non-sliceable
      //     STEP, which can't be inspected headlessly — open with base config).
      const explicit = explicitParams(input);
      const colour = colourRequest(input);
      if (colour.filamentColour) explicit.filamentColour = colour.filamentColour;
      let params: SliceParams;
      let baseConfig: string | undefined;
      if (sessionState.lastSliceParams && !Object.keys(explicit).length) {
        params = sessionState.lastSliceParams;
        baseConfig = sessionState.lastConfigIni;
      } else {
        baseConfig = resolveSliceConfig(
          sessionState.printerKey,
          sessionState.material,
          customGeometry(),
        ).configIni;
        if (SLICEABLE_PART_EXTS.has(extLower(primary))) {
          const rec = recommendSettings(
            await getModelInfo(primary),
            recommendInput(input),
          );
          params = { ...rec.params, ...explicit };
        } else {
          params = explicit;
        }
      }

      // Materialize the effective config, then hand PrusaSlicer a PROJECT that
      // carries it — not the loose models with the config on the command line.
      //
      // PrusaSlicer ships single_instance = 1. With the app already open, a
      // second launch does not start a second instance: the file paths are
      // passed to the running one and everything else on the command line,
      // `--load` included, is dropped. The models appeared and the settings did
      // not, so a plate opened ignoring the printer, the layer height and the
      // colour the user asked for. Settings inside the file survive that.
      const guiConfig = await writeEffectiveConfig(params, baseConfig);
      const { writeEditorProject } = await import("../jobs/editorProject");
      const { sessionSlicesDir } = await import("../session-context");
      const bed = resolveSliceConfig(
        sessionState.printerKey,
        sessionState.material,
        customGeometry(),
      ).printer?.bed ?? { x: 250, y: 210, z: 210 };
      // Resolve the colour changes against the real model, so the heights in
      // the project are the ones this model actually changes colour at rather
      // than fractions of a guess.
      const colourChanges = await resolveOpenColourChanges(colour, primary, params);
      const project = await writeEditorProject({
        paths: Array.isArray(paths) ? paths : [paths],
        bed,
        configIni: guiConfig,
        destPath: join(sessionSlicesDir(), "open-in-slicer.3mf"),
        scale: params.scale,
        rotateDeg: params.rotateDeg,
        colourChanges,
      }).catch(() => undefined);
      const opened = await openModelInEditorSliced(project ?? paths, guiConfig);
      if (project) {
        emit({
          type: "action",
          label: "Open in PrusaSlicer",
          kind: "open-project",
          filePath: project,
          hint: "Downloads the plate as a .3mf project, with your settings already in it.",
        });
      }

      const n = Array.isArray(paths) ? paths.length : 1;
      const applied = guiConfig ? " with your slicing settings applied" : "";
      // Honest guidance about the Preview/Slice step, based on what we could set.
      const previewNote = opened.preSliced
        ? " It'll slice in the background as it loads — click the Preview tab to see the finished toolpaths (no need to press Slice)."
        : opened.alreadyOpen
          ? " PrusaSlicer was already open, so press Slice to generate the toolpaths. (Tip: quit PrusaSlicer and ask me to open it again and I'll turn on auto-slice-on-load so you only click Preview.)"
          : opened.noConfig
            ? " Press Slice to generate the toolpaths (run PrusaSlicer's first-time setup once so I can enable auto-slicing on load)."
            : " Press Slice to generate the toolpaths.";
      const lead =
        n > 1
          ? `Opened ${n} parts as one arranged plate in PrusaSlicer${applied}.`
          : `Opened ${primary} in PrusaSlicer${applied}.`;
      const colourNote = colourChanges.length
        ? ` It changes filament at ${colourChanges
            .map((c) => `${c.atZ} mm (${c.colourHex.toUpperCase()})`)
            .join(", ")} — the changes are in the project, so you can see and move them in Preview.`
        : "";
      return lead + colourNote + previewNote;
    }

    default:
      // Not a v1 tool — hand it to the v2 executor (sourcing/printers/jobs).
      if (V2_TOOL_NAMES.has(name)) return executeV2Tool(name, input, emit);
      return `Error: unknown tool "${name}".`;
  }
}

/** Result of a slice run, shared by slice_model and slice_and_open. */
interface SliceRun {
  /** Human/model-facing summary string (identical to slice_model's output). */
  summary: string;
  /** The per-plate slice job (metrics + oversized parts). */
  job: PlateSliceResult;
  /** The exact effective params used (also stored in sessionState). */
  params: SliceParams;
  /** The config .ini resolved for this slice. */
  configIni?: string;
}

/**
 * Run a full slice: recommend a baseline from geometry + goal, apply explicit
 * overrides, resolve the printer config, split across plates as needed, emit the
 * info + per-plate metrics events, and build the summary string. Extracted from
 * the slice_model case so slice_and_open reuses the IDENTICAL slice (and the
 * exact params/config it produced) instead of re-resolving — keeping the GUI
 * hand-off consistent with what was sliced. Errors for STEP (can't slice a
 * non-mesh headlessly), matching the rest of the pipeline.
 */
/**
 * Slice several parts by planning them as a job.
 *
 * PrusaSlicer's CLI cannot slice a multi-part plate from a list of STLs: with
 * --merge it fails (exit -1), and without it every input is re-exported to the
 * same output so only the last survives. The job pipeline writes one 3MF
 * containing every object, and orients and packs them on the way.
 *
 * Shaped as a PlateSliceResult so the caller's reporting is unchanged.
 */
/**
 * Turn a colour request into the heights this particular model changes at.
 *
 * Resolved against the real model rather than a nominal height, because a
 * fraction of the wrong number is the wrong place: "the bottom third" of a
 * 12 mm part and of a 120 mm part are 4 mm and 40 mm apart. Returns nothing
 * when there is one colour, or when the model can't be measured — an open that
 * shows the model is better than one that fails over a swatch.
 */
async function resolveOpenColourChanges(
  colour: ColourRequest,
  path: string,
  params: SliceParams,
): Promise<Array<{ atZ: number; colourHex: string }>> {
  if (!colour.isMultiColour) return [];
  try {
    const info = await getModelInfo(path);
    const scale = params.scale && params.scale > 0 ? params.scale : 1;
    const height = info.sizeZ * scale;
    const { bandsToChanges, stopsToChanges } = await import("../jobs/colourchange");
    return colour.stops.length
      ? stopsToChanges(height, params.layerHeightMm ?? 0.2, colour.stops)
      : bandsToChanges(height, colour.bands);
  } catch {
    return [];
  }
}

/**
 * Split a model that already carries its own colours into coloured parts.
 *
 * A multi-colour download says which object is which filament. Slicing it as
 * one mesh throws that away and prints it in a single colour — the model
 * arrives coloured and comes out grey. Writing each object as its own part,
 * with the colour its author gave it, puts those colours back into the
 * ordinary pipeline.
 *
 * Returns an empty list for anything with nothing to split: an STL, a
 * single-colour 3MF, or a model painted inside one mesh (whose colours are
 * carried through as painting instead — see threemf.ts).
 */
async function expandImportedColours(
  path: string,
): Promise<Array<{ path: string; colourHex?: string }>> {
  try {
    const { expandColouredThreeMf } = await import("../jobs/colouredImport");
    const { sessionSlicesDir } = await import("../session-context");
    return await expandColouredThreeMf(path, sessionSlicesDir());
  } catch {
    // Colour is an enhancement to a slice. Failing to read it must never cost
    // the user the slice itself.
    return [];
  }
}

async function sliceViaJobPipeline(
  paths: string[],
  params: SliceParams,
  bed: { x: number; y: number; z: number },
  emit: Emit,
  colour?: ColourRequest,
  importedParts: Array<{ path: string; colourHex?: string }> = [],
): Promise<PlateSliceResult> {
  const { planJob, runJob } = await import("../jobs");
  const prefs = getPreferences();
  const colourOf = new Map(importedParts.map((p) => [p.path, p.colourHex]));
  const planned = await planJob(
    paths.map((path) => ({ path, copies: 1, colourHex: colourOf.get(path) })),
    {
      bed,
      maxHeightMm: bed.z,
      // Colour by height belongs to the JOB, not to a part: a filament swap
      // stops the whole printer, so it applies to everything on the plate.
      colourBands: colour?.bands.length ? colour.bands : undefined,
      colourStops: colour?.stops.length ? colour.stops : undefined,
      goal: prefs.goal ?? "quality",
      material: prefs.material ?? "PLA",
      params,
      name: baseStem(paths[0]),
      onProgress: (p) => {
        const where = p.partName ? ` ${p.partName}` : "";
        const counter = p.total > 1 && p.index > 0 ? ` (${p.index} of ${p.total})` : "";
        emit({ type: "tool_progress", tool: "slice_model", label: `Preparing${where}${counter}…` });
      },
    },
  );
  const ran = await runJob(planned.id, (ev) => emit({ type: "job_progress", event: ev }));
  return {
    plates: ran.plates
      .map((pl) => pl.metrics)
      .filter((m): m is SliceMetrics => Boolean(m)),
    oversized: (ran.oversized ?? []).map((p) => p.path),
  };
}

async function runSlice(
  input: Record<string, unknown>,
  emit: Emit,
): Promise<SliceRun> {
  const path = resolvePath(input.path);

  // Explicit per-setting overrides the user/agent passed on this call.
  const explicit = explicitParams(input);
  const hasExplicit = Object.keys(explicit).length > 0;
  // Everything the caller said about colour, in one shape. A request naming
  // more than one colour has to reach the machinery that can deliver more than
  // one colour; dropping the extra was the old behaviour and it is simply the
  // wrong print.
  const colour = colourRequest(input);
  if (colour.filamentColour) explicit.filamentColour = colour.filamentColour;
  const reInput = recommendInput(input);
  if (reInput.material) sessionState.material = reInput.material;

  // The full set of distinct sliceable parts to print. When using the active
  // model, that's all its parts; otherwise just the given path.
  const usingActive = !input.path;
  let allParts =
    usingActive && sessionState.lastModelParts.length > 1
      ? sessionState.lastModelParts
      : [path];

  // Guard: a STEP/STP file can't be sliced headlessly (it's GUI-import-only).
  // Steer the caller to open_in_slicer instead of failing deep in PrusaSlicer.
  if (!SLICEABLE_PART_EXTS.has(extLower(allParts[0]))) {
    throw new Error(
      `"${allParts[0]}" is a CAD file that can't be measured or sliced headlessly — open it in PrusaSlicer (open_in_slicer) to convert it first.`,
    );
  }

  // A downloaded model that already carries its own colours becomes one
  // coloured part per object, so the colours its author chose flow through
  // orientation, packing and plating like any other multi-part job. Skipped
  // when the caller asked for specific colours: they are overriding the file.
  let importedParts: Array<{ path: string; colourHex?: string }> = [];
  if (allParts.length === 1 && !colour.isMultiColour && !colour.filamentColour) {
    importedParts = await expandImportedColours(allParts[0]);
    if (importedParts.length > 1) allParts = importedParts.map((p) => p.path);
  }

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

  // Config: user's own → synthesized (printer + material) → defaults. Pass the
  // custom typed geometry when the saved printer isn't a catalog entry.
  const resolved = resolveSliceConfig(
    sessionState.printerKey,
    sessionState.material,
    customGeometry(),
  );
  // Remember exactly what we sliced, so open_in_slicer can open the GUI with
  // identical settings.
  sessionState.lastSliceParams = params;
  sessionState.lastConfigIni = resolved.configIni;
  // Usable bed area = printer bed minus a margin (defaults to MK-class).
  const bedDim = resolved.printer?.bed ?? { x: 250, y: 210, z: 210 };
  const bed = { w: bedDim.x, d: bedDim.y };

  // Slice. A multi-part plate goes through the JOB pipeline rather than
  // slicePlates: handing several STLs to PrusaSlicer's CLI fails outright
  // (exit -1) with --merge and silently keeps only the last part without it.
  // The job pipeline writes a 3MF holding every object, so the whole plate
  // slices together — and it also orients each part and packs the plates,
  // which is what the user wanted from "slice all of these" anyway.
  let job: PlateSliceResult;
  if (isMultiPart || colour.isMultiColour) {
    // A single part with several colours goes through the job pipeline too:
    // the filament swaps live there, and slicePlates has no way to express
    // them. Routing on part count alone is what left a two-colour request
    // with one colour and no explanation.
    job = await sliceViaJobPipeline(allParts, params, bedDim, emit, colour, importedParts);
  } else {
    const stem = baseStem(allParts[0]);
    job = await slicePlates(allParts, params, bed, resolved.configIni, stem);
  }

  // Emit one metrics panel per plate.
  for (const m of job.plates) emit({ type: "metrics", metrics: m });

  // Remember plate 1's G-code so a follow-up "send it to the printer"
  // needs no arguments.
  if (job.plates[0]?.gcodePath) {
    sessionState.lastGcodePath = job.plates[0].gcodePath;
  }

  const plateCount = job.plates.length;
  // The band/stop heights the swaps LANDED on are reported by the runner
  // through metrics.fixes (they are quantised to layer boundaries), so this
  // says what mechanism was used and leaves the numbers to that.
  const colourNote = colour.isMultiColour
    ? ` ${(colour.stops.length ? colour.stops.length : colour.bands.length)} colours, ` +
      `changed partway up the print: the printer pauses at each change so you load the ` +
      `next colour (an AMS/MMU swaps it for you). Starts in ${colour.filamentColour ?? "the loaded filament"}.`
    : params.filamentColour
      ? ` Set to ${params.filamentColour} — load that filament to print it.`
      : importedParts.length > 1
        ? ` Kept the model's own ${new Set(importedParts.map((p) => p.colourHex).filter(Boolean)).size} colours.`
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

  // Ground-truth support/brim outcome from the sliced G-code (not just what we
  // requested). With auto-detect, supports are REQUESTED with automatic
  // placement, but PrusaSlicer only actually generates them where overhangs
  // need them — so report what the toolpaths really contain.
  const anyGenSupports = job.plates.some((m) => m.supportsGenerated);
  const requestedSupports = !!params.supportMaterial;
  const supportNote = !requestedSupports
    ? "supports off"
    : anyGenSupports
      ? `supports added where the mesh needed them${
          params.supportStyle === "organic" ? " (organic/tree)" : ""
        }`
      : "supports enabled but none were needed (no overhangs detected)";
  const brimNote =
    (params.brimWidthMm ?? 0) > 0 ? `${params.brimWidthMm} mm brim` : "no brim";

  // Auto-fixes applied during slicing (e.g. clamped layer height, organic→grid).
  const allFixes = [...new Set(job.plates.flatMap((m) => m.fixes ?? []))];
  const fixesNote = allFixes.length
    ? `\n🔧 Auto-corrected to make it slice: ${allFixes.join(" ")}`
    : "";

  const usedLine =
    `Used settings: ${params.layerHeightMm ?? "default"} mm layers, ` +
    `${params.fillDensityPct ?? "default"}% ${params.fillPattern ?? ""} infill, ` +
    `${params.perimeters ?? "default"} walls, ` +
    `${supportNote}, ${brimNote}` +
    (hasExplicit ? " (your overrides applied)" : " (recommended)") +
    "." +
    plateNote +
    colourNote +
    fixesNote +
    (baselineWarnings.length ? `\nHeads up: ${baselineWarnings.join(" ")}` : "") +
    oversizedNote;

  // Summarize each plate's metrics.
  const plateLines = job.plates
    .map((m) => {
      const label = plateCount > 1 ? `Plate ${m.plateIndex}/${m.plateCount}: ` : "";
      return (
        `${label}` +
        (m.estimatedPrintTime ? `${m.estimatedPrintTime}` : "time n/a") +
        (m.filamentUsedG !== undefined ? `, ${m.filamentUsedG.toFixed(1)} g` : "") +
        (m.filamentCost !== undefined ? `, ${m.filamentCost.toFixed(2)} cost` : "") +
        (m.layerCount !== undefined ? `, ${m.layerCount} layers` : "")
      );
    })
    .join("\n");

  return {
    summary: `Sliced successfully.\n${usedLine}${configNote}\n${plateLines}`,
    job,
    params,
    configIni: resolved.configIni,
  };
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
    case "slice_and_open":
      return "Slicing, then opening PrusaSlicer…";
    case "open_in_slicer":
      return "Opening PrusaSlicer…";
    default:
      return v2ToolLabel(name, input);
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

/** Per-call setting/transform overrides the user or agent passed explicitly.
 *  Shared by slice_model and open_in_slicer so both build the same params. */
function explicitParams(input: Record<string, unknown>): SliceParams {
  return {
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
    ...(typeof input.supportStyle === "string" &&
    ["grid", "organic", "snug"].includes(input.supportStyle)
      ? { supportStyle: input.supportStyle }
      : {}),
  };
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
