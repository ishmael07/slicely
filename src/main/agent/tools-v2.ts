// ─────────────────────────────────────────────────────────────────────────────
// v2 agent tools: sourcing, printers, and multi-plate jobs.
//
// These are the tools that make Slicely autonomous end-to-end. v1's tools stop
// at "a .gcode exists on disk"; these let the model search every source at
// once, resolve an arbitrary link the user pasted, plan a 40-part job across
// plates and colours, and put the result on an actual printer.
//
// Kept out of tools.ts on purpose — that file is already ~950 lines, and this
// is a separable surface with its own dependencies.
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentEvent, PrintGoal, PrintMaterial } from "../../shared/types";
import type { SourceId } from "../../shared/sourcing";
import type { JobPart } from "../../shared/jobs";
import {
  searchModels as sourcingSearch,
  resolveUrl,
  downloadFromUrl,
  sourceAvailability,
} from "../sourcing";
import { withSliceProgress } from "../prusaslicer";
import {
  listPrinters,
  allStatuses,
  printerStatus,
  sendToPrinter,
  controlPrinter,
  discoverPrinters,
  isAutoStartArmed,
} from "../printers";
import {
  planJob,
  runJob,
  getJob,
  listJobs,
  chooseOrientation,
  splitModel,
} from "../jobs";
import { getPreferences, printerGeometry } from "../settings";
import type { ToolSpec } from "./provider";
import { sessionState } from "./state";
import { colourRequest } from "./colourRequest";
import { resolveInsideSessionWorkspace, workspaceRef } from "../session-context";
import { stripPaths, WireError } from "../../server/errors";

type Emit = (event: AgentEvent) => void;

/** Names handled by this module. Used by tools.ts to route dispatch. */
export const V2_TOOL_NAMES = new Set([
  "find_models",
  "resolve_link",
  "import_from_url",
  "list_sources",
  "list_printers",
  "send_to_printer",
  "control_printer",
  "discover_printers",
  "plan_job",
  "run_job",
  "job_status",
  "choose_orientation",
  "split_model",
]);

export const V2_TOOLS: ToolSpec[] = [
  // ── Sourcing ───────────────────────────────────────────────────────────────
  {
    name: "find_models",
    description:
      "Search EVERY source at once and return one ranked list, downloadable first. Prefer it over search_models. The result says which sources answered.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "THE USER'S OWN WORDS, two or three at most, with nothing added. Some sources require every word to match, so each extra word can drop the count to zero. If a search finds nothing useful, retry with FEWER words, never more.",
        },
        alternates: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 other wordings for the DISTINCTIVE part of the request, searched at the same time and pooled: sites match keywords, not meaning, so a \"buff pikachu\" may be titled \"swole pikachu\". Never reword a brand or proper name. Use when the request names a quality, not a specific thing.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Omit to search everything, which is usually right.",
        },
        downloadableOnly: {
          type: "boolean",
          description: "Only models Slicely can download in-app.",
        },
        limit: { type: "integer", description: "Default 12." },
      },
      required: ["query"],
    },
  },
  {
    name: "resolve_link",
    description:
      "Work out what a URL the user pasted actually holds — a model page, a direct mesh, a zip of parts, a repo of meshes. Use it the moment they share a link, then import_from_url.",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL the user pasted." } },
      required: ["url"],
    },
  },
  {
    name: "import_from_url",
    description:
      "Download a model straight from a URL into the workspace. Use after resolve_link, or at once when the URL is obviously a mesh file.",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "Direct or page URL to download from." } },
      required: ["url"],
    },
  },
  {
    name: "list_sources",
    description:
      "List which model sources work right now and what blocks the rest, with the setup link. Use when a search returns little, or the user asks where models come from.",
    schema: { type: "object", properties: {} },
  },

  // ── Printers ───────────────────────────────────────────────────────────────
  {
    name: "list_printers",
    description:
      "List connected printers with live state, progress, temperatures and the filament colours loaded in each AMS/MMU slot. Use before sending a print or picking colours.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "send_to_printer",
    description:
      "Upload a sliced .gcode to a printer and QUEUE it. It starts only if the user armed auto-start for that printer, which you cannot override — never say a print began unless the result says it did.",
    schema: {
      type: "object",
      properties: {
        printerId: { type: "string", description: "From list_printers. Omit for the active printer." },
        gcodePath: {
          type: "string",
          description: "Workspace path as a slice result gave it. Omit for the most recent slice.",
        },
        start: {
          type: "boolean",
          description: "Honoured only if the user armed auto-start for this printer.",
        },
      },
      required: [],
    },
  },
  {
    name: "control_printer",
    description:
      "Pause, resume or cancel the print running on a printer. Confirm before cancelling: it cannot be resumed, and the filament already laid down is wasted.",
    schema: {
      type: "object",
      properties: {
        printerId: { type: "string", description: "Omit for the active printer." },
        action: { type: "string", enum: ["pause", "resume", "cancel"] },
      },
      required: ["action"],
    },
  },
  {
    name: "discover_printers",
    description:
      "Scan the local network for printers (OctoPrint, Klipper/Moonraker, PrusaLink, Bambu). Use when the user wants to connect one and does not know its address.",
    schema: {
      type: "object",
      properties: { timeoutMs: { type: "integer", description: "Default 5000." } },
    },
  },

  // ── Jobs ───────────────────────────────────────────────────────────────────
  {
    name: "plan_job",
    description:
      "Plan a large multi-part print: orient each part, resolve requested colours against the filament actually loaded, group parts to minimise swaps, and pack them across as many plates as needed. Use it for more than one part, copies, more than one colour, or when the parts won't fit one bed. It does not slice — call run_job.",
    schema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          description: "Omit to use every mesh from the last import or upload.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace path as a tool result gave it." },
              copies: { type: "integer", description: "Default 1." },
              colourHex: { type: "string", description: "Requested colour as hex." },
            },
            required: ["path"],
          },
        },
        name: { type: "string" },
        goal: { type: "string", enum: ["draft", "quality", "functional"] },
        material: { type: "string", enum: ["PLA", "PETG", "ABS"] },
        autoOrient: {
          type: "boolean",
          description: "Default true. False leaves parts as modelled.",
        },
        // Spelled out rather than shared with slice_model's copy in tools.ts:
        // that module imports THIS one, so reaching back for a value at module
        // load would be a cycle that resolves to undefined.
        colourStops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              atZ: { type: "number" },
              atLayer: { type: "integer" },
              atFraction: { type: "number", description: "0-1 of height." },
              colourHex: { type: "string" },
            },
            required: ["colourHex"],
          },
          description:
            "Colour changes at heights the user named. Exactly one of atZ / atLayer / atFraction each; the stop at the bed is the starting colour. Prefer it over colourBands when they said WHERE.",
        },
        colourBands: {
          type: "array",
          items: { type: "string" },
          description:
            "Colours BOTTOM-FIRST to give ONE part several colours without painting it: equal bands, a filament swap at each boundary, so it works on any printer. A swap affects the whole plate, so prefer a plate with just that part. For different PARTS, set each part's colourHex.",
        },
        groupByColour: {
          type: "boolean",
          description:
            "TRUE puts each colour on its OWN plate, FALSE forces them onto one. Omit to decide from the printer: an AMS/MMU mixes colours on a plate, a single-extruder machine gets one colour each.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_job",
    description:
      "Slice every plate of a planned job in order, reporting per-plate metrics; one failed plate does not stop the rest. Call plan_job first. When it finishes, offer to send the plates to the printer.",
    schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "From plan_job. Omit for the most recent." } },
      required: [],
    },
  },
  {
    name: "job_status",
    description:
      "Report a job's state: per-plate status, metrics and totals. Use when the user asks how a big print is going.",
    schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "Omit for the most recent." } },
      required: [],
    },
  },
  {
    name: "split_model",
    description:
      "Split ONE file into its separate solid pieces, so each becomes an ordinary part that can take its own colour and orientation. Use it when a model looks like several pieces, or the user wants different colours on different areas. A single connected solid is reported unchanged — otherwise use colourBands, or hand it to PrusaSlicer for painting.",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace path as a tool result gave it. Omit for the active model.",
        },
        write: { type: "boolean", description: "Default true. False only counts the pieces." },
      },
      required: [],
    },
  },
  {
    name: "choose_orientation",
    description:
      "Work out the best print orientation for one part and explain why, comparing support area, bed contact and layer count. Use when a part looks support-heavy.",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace path as a tool result gave it. Omit for the active model.",
        },
        goal: { type: "string", enum: ["draft", "quality", "functional"] },
      },
      required: [],
    },
  },
];

/** Progress labels shown as chips in the UI while a v2 tool runs. */
export function v2ToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "find_models":
      return `Searching every source for "${String(input.query ?? "")}"…`;
    case "resolve_link":
      return "Resolving link…";
    case "import_from_url":
      return "Downloading…";
    case "list_sources":
      return "Checking model sources…";
    case "list_printers":
      return "Checking your printers…";
    case "send_to_printer":
      return "Sending to printer…";
    case "control_printer":
      return `${cap(String(input.action ?? "control"))}ing the print…`;
    case "discover_printers":
      return "Scanning your network…";
    case "plan_job":
      return "Planning the job…";
    case "run_job":
      return "Slicing every plate…";
    case "job_status":
      return "Checking job progress…";
    case "split_model":
      return "Looking for separate pieces…";
    case "choose_orientation":
      return "Working out the best orientation…";
    default:
      return `Running ${name}…`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Bed + nozzle of the user's saved printer, falling back to PrusaSlicer's
 *  generic bed when they haven't picked one. Job planning needs a concrete bed
 *  to pack against, so this never returns undefined. */
function activeGeometry(): {
  bed: { x: number; y: number; z: number };
  nozzleMm: number;
} {
  return (
    printerGeometry(getPreferences().printer) ?? {
      bed: { x: 250, y: 210, z: 210 },
      nozzleMm: 0.4,
    }
  );
}

/**
 * The one place a model-supplied path becomes a path this process will open
 * (Task D5). Lives here rather than in tools.ts because tools.ts already
 * imports this module — one guard, one message, no import cycle.
 *
 * Refuses anything outside the ambient session's workspace (see
 * `isInsideSessionWorkspace`): on a shared server that means another visitor's
 * session directory and the server's own disk; on the desktop it still means
 * the system, while leaving the user's own files alone. The message names no
 * path, so a refusal can't be used to map what is on disk.
 *
 * Returns the path with symlinks resolved — the exact path containment was
 * decided on. Handing back `resolve(p)` instead would leave the caller's open()
 * to do its own, second resolution, so the file that was checked and the file
 * that is read would only usually be the same one.
 */
export function assertWorkspacePath(p: string): string {
  const target = resolveInsideSessionWorkspace(p);
  if (target === undefined) {
    throw new WireError(
      400,
      "That file isn't in your workspace. Import or upload it first.",
      "not_in_workspace",
    );
  }
  return target;
}

function fmtMinutes(min: number | undefined): string {
  if (min === undefined) return "unknown";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Execute a v2 tool. Returns the string fed back to the model, and emits
 * structured UI events as a side effect.
 */
export async function executeV2Tool(
  name: string,
  input: Record<string, unknown>,
  emit: Emit,
): Promise<string> {
  switch (name) {
    // ── Sourcing ─────────────────────────────────────────────────────────────
    case "find_models": {
      const query = String(input.query ?? "").trim();
      if (!query) return "Error: empty query.";
      const geom = activeGeometry();
      const alternates = Array.isArray(input.alternates)
        ? (input.alternates as unknown[]).map(String).filter((a) => a.trim().length > 0)
        : undefined;
      const outcome = await sourcingSearch(query, {
        alternates,
        sources: Array.isArray(input.sources)
          ? (input.sources as SourceId[])
          : undefined,
        downloadableOnly: input.downloadableOnly === true,
        limit: typeof input.limit === "number" ? input.limit : 12,
        bed: geom.bed,
      });
      emit({ type: "search", outcome });

      const failed = outcome.sources.filter((s) => !s.ok);
      if (!outcome.results.length) {
        return (
          `No models found for "${query}".` +
          (failed.length
            ? ` Note: ${failed.map((f) => f.id).join(", ")} were unavailable.`
            : " Suggest different keywords.")
        );
      }
      const lines = outcome.results.map((m, i) => {
        const bits = [
          `${i + 1}. [${m.source}] id=${m.id} "${m.title}"`,
          m.creator ? `by ${m.creator}` : "",
          m.downloadable ? "DOWNLOADABLE in-app" : "browser only",
          m.license ? `license: ${m.license}` : "",
          m.printability ? `printability ${m.printability.score}/100` : "",
        ].filter(Boolean);
        return bits.join(" — ");
      });
      const note = failed.length
        ? `\n(Unavailable this time: ${failed.map((f) => `${f.id} (${f.error ?? "failed"})`).join(", ")})`
        : "";
      return `Found ${outcome.results.length} models across ${
        outcome.sources.filter((s) => s.ok).length
      } sources:\n${lines.join("\n")}${note}`;
    }

    case "resolve_link": {
      const url = String(input.url ?? "").trim();
      if (!url) return "Error: no URL given.";
      const resolution = await resolveUrl(url);
      emit({ type: "resolved", resolution });
      if (resolution.kind === "unsupported") {
        return `Could not use that link: ${stripPaths(resolution.message)}`;
      }
      const files = resolution.files
        .map((f) => `  • ${f.name}${f.sizeBytes ? ` (${Math.round(f.sizeBytes / 1024)} KB)` : ""}`)
        .join("\n");
      return (
        `Link resolved as ${resolution.kind}: ${stripPaths(resolution.message)}\n` +
        `${resolution.files.length} downloadable file(s):\n${files}\n` +
        `Call import_from_url with the same URL to download.`
      );
    }

    case "import_from_url": {
      const url = String(input.url ?? "").trim();
      if (!url) return "Error: no URL given.";
      const result = await downloadFromUrl(url);
      sessionState.lastModelPath = result.localPath;
      sessionState.lastModelParts = (result.parts ?? [
        { localPath: result.localPath },
      ]).map((p) => p.localPath);
      // The WORKSPACE path, never the absolute one. This sentence is the single
      // most-quoted tool result there is — the model repeats it to the user
      // verbatim — and it is also the string it hands to plan_job next, so the
      // form it speaks has to be the form every tool accepts. See workspaceRef.
      return (
        `Downloaded "${result.fileName}" (${Math.round(result.sizeBytes / 1024)} KB) to ${workspaceRef(
          result.localPath,
        )}.` +
        (result.parts && result.parts.length > 1
          ? ` It contains ${result.parts.length} parts — consider plan_job to lay them out.`
          : "")
      );
    }

    case "list_sources": {
      const avail = sourceAvailability();
      const usable = avail.filter((a) => a.searchable);
      const lines = avail.map((a) => {
        const caps = [
          a.searchable ? "search" : null,
          a.downloadable ? "download" : null,
        ]
          .filter(Boolean)
          .join(" + ");
        return `• ${a.label} — ${caps || "unavailable"}${
          a.blockedReason ? ` (${a.blockedReason}${a.setupUrl ? ` — ${a.setupUrl}` : ""})` : ""
        }`;
      });
      return `${usable.length} of ${avail.length} sources usable:\n${lines.join("\n")}`;
    }

    // ── Printers ─────────────────────────────────────────────────────────────
    case "list_printers": {
      const [printers, statuses] = await Promise.all([listPrinters(), allStatuses()]);
      emit({ type: "printers", printers, statuses });
      if (!printers.length) {
        return "No printers connected. Use discover_printers to scan the network, or tell the user to add one in settings (gear icon → Connected printers).";
      }
      const byId = new Map(statuses.map((s) => [s.id, s]));
      const lines = printers.map((p) => {
        const s = byId.get(p.id);
        const bits = [`• ${p.label} (id=${p.id}, ${p.transport}) — ${s?.state ?? "unknown"}`];
        if (s?.progressPct !== undefined) bits.push(`${Math.round(s.progressPct)}%`);
        if (s?.filaments?.length) {
          bits.push(
            `loaded: ${s.filaments
              .map((f) => `slot ${f.index + 1} ${f.colourHex ?? "?"}${f.material ? ` ${f.material}` : ""}`)
              .join(", ")}`,
          );
        }
        bits.push(isAutoStartArmed(p.id) ? "auto-start ARMED" : "auto-start off (uploads queue only)");
        return bits.join(" — ");
      });
      return `${printers.length} printer(s):\n${lines.join("\n")}`;
    }

    case "send_to_printer": {
      const printers = await listPrinters();
      if (!printers.length) {
        return "No printers connected, so there is nothing to send to. Offer discover_printers, or point the user at settings → Connected printers.";
      }
      const printerId = input.printerId ? String(input.printerId) : printers[0].id;
      const rawGcodePath = input.gcodePath
        ? String(input.gcodePath)
        : sessionState.lastGcodePath;
      if (!rawGcodePath) {
        return "No G-code available yet — slice something first (slice_model or run_job).";
      }
      // A printer upload is a file READ: whatever this names is about to be
      // shipped off the machine, so it has to be the session's own G-code.
      const gcodePath = assertWorkspacePath(rawGcodePath);
      const result = await sendToPrinter(printerId, gcodePath, {
        startImmediately: input.start === true,
      });
      emit({ type: "sent", printerId, result });
      // A driver failure quotes the file it was uploading; the model repeats
      // whatever this says straight to the user.
      const message = stripPaths(result.message);
      if (!result.ok) return `Send failed: ${message}`;
      return result.started
        ? `Printing on ${printers.find((p) => p.id === printerId)?.label}. ${message}`
        : `Uploaded and queued (NOT started): ${message} Tell the user to check the bed is clear, then start it from the printer — or arm auto-start in settings.`;
    }

    case "control_printer": {
      const printers = await listPrinters();
      const printerId = input.printerId ? String(input.printerId) : printers[0]?.id;
      if (!printerId) return "No printers connected.";
      const action = String(input.action ?? "") as "pause" | "resume" | "cancel";
      const result = await controlPrinter(printerId, action);
      const status = await printerStatus(printerId);
      emit({ type: "printers", printers, statuses: [status] });
      return result.ok ? stripPaths(result.message) : `Could not ${action}: ${stripPaths(result.message)}`;
    }

    case "discover_printers": {
      const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 5000;
      const found = await discoverPrinters(timeoutMs);
      if (!found.length) {
        return "No printers found on the local network. The user can add one manually in settings → Connected printers if they know its IP address.";
      }
      const lines = found.map(
        (d) =>
          `• ${d.label} — ${d.transport} at ${d.host}:${d.port}${d.model ? ` (${d.model})` : ""}${
            d.needs ? ` — needs: ${d.needs}` : ""
          }`,
      );
      return `Found ${found.length} printer(s):\n${lines.join(
        "\n",
      )}\nTell the user to add one in settings → Connected printers → Scan network.`;
    }

    // ── Jobs ─────────────────────────────────────────────────────────────────
    case "plan_job": {
      const rawParts = Array.isArray(input.parts) ? input.parts : null;
      const parts = rawParts
        ? (rawParts as Array<Record<string, unknown>>).map((p) => ({
            path: assertWorkspacePath(String(p.path)),
            copies: typeof p.copies === "number" ? p.copies : 1,
            colourHex: p.colourHex ? String(p.colourHex) : undefined,
          }))
        // A remembered path is still only a path. `lastModelParts` is written by
        // split_model, whose own source was checked — but a session survives a
        // re-import, a settings change and (in Electron) a mode flip, so the
        // remembered list is re-checked rather than grandfathered in.
        : sessionState.lastModelParts.map((path) => ({
            path: assertWorkspacePath(path),
            copies: 1,
          }));

      if (!parts.length) {
        return "No parts to plan. Import or upload a model first.";
      }

      const prefs = getPreferences();
      const geom = activeGeometry();
      // Colour resolution needs the filament actually loaded, so read the
      // active printer's AMS slots when there is one.
      const printers = await listPrinters();
      const slots = printers.length
        ? (await printerStatus(printers[0].id)).filaments
        : undefined;

      // --info takes a slice permit, so planning can queue behind a slice too.
      const job = await withSliceProgress(
        (label) => emit({ type: "tool_progress", tool: "plan_job", label }),
        () =>
          planJob(parts, {
            // Planning a detailed multi-part job takes many seconds. Without this
            // the UI shows a spinner that never changes, which reads as a hang.
            onProgress: (p) => {
              const where = p.partName ? ` ${p.partName}` : "";
              const counter = p.total > 1 && p.index > 0 ? ` (${p.index} of ${p.total})` : "";
              const verb =
                p.stage === "inspecting"
                  ? "Measuring"
                  : p.stage === "orienting"
                    ? "Finding the best orientation for"
                    : p.stage === "colouring"
                      ? "Matching colours to your filament for"
                      : "Packing plates for";
              emit({
                type: "tool_progress",
                tool: "plan_job",
                label: `${verb}${where || " the job"}${counter}…`,
              });
            },
            bed: geom.bed,
            maxHeightMm: geom.bed.z,
            autoOrient: input.autoOrient !== false,
            // Only forward an explicit choice; leaving it undefined lets the
            // planner pick based on how many filament slots the printer has.
            groupByColour:
              typeof input.groupByColour === "boolean" ? input.groupByColour : undefined,
            colourBands: Array.isArray(input.colourBands)
              ? (input.colourBands as unknown[]).map(String).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
              : undefined,
            colourStops: colourRequest(input).stops,
            goal: (input.goal as PrintGoal) ?? prefs.goal ?? "quality",
            slots,
            name: input.name ? String(input.name) : undefined,
            material: (input.material as PrintMaterial) ?? prefs.material ?? "PLA",
          }),
      );
      sessionState.lastJobId = job.id;
      emit({ type: "job", job });

      const plateLines = job.plates.map(
        (pl) =>
          `  Plate ${pl.index}: ${pl.parts.length} part(s)${
            pl.colours.length ? `, colour(s) ${pl.colours.join(", ")}` : ""
          }${pl.rationale ? ` — ${pl.rationale}` : ""}`,
      );
      const over = job.oversized?.length
        ? `\n⚠ ${job.oversized.length} part(s) too large for the bed — they need scaling down: ${job.oversized
            .map((p) => p.name)
            .join(", ")}`
        : "";
      return (
        `Planned job "${job.name}" (id=${job.id}): ${job.totals?.partCount ?? parts.length} parts across ` +
        `${job.plates.length} plate(s).\n${plateLines.join("\n")}\n` +
        (job.colourPlan?.warnings.length
          ? `Colour notes: ${job.colourPlan.warnings.join(" ")}\n`
          : "") +
        (job.notes.length ? `${job.notes.join(" ")}\n` : "") +
        over +
        `\nCall run_job to slice all plates.`
      );
    }

    case "run_job": {
      const jobId = input.jobId ? String(input.jobId) : sessionState.lastJobId;
      if (!jobId) return "No job to run — call plan_job first.";
      // Whose job is this? `getJob` reads THIS session's store, so an id
      // belonging to another visitor is simply absent — and the answer is the
      // same "no job with that id" a made-up id gets, which is the point: a
      // different answer would confirm the id exists somewhere on the server.
      // Checked before anything runs, so a foreign id never reaches the slicer.
      if (!(await getJob(jobId))) return `No job with id ${jobId}.`;
      // Plates can also sit in the slice queue behind another visitor's job;
      // withSliceProgress routes that wait to the same spinner.
      const job = await withSliceProgress(
        (label) => emit({ type: "tool_progress", tool: "run_job", label }),
        () =>
          runJob(jobId, (ev) => {
            emit({ type: "job_progress", event: ev });
            // Slicing a plate can take minutes; say which one is running.
            if (ev.type === "plate_start") {
              emit({
                type: "tool_progress",
                tool: "run_job",
                label: `Slicing plate ${ev.plateIndex}…`,
              });
            } else if (ev.type === "plate_done") {
              emit({
                type: "tool_progress",
                tool: "run_job",
                label: `Plate ${ev.plateIndex} done (${ev.metrics.estimatedPrintTime ?? "sliced"}) — continuing…`,
              });
            }
          }),
      );
      emit({ type: "job", job });

      const done = job.plates.filter((p) => p.status === "done" || p.status === "ready");
      const failed = job.plates.filter((p) => p.status === "failed");
      const lines = job.plates.map((pl) => {
        // A plate error is PrusaSlicer's own stderr, absolute paths and all.
        if (pl.status === "failed") return `  Plate ${pl.index}: FAILED — ${stripPaths(pl.error ?? "") || "unknown"}`;
        const m = pl.metrics;
        return `  Plate ${pl.index}: ${m?.estimatedPrintTime ?? "?"}${
          m?.filamentUsedG !== undefined ? `, ${m.filamentUsedG.toFixed(1)} g` : ""
        }`;
      });
      // Remember the first successful plate so send_to_printer has a default.
      const firstReady = done.find((p) => p.gcodePath);
      if (firstReady?.gcodePath) sessionState.lastGcodePath = firstReady.gcodePath;

      return (
        `Job "${job.name}" ${job.status}: ${done.length}/${job.plates.length} plates sliced` +
        (failed.length ? `, ${failed.length} failed` : "") +
        `.\n${lines.join("\n")}\n` +
        `Total: ${fmtMinutes(job.totals?.estimatedMinutes)}, ${
          job.totals?.filamentG?.toFixed(0) ?? "?"
        } g.` +
        (done.length ? " Offer to send the plates to the printer." : "")
      );
    }

    case "job_status": {
      const jobId = input.jobId ? String(input.jobId) : sessionState.lastJobId;
      if (!jobId) {
        // THIS session's jobs — `listJobs` reads the session's own store, so
        // the bare listing can no longer enumerate the whole server's queue
        // (which also handed the model other visitors' job ids to then ask
        // about by name).
        const all = await listJobs();
        if (!all.length) return "No jobs yet.";
        return `${all.length} job(s):\n${all
          .map((j) => `• ${j.name} (id=${j.id}) — ${j.status}, ${j.plates.length} plates`)
          .join("\n")}`;
      }
      // Same store, same consequence as run_job above: another session's id is
      // absent, so it gets the ordinary not-found answer and — crucially — no
      // `job` event, which the chat route would otherwise read as this session
      // taking ownership of it.
      const job = await getJob(jobId);
      if (!job) return `No job with id ${jobId}.`;
      emit({ type: "job", job });
      return `Job "${job.name}" — ${job.status}. Plates: ${job.plates
        .map((p) => `${p.index}:${p.status}`)
        .join(", ")}. Total ${fmtMinutes(job.totals?.estimatedMinutes)}.`;
    }

    case "split_model": {
      const raw = input.path ? String(input.path) : sessionState.lastModelPath;
      if (!raw) return "No model available — import or upload one first.";
      // Splitting WRITES the pieces next to the source, so an unchecked path
      // here is a write outside the workspace as well as a read.
      const path = assertWorkspacePath(raw);
      const result = await splitModel(path, input.write !== false);
      if (result.pieces <= 1) {
        return (
          `"${result.name}" is one connected solid — there is nothing to split. ` +
          `To give it more than one colour, either use plan_job with colourBands (a filament swap at a height, ` +
          `works on any printer), or open it in PrusaSlicer to paint specific areas.`
        );
      }
      sessionState.lastModelParts = result.paths;
      if (result.paths.length > 0) sessionState.lastModelPath = result.paths[0];
      // Name each piece the way plan_job takes it, so "give piece 3 a different
      // colour" is a call the model can actually make.
      const lines = result.sizes.slice(0, 12).map((s, i) => {
        const ref = result.paths[i] ? ` — ${workspaceRef(result.paths[i])}` : "";
        return `  ${i + 1}. ${s.x.toFixed(1)} x ${s.y.toFixed(1)} x ${s.z.toFixed(1)} mm${ref}`;
      });
      return (
        `"${result.name}" contains ${result.pieces} separate pieces:\n${lines.join("\n")}` +
        (result.sizes.length > 12 ? `\n  …and ${result.sizes.length - 12} more` : "") +
        (result.dropped > 0
          ? `\n(${result.dropped} tiny fragment(s) ignored as modelling artifacts.)`
          : "") +
        (result.written
          ? `\nEach is now a separate part, so they can be given different colours via plan_job.`
          : "")
      );
    }

    case "choose_orientation": {
      const raw = input.path ? String(input.path) : sessionState.lastModelPath;
      if (!raw) return "No model available — import or upload one first.";
      const path = assertWorkspacePath(raw);
      const prefs = getPreferences();
      const result = await chooseOrientation(path, {
        goal: (input.goal as PrintGoal) ?? prefs.goal ?? "quality",
      });
      emit({ type: "orientation", partPath: path, result });
      const b = result.best;
      if (result.keptAsImported) {
        return `The model is already in its best orientation. ${b.rationale.join(" ")}`;
      }
      return (
        `Best orientation: rotate X ${b.rotXDeg}°, Y ${b.rotYDeg}°, Z ${b.rotZDeg}°. ` +
        `${b.rationale.join(" ")} ` +
        `Overhang area ${b.overhangAreaMm2.toFixed(0)} mm², bed contact ${b.bedContactMm2.toFixed(
          0,
        )} mm², ${b.layerCount} layers.`
      );
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/** Re-exported so callers can build a JobPart without importing the contract. */
export type { JobPart };
