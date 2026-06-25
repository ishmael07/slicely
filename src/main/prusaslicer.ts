// PrusaSlicer CLI integration for macOS.
//
// Verified CLI facts (from PrusaSlicer master source, 2026-06-19):
//   • Binary: /Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer
//     (no -console on mac; passing ANY action flag runs headless — no GUI)
//   • `--info model.stl`  → stdout: size_x/y/z, volume, number_of_facets,
//        manifold, number_of_parts (note: "number_of_parts =  " has 2 spaces)
//   • Slice: `--export-gcode in.stl --output out.gcode [--load cfg.ini]`
//        overrides: --layer-height 0.2 --fill-density 20 (percent)
//                   --support-material / --no-support-material
//                   --brim-width 5 --nozzle-diameter 0.4
//   • Metrics are NOT on stdout — parse from .gcode comments:
//        "; estimated printing time (normal mode) = ..."
//        "; filament used [mm] = ..."   "; filament used [g] = ..."
//        "; total filament cost = ..."  ; layer count = count of ";LAYER_CHANGE"
//   • Version: first line of `--help` banner ("PrusaSlicer-<ver> ...")
//   • Open in GUI: `open -a PrusaSlicer model.stl`
//   • Running check: we track our OWN headless spawns and exclude them so a
//        slice-in-progress isn't mistaken for the user having the GUI open;
//        LaunchServices (`lsappinfo`) is the authoritative GUI-app signal.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  ModelInfo,
  SliceParams,
  SliceMetrics,
  SlicerStatus,
  PrintGoal,
  PrintMaterial,
} from "../shared/types";
import { packPlates, type PlatePart } from "./plates";
import { getConfig } from "./config";

const APP_NAME = "PrusaSlicer";
/** macOS LaunchServices bundle id for PrusaSlicer (used by lsappinfo). */
const BUNDLE_ID = "com.prusa3d.slic3r.gui";

/** PIDs of headless slicer processes WE spawned (--info / --export-gcode).
 *  Excluded from "is the user's GUI open?" checks so a slice in progress is
 *  never mistaken for the user having PrusaSlicer open. */
const ownPids = new Set<number>();

/** Cached version string — resolving it spawns the binary, so do it once. */
let cachedVersion: string | undefined;
let versionResolved = false;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a process, capture stdout/stderr, resolve on exit (never rejects).
 *  When `track` is set, the child's PID is recorded as one of our own
 *  headless slicer processes for the duration of the run. */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
  track = false,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { windowsHide: true });

    if (track && typeof child.pid === "number") {
      ownPids.add(child.pid);
    }

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (track && typeof child.pid === "number") ownPids.delete(child.pid);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      finish({ code: -1, stdout, stderr: stderr + "\n" + err.message }),
    );
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

function binaryPath(): string {
  return getConfig().prusaSlicerPath;
}

/** Resolve install + running state + version. Cheap enough to poll on a timer:
 *  install is a stat, running is a fast `pgrep`/`lsappinfo`, version is cached. */
export async function getStatus(): Promise<SlicerStatus> {
  const bin = binaryPath();
  const installed = existsSync(bin);
  const running = installed ? await isGuiRunning() : false;
  const version = installed ? await getVersion(bin) : undefined;

  return { installed, running, binaryPath: bin, version, appName: APP_NAME };
}

/** True only when the user has the PrusaSlicer GUI open — NOT when we're
 *  running a headless slice. Combines two signals:
 *    1. PrusaSlicer process PIDs minus the ones we spawned ourselves.
 *    2. LaunchServices' list of GUI apps (only consulted when we're not
 *       mid-slice, so our own invocation can't false-positive it). */
async function isGuiRunning(): Promise<boolean> {
  const pids = await pgrepPids(APP_NAME);
  const external = pids.filter((p) => !ownPids.has(p));
  if (external.length > 0) return true;

  // No external process match. If we're not slicing, double-check LaunchServices
  // (covers any case where the process name doesn't match `pgrep -x`).
  if (ownPids.size === 0) return await lsappinfoRunning();
  return false;
}

function pgrepPids(name: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", name], { timeout: 4000 }, (err, stdout) => {
      // pgrep exits 1 with no match; that's "not running", not an error.
      if (err || !stdout.trim()) return resolve([]);
      resolve(
        stdout
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => Number.isFinite(n)),
      );
    });
  });
}

/** Ask LaunchServices whether a PrusaSlicer GUI app is registered as running.
 *  `lsappinfo` only knows about real application instances, so a bare CLI
 *  invocation of the binary does not show up here. Returns false on any error. */
function lsappinfoRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("lsappinfo", ["list"], { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(
        new RegExp(`${APP_NAME}|${BUNDLE_ID.replace(/\./g, "\\.")}`, "i").test(
          stdout,
        ),
      );
    });
  });
}

async function getVersion(bin: string): Promise<string | undefined> {
  if (versionResolved) return cachedVersion;
  const { stdout, stderr } = await run(bin, ["--help"], 15_000, true);
  const banner = (stdout + stderr).split("\n", 1)[0] ?? "";
  // First line looks like: "PrusaSlicer-2.9.0+... based on Slic3r ..."
  const m = banner.match(/PrusaSlicer-([^\s]+)/i);
  cachedVersion = m ? m[1] : undefined;
  versionResolved = true;
  return cachedVersion;
}

function assertInstalled(): string {
  const bin = binaryPath();
  if (!existsSync(bin)) {
    throw new Error(
      `PrusaSlicer not found at "${bin}". Install it from prusa3d.com, or set PRUSASLICER_PATH in your .env.`,
    );
  }
  return bin;
}

/** Run `--info` and parse the mesh stats for a single STL. */
export async function getModelInfo(stlPath: string): Promise<ModelInfo> {
  const bin = assertInstalled();
  if (!existsSync(stlPath)) {
    throw new Error(`Model file not found: ${stlPath}`);
  }
  const { code, stdout, stderr } = await run(
    bin,
    ["--info", stlPath],
    60_000,
    true, // our own spawn — exclude from GUI-running detection
  );
  if (code !== 0 && !stdout.includes("size_x")) {
    throw new Error(
      `PrusaSlicer --info failed: ${stderr.trim() || stdout.trim() || "unknown error"}`,
    );
  }
  return parseInfo(stdout, stlPath);
}

function parseInfo(out: string, filePath: string): ModelInfo {
  const num = (key: string): number | undefined => {
    // values are std::fixed doubles, 6 dp; key may have extra spaces.
    const re = new RegExp(`${key}\\s*=\\s*([-0-9.]+)`);
    const m = out.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const manifoldMatch = out.match(/manifold\s*=\s*(yes|no)/i);

  return {
    filePath,
    sizeX: num("size_x") ?? 0,
    sizeY: num("size_y") ?? 0,
    sizeZ: num("size_z") ?? 0,
    volumeMm3: num("volume"),
    facets: num("number_of_facets"),
    manifold: manifoldMatch ? manifoldMatch[1].toLowerCase() === "yes" : undefined,
    parts: num("number_of_parts"),
  };
}

/** Slice an STL to G-code with the given params, then parse metrics.
 *  `configIni` overrides the .env config for this slice (e.g. a synthesized
 *  per-printer config from the profiles module). `outName` overrides the
 *  output filename stem (used to keep per-plate gcode files distinct). */
export async function slice(
  stlPath: string,
  params: SliceParams = {},
  configIni?: string,
  outName?: string,
): Promise<SliceMetrics> {
  const bin = assertInstalled();
  if (!existsSync(stlPath)) {
    throw new Error(`Model file not found: ${stlPath}`);
  }

  const cfg = getConfig();

  // Build the full input list: the primary mesh plus any extra parts to place
  // on the same plate. Filter to files that actually exist.
  const inputs = [stlPath, ...(params.extraInputs ?? [])].filter((p) =>
    existsSync(p),
  );
  const multi = inputs.length > 1;
  const base = basename(stlPath, extname(stlPath));
  // Name multi-part output as a "-plate" so it doesn't collide with single slices.
  const stem = outName ?? `${base}${multi ? "-plate" : ""}`;
  const gcodePath = join(cfg.slicesDir, `${stem}.gcode`);

  const args: string[] = ["--export-gcode", ...inputs, "--output", gcodePath];

  // Load a printer/filament config. CLI overrides below take precedence over
  // --load values (priority: overrides > --load > 3mf-embedded > compiled
  // defaults). A bare slice with no --load still succeeds against built-in
  // FFF defaults. Prefer an explicit per-slice config, else the .env one.
  const loadIni =
    configIni && existsSync(configIni)
      ? configIni
      : cfg.prusaConfigIni && existsSync(cfg.prusaConfigIni)
        ? cfg.prusaConfigIni
        : undefined;
  if (loadIni) {
    args.push("--load", loadIni);
  }

  // ── CLI setting overrides ─────────────────────────────────────────────────
  // Shared with the GUI-open path (writeEffectiveConfig) so the GUI session
  // and a headless slice are built from IDENTICAL settings.
  args.push(...settingArgs(params));

  // ── Plate / multi-part / transforms ───────────────────────────────────────
  // Multiple inputs auto-arrange by default; only disable when asked.
  if (multi && params.arrange === false) {
    args.push("--dont-arrange");
  }
  if (params.merge) {
    args.push("--merge");
  }
  // --duplicate makes N auto-arranged copies of a SINGLE model; meaningless and
  // contradictory alongside multiple distinct inputs, so guard on !multi.
  if (!multi && typeof params.copies === "number" && params.copies > 1) {
    args.push("--duplicate", String(Math.round(params.copies)));
  }
  if (typeof params.scale === "number" && params.scale > 0 && params.scale !== 1) {
    args.push("--scale", String(params.scale));
  }
  if (typeof params.rotateDeg === "number" && params.rotateDeg !== 0) {
    args.push("--rotate", String(params.rotateDeg));
  }
  // Filament colour: preview-only on a single-extruder FDM print. We still pass
  // it so the GUI/preview matches; the agent/UI tells the user it won't change
  // the physical print. Normalize to #RRGGBB.
  const colour = normalizeHexColour(params.filamentColour);
  if (colour) {
    args.push("--filament-colour", colour);
  }

  const { code, stdout, stderr } = await run(bin, args, 300_000, true);

  if (!existsSync(gcodePath)) {
    // PrusaSlicer prints this exact message and writes NO g-code when every
    // object ended up outside the (single) bed — i.e. the plate was over-packed
    // and the CLI dropped the off-bed parts. Surface that as an actionable error
    // rather than a generic "slicing failed". (Verified vs PrusaSlicer source,
    // ProcessActions.cpp: "Nothing to print … no object is fully inside the
    // print volume".)
    const out = `${stdout}\n${stderr}`;
    if (/nothing to print|no object is fully inside the print volume/i.test(out)) {
      throw new Error(
        "Nothing landed on the bed — the plate is over-packed or a part sits outside the print volume. Reduce copies, scale parts down, or split across more plates.",
      );
    }
    const reason =
      stderr.trim() ||
      stdout.trim() ||
      `exit ${code}. The print may be empty or outside the print volume.`;
    throw new Error(`Slicing failed: ${reason}`);
  }

  return parseMetrics(gcodePath);
}

/**
 * Read the inter-object arrange gap PrusaSlicer will actually use for a given
 * config, so Slicely's plate packer matches the slicer's real arrange and never
 * groups parts the slicer would drop. Mirrors PrusaSlicer's min_object_distance:
 *   gap = complete_objects ? max(duplicate_distance, extruder_clearance_radius)
 *                          : duplicate_distance        (default 6 mm)
 * Falls back to 6 mm / non-sequential when the config doesn't pin these (e.g.
 * Slicely's synthesized configs), which is exactly PrusaSlicer's own default.
 */
export async function readArrangeSpacing(
  configIni?: string,
): Promise<{ spacing: number; sequential: boolean }> {
  const fallback = { spacing: 6, sequential: false };
  if (!configIni || !existsSync(configIni)) return fallback;
  const text = await readFile(configIni, "utf8").catch(() => "");
  if (!text) return fallback;

  const readNum = (key: string): number | undefined => {
    // Flat .ini "key = value" (these keys are plain mm, no % suffix).
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*([0-9.]+)`, "mi"));
    return m ? Number(m[1]) : undefined;
  };
  const readBool = (key: string): boolean => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\w+)`, "mi"));
    if (!m) return false;
    const v = m[1].toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  };

  const duplicateDistance = readNum("duplicate_distance") ?? 6;
  const sequential = readBool("complete_objects");
  const clearance = readNum("extruder_clearance_radius") ?? 0;
  const spacing = sequential
    ? Math.max(duplicateDistance, clearance)
    : duplicateDistance;
  // Guard against a pathological 0 gap (parts touching) — keep a small minimum.
  return { spacing: spacing > 0 ? spacing : 6, sequential };
}

/** Build the `--<setting>` CLI args for the print settings in `params`.
 *  These are the values PrusaSlicer treats as CONFIG (so they round-trip
 *  through --save/--load), as opposed to per-import transforms like scale or
 *  rotate. Used by both the headless slice and the GUI-open path so the two
 *  can never drift apart. */
function settingArgs(params: SliceParams): string[] {
  const args: string[] = [];

  // Plain-mm value, no multiplier.
  if (typeof params.layerHeightMm === "number") {
    args.push("--layer-height", String(params.layerHeightMm));
  }

  // CRITICAL: fill_density MUST carry a "%". PrusaSlicer's legacy-config
  // migration multiplies a bare number by 100 (a 0–1 fraction shim), so
  // "--fill-density 20" silently becomes 2000% (garbage infill / validation
  // error). "--fill-density 20%" skips that conversion. Verified in
  // PrintConfig.cpp handle_legacy across PrusaSlicer 2.7.4–master.
  if (typeof params.fillDensityPct === "number") {
    const pct = clamp(Math.round(params.fillDensityPct), 0, 100);
    args.push("--fill-density", `${pct}%`);
  }

  if (params.fillPattern) {
    args.push("--fill-pattern", params.fillPattern);
  }
  if (typeof params.perimeters === "number") {
    args.push("--perimeters", String(Math.max(1, Math.round(params.perimeters))));
  }
  if (typeof params.topSolidLayers === "number") {
    args.push("--top-solid-layers", String(Math.max(0, Math.round(params.topSolidLayers))));
  }
  if (typeof params.bottomSolidLayers === "number") {
    args.push(
      "--bottom-solid-layers",
      String(Math.max(0, Math.round(params.bottomSolidLayers))),
    );
  }

  // support_material is a boolean flag — never pass a value. Always emit the
  // explicit form so a loaded profile's default can't silently flip it.
  if (typeof params.supportMaterial === "boolean") {
    args.push(params.supportMaterial ? "--support-material" : "--no-support-material");
    if (params.supportMaterial && typeof params.supportThresholdDeg === "number") {
      // 90 = vertical only, lower = fewer supports, 0 = full auto.
      args.push(
        "--support-material-threshold",
        String(clamp(Math.round(params.supportThresholdDeg), 0, 90)),
      );
    }
  }

  if (typeof params.brimWidthMm === "number") {
    args.push("--brim-width", String(params.brimWidthMm));
  }
  if (typeof params.nozzleDiameterMm === "number") {
    args.push("--nozzle-diameter", String(params.nozzleDiameterMm));
  }

  return args;
}

/**
 * Materialize the FULL effective print config (base config + the given setting
 * overrides) to an .ini using PrusaSlicer's `--save`. The GUI can then `--load`
 * it so opening a model reflects the EXACT settings a headless slice would use.
 *
 * `--export-3mf` deliberately is NOT used here: verified on PrusaSlicer 2.9, the
 * CLI 3MF export writes only model geometry/arrangement, never the print config
 * — so a config .ini loaded at GUI launch is the reliable path to consistency.
 *
 * Returns the written path, or undefined if the config couldn't be produced
 * (callers fall back to opening the bare model).
 */
export async function writeEffectiveConfig(
  params: SliceParams = {},
  baseConfigIni?: string,
): Promise<string | undefined> {
  const bin = assertInstalled();
  const cfg = getConfig();
  const base =
    baseConfigIni && existsSync(baseConfigIni)
      ? baseConfigIni
      : cfg.prusaConfigIni && existsSync(cfg.prusaConfigIni)
        ? cfg.prusaConfigIni
        : undefined;

  const outPath = join(cfg.slicesDir, "_gui-settings.ini");
  const args: string[] = [];
  if (base) args.push("--load", base);
  args.push(...settingArgs(params), "--save", outPath);

  await run(bin, args, 60_000, true);
  return existsSync(outPath) ? outPath : undefined;
}

/** Result of a (possibly multi-plate) slice job. */
export interface PlateSliceResult {
  /** One metrics entry per plate, in order. */
  plates: SliceMetrics[];
  /** Parts too big to fit the bed even alone — reported, not sliced. */
  oversized: string[];
}

/**
 * Slice one or more parts, splitting across MULTIPLE PLATES when they don't all
 * fit on one bed. Each plate is sliced separately (PrusaSlicer's CLI arranges
 * only one plate at a time) and returns its own metrics.
 *
 * - `paths`: the distinct mesh parts to print (>=1).
 * - `params.copies`: when there's a single part, this many copies are packed
 *   across plates (each plate slices its share via --duplicate).
 * - `bed`: usable build area in mm; defaults to the recommendation's bed.
 */
export async function slicePlates(
  paths: string[],
  params: SliceParams,
  bed: { w: number; d: number },
  configIni?: string,
  baseName = "plate",
): Promise<PlateSliceResult> {
  // Measure each distinct part's footprint (largest two bounding-box dims).
  const distinct = paths.filter((p) => existsSync(p));
  if (distinct.length === 0) throw new Error("No valid parts to slice.");

  // Expand copies of a single part into repeated placements for packing.
  const copies =
    distinct.length === 1 && params.copies && params.copies > 1
      ? Math.round(params.copies)
      : 1;

  // Footprints must reflect the SAME transforms the slice will apply, or the
  // packer plans for one size while PrusaSlicer arranges another and parts spill
  // off-bed (silently dropped). --scale multiplies both XY dims; --rotate spins
  // each object about Z, so its axis-aligned footprint grows to the rotated
  // bounding box. We bake both into the footprint used for packing/oversize.
  const scaleFactor =
    typeof params.scale === "number" && params.scale > 0 ? params.scale : 1;
  const rotRad = (((params.rotateDeg ?? 0) % 360) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotRad));
  const sin = Math.abs(Math.sin(rotRad));

  const partFootprints = new Map<string, { w: number; d: number }>();
  for (const p of distinct) {
    const info = await getModelInfo(p);
    // Scaled XY extent, then its rotated axis-aligned bounding box. (PrusaSlicer
    // arranges by convex hull; this AABB is never smaller, so packing stays
    // conservative — it never claims a fit the slicer can't achieve.)
    const sx = info.sizeX * scaleFactor;
    const sy = info.sizeY * scaleFactor;
    partFootprints.set(p, {
      w: sx * cos + sy * sin,
      d: sx * sin + sy * cos,
    });
  }

  const toPack: PlatePart[] = [];
  for (const p of distinct) {
    const fp = partFootprints.get(p)!;
    for (let i = 0; i < copies; i++) {
      toPack.push({ path: p, w: fp.w, d: fp.d });
    }
  }

  // Pack with the SAME object gap PrusaSlicer will use, so a plate we accept is
  // one the slicer can arrange without pushing a part off-bed (and dropping it).
  const { spacing } = await readArrangeSpacing(configIni);
  const { plates, oversized } = packPlates(toPack, bed, spacing);

  // If everything fits on one plate, slice it as a single plate (fast path).
  const plateMetrics: SliceMetrics[] = [];
  for (let i = 0; i < plates.length; i++) {
    const group = plates[i].parts;
    const primary = group[0].path;
    // Distinct extra parts on this plate (dedupe paths; copies become --duplicate).
    const onPlate = group.map((g) => g.path);
    const uniqueOnPlate = [...new Set(onPlate)];
    const extraInputs = uniqueOnPlate.filter((p) => p !== primary);

    // If this plate is N copies of ONE part, use --duplicate N; else multi-input.
    const singlePartCopies =
      uniqueOnPlate.length === 1 ? onPlate.length : undefined;

    // CRITICAL: distinct parts on one plate MUST be merged. PrusaSlicer's CLI
    // loads each input file as its OWN Model and slices them in a loop that
    // re-exports to the SAME --output, so WITHOUT --merge a multi-input plate
    // produces g-code for only the LAST part (the rest are overwritten). --merge
    // combines all inputs into ONE model so the whole plate slices together; it
    // arranges them on the bed too, unless --dont-arrange is also set (which the
    // existing arrange===false path adds, keeping the parts' original
    // coordinates while still combining them). Either way every part survives.
    // (Verified vs PrusaSlicer source version_2.9.5: LoadPrintData.cpp
    // models.push_back per file; ProcessActions.cpp `for (Model& model :
    // models)`; ProcessTransform.cpp --merge combines, arranges iff !dont_arrange.)
    const mergeDistinct = extraInputs.length > 0 ? true : params.merge;

    const platePart: SliceParams = {
      ...params,
      extraInputs,
      merge: mergeDistinct,
      copies: singlePartCopies && singlePartCopies > 1 ? singlePartCopies : undefined,
    };
    const outName = plates.length > 1 ? `${baseName}-${i + 1}of${plates.length}` : baseName;
    const m = await slice(primary, platePart, configIni, outName);
    m.plateIndex = i + 1;
    m.plateCount = plates.length;
    m.partsOnPlate = group.length;
    plateMetrics.push(m);
  }

  return { plates: plateMetrics, oversized: oversized.map((o) => o.path) };
}

/** Read the metric comments out of a sliced .gcode file. */
export async function parseMetrics(gcodePath: string): Promise<SliceMetrics> {
  // G-code summary comments live near the end of the file; read it whole
  // (PrusaSlicer files are ASCII when binary_gcode is disabled).
  const text = await readFile(gcodePath, "utf8").catch(() => "");

  const first = (re: RegExp): string | undefined => {
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  const firstNum = (re: RegExp): number | undefined => {
    const s = first(re);
    return s !== undefined ? Number(s) : undefined;
  };

  const layerCount = (text.match(/;LAYER_CHANGE/g) || []).length || undefined;

  return {
    gcodePath,
    estimatedPrintTime: first(
      /; estimated printing time \(normal mode\) = (.+)/,
    ),
    filamentUsedMm: firstNum(/; filament used \[mm\] = ([\d.]+)/),
    filamentUsedG:
      firstNum(/; total filament used \[g\] = ([\d.]+)/) ??
      firstNum(/; filament used \[g\] = ([\d.]+)/),
    filamentCost:
      firstNum(/; total filament cost = ([\d.]+)/) ??
      firstNum(/; filament cost = ([\d.]+)/),
    layerCount,
  };
}

/** Open one or more files in the PrusaSlicer GUI. Passing multiple files loads
 *  them all onto one plate (PrusaSlicer auto-arranges them on import) — this is
 *  the closest thing to "live" GUI work, since PrusaSlicer exposes no API to
 *  manipulate an already-open window. */
export async function openInGui(
  filePath: string | string[],
  configIni?: string,
): Promise<void> {
  const paths = (Array.isArray(filePath) ? filePath : [filePath]).filter((p) =>
    existsSync(p),
  );
  if (paths.length === 0) {
    throw new Error(`File not found: ${Array.isArray(filePath) ? filePath.join(", ") : filePath}`);
  }

  // With settings: launch the binary directly in GUI mode (no action flag ⇒
  // GUI) and `--load` the effective config, so the opened model carries the
  // same settings as a headless slice. The process is the user's own GUI, so
  // it is detached and NOT tracked as one of our headless spawns.
  if (configIni && existsSync(configIni)) {
    const bin = assertInstalled();
    const child = spawn(bin, ["--load", configIni, ...paths], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return;
  }

  // No settings to apply: hand off to LaunchServices (reuses a running GUI).
  const { code, stderr } = await run("open", ["-a", APP_NAME, ...paths], 15_000);
  if (code !== 0) {
    throw new Error(`Couldn't open PrusaSlicer: ${stderr.trim() || `exit ${code}`}`);
  }
}

/**
 * Open an ALREADY-SLICED .gcode file in PrusaSlicer. This is the honest
 * realization of "slice, then open to the export page": opening a .gcode makes
 * PrusaSlicer load it straight into the toolpath PREVIEW (the same view you'd
 * reach after clicking Slice), showing the print time / filament / layer preview
 * with G-code export & "Send to printer" available — and NO Slice click needed,
 * because the file is already sliced. (We do this instead of trying to auto-press
 * the Slice button, which PrusaSlicer exposes no API for: any action flag like
 * --export-gcode forces headless mode, so you cannot both slice and show the GUI
 * in one invocation. Slicing headlessly first, then opening the result, is the
 * reliable equivalent.)
 *
 * No --load is passed: the .gcode already encodes the sliced result, so config
 * is irrelevant to the preview. Detached + untracked — it's the user's own GUI.
 */
export async function openGcodeInGui(gcodePath: string): Promise<void> {
  if (!existsSync(gcodePath)) {
    throw new Error(`Sliced G-code not found: ${gcodePath}`);
  }
  // Hand off to LaunchServices so an already-open PrusaSlicer is reused; opening
  // a .gcode association lands on the preview. (Falls back to the binary if the
  // association isn't registered.)
  const { code, stderr } = await run("open", ["-a", APP_NAME, gcodePath], 15_000);
  if (code !== 0) {
    throw new Error(
      `Couldn't open the sliced G-code in PrusaSlicer: ${stderr.trim() || `exit ${code}`}`,
    );
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Normalize a colour string to "#RRGGBB", or undefined if it isn't a hex
 *  colour we recognize. Accepts "#rgb", "rgb", "#rrggbb", "rrggbb". */
function normalizeHexColour(input?: string): string | undefined {
  if (!input) return undefined;
  let h = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : undefined;
}

/** Inputs the recommendation engine reasons over. All optional except info. */
export interface RecommendInput {
  goal?: PrintGoal; // default "quality"
  material?: PrintMaterial; // default "PLA"
  nozzleMm?: number; // default 0.4
  /** Printer build volume in mm; defaults to a Prusa MK-class 250×210×210. */
  bed?: { x: number; y: number; z: number };
}

export interface Recommendation {
  params: SliceParams;
  /** Plain-language reasons for each decision. */
  rationale: string[];
  /** Non-blocking cautions (bed fit, non-manifold mesh, material gotchas). */
  warnings: string[];
  /** The effective goal/material/nozzle used (after defaults). */
  assumptions: { goal: PrintGoal; material: PrintMaterial; nozzleMm: number };
}

const DEFAULT_BED = { x: 250, y: 210, z: 210 };

/**
 * Choose accurate, print-safe slicing settings from the model's geometry plus
 * the user's intent (goal / material / nozzle). Grounded in the Prusa Knowledge
 * Base and verified PrusaSlicer defaults — see the research notes in the repo.
 *
 * It is still a starting point: overhang-aware support placement needs the real
 * mesh, so we lean on PrusaSlicer's auto-support and flag uncertainty.
 */
export function recommendSettings(
  info: ModelInfo,
  input: RecommendInput = {},
): Recommendation {
  const goal: PrintGoal = input.goal ?? "quality";
  const material: PrintMaterial = input.material ?? "PLA";
  const nozzle = input.nozzleMm && input.nozzleMm > 0 ? input.nozzleMm : 0.4;
  const bed = input.bed ?? DEFAULT_BED;

  const rationale: string[] = [];
  const warnings: string[] = [];

  // ── Layer height: bounded by nozzle (≈25–75%, hard ceiling 80%) ─────────
  const layerMin = Math.max(0.08, round2(0.25 * nozzle));
  const layerCeil = round2(0.8 * nozzle); // PrusaSlicer rejects ≥ nozzle
  let layerHeightMm: number;
  if (goal === "draft") {
    layerHeightMm = clamp(round2(0.75 * nozzle), layerMin, layerCeil);
    rationale.push(
      `Draft goal → ${layerHeightMm} mm layers (thick, fast) for a ${nozzle} mm nozzle.`,
    );
  } else if (goal === "quality") {
    layerHeightMm = clamp(round2(0.3 * nozzle), layerMin, layerCeil); // ~0.12 @ 0.4
    rationale.push(
      `Quality goal → ${layerHeightMm} mm layers for finer detail.`,
    );
  } else {
    layerHeightMm = clamp(round2(0.5 * nozzle), layerMin, layerCeil); // ~0.20 @ 0.4
    rationale.push(
      `Functional goal → ${layerHeightMm} mm layers (balanced strength & time).`,
    );
  }

  // ── Infill density + pattern + perimeters by goal ───────────────────────
  let fillDensityPct: number;
  let fillPattern: string;
  let perimeters: number;
  if (goal === "draft") {
    fillDensityPct = 12;
    fillPattern = "rectilinear"; // cheapest/fastest
    perimeters = 2;
    rationale.push(`12% rectilinear infill, 2 walls — minimal material & time.`);
  } else if (goal === "quality") {
    fillDensityPct = 15;
    fillPattern = "gyroid"; // strong in all directions, fast
    perimeters = 2;
    rationale.push(`15% gyroid infill, 2 walls — clean display-quality default.`);
  } else {
    fillDensityPct = 50;
    fillPattern = "gyroid";
    perimeters = 4; // strength comes mostly from walls
    rationale.push(`50% gyroid infill, 4 walls — strength for a functional part.`);
  }

  // ── Solid shells: derive layer COUNT from a target thickness ────────────
  // Prusa min thickness: ~0.7 mm top, ~0.5 mm bottom; scales with layer height.
  const topSolidLayers = Math.max(3, Math.ceil(0.7 / layerHeightMm));
  const bottomSolidLayers = Math.max(3, Math.ceil(0.5 / layerHeightMm));

  // ── Geometry: footprint / tallness drive supports & brim ────────────────
  const footprintMin = Math.min(info.sizeX, info.sizeY);
  const footprintArea = info.sizeX * info.sizeY;
  const aspectTall = footprintMin > 0 ? info.sizeZ / footprintMin : 0;

  // Supports: we can't see overhang angles from the bounding box, so use
  // PrusaSlicer auto-support (threshold 50°) and only turn it ON when the
  // geometry strongly suggests overhangs (tall vs. its base).
  const supportMaterial = aspectTall > 2.2;
  const supportThresholdDeg = 50;
  if (supportMaterial) {
    rationale.push(
      `Tall relative to its base (${info.sizeZ.toFixed(0)} vs ${footprintMin.toFixed(
        0,
      )} mm) → auto-supports on (50° threshold). Check the preview.`,
    );
  } else {
    rationale.push(
      `Squat profile → supports off. If the model has steep overhangs, ask me to turn them on.`,
    );
  }

  // Brim: small footprint, tall/narrow, or warp-prone material.
  let brimWidthMm = 0;
  const needsBrim =
    footprintArea < 100 || aspectTall > 3 || material === "ABS" || material === "PETG";
  if (needsBrim) {
    brimWidthMm = material === "ABS" || aspectTall > 5 ? 8 : 5;
    rationale.push(
      `${brimWidthMm} mm brim for first-layer adhesion (${
        footprintArea < 100
          ? "small footprint"
          : aspectTall > 3
            ? "tall/narrow"
            : material + " adhesion"
      }).`,
    );
  }

  // ── Material cautions ───────────────────────────────────────────────────
  if (material === "PETG") {
    warnings.push("PETG bonds hard to supports — they can be tough to remove.");
  } else if (material === "ABS") {
    warnings.push(
      "ABS warps and really wants an enclosure/warm chamber; large flat parts may lift off the bed.",
    );
  }

  // ── Bed fit + mesh sanity (non-blocking warnings) ───────────────────────
  const margin = 5;
  if (
    info.sizeX > bed.x - 2 * margin ||
    info.sizeY > bed.y - 2 * margin ||
    info.sizeZ > bed.z
  ) {
    const scale = Math.min(
      (bed.x - 2 * margin) / info.sizeX,
      (bed.y - 2 * margin) / info.sizeY,
      bed.z / info.sizeZ,
    );
    warnings.push(
      `Model is ${info.sizeX.toFixed(0)}×${info.sizeY.toFixed(0)}×${info.sizeZ.toFixed(
        0,
      )} mm but the bed is ${bed.x}×${bed.y}×${bed.z} mm — scale to ~${(scale * 100).toFixed(
        0,
      )}% or rotate/split to fit.`,
    );
  }
  if (info.manifold === false) {
    warnings.push(
      "Mesh isn't watertight (non-manifold) — it may need repair for a reliable print.",
    );
  }

  return {
    params: {
      layerHeightMm,
      fillDensityPct,
      fillPattern,
      perimeters,
      topSolidLayers,
      bottomSolidLayers,
      supportMaterial,
      supportThresholdDeg,
      brimWidthMm,
      nozzleDiameterMm: nozzle,
    },
    rationale,
    warnings,
    assumptions: { goal, material, nozzleMm: nozzle },
  };
}

/**
 * Recommend settings for a WHOLE PLATE of parts. Layer/infill/walls come from
 * the largest part (the plate prints at one resolution), but supports and brim
 * are aggregated conservatively across ALL parts so a tall/awkward part isn't
 * left unsupported just because it isn't the primary:
 *   - supports ON if ANY part needs them (threshold = the lowest any part wants)
 *   - brim = the WIDEST any part wants (best adhesion for the trickiest part)
 * Warnings from every part are merged (deduped).
 */
export function recommendForPlate(
  infos: ModelInfo[],
  input: RecommendInput = {},
): Recommendation {
  if (infos.length === 0) throw new Error("No parts to recommend for.");
  // Base the resolution/infill on the largest part by volume (or bounding box).
  const primary =
    [...infos].sort(
      (a, b) =>
        (b.volumeMm3 ?? b.sizeX * b.sizeY * b.sizeZ) -
        (a.volumeMm3 ?? a.sizeX * a.sizeY * a.sizeZ),
    )[0];
  const base = recommendSettings(primary, input);
  if (infos.length === 1) return base;

  const recs = infos.map((i) => recommendSettings(i, input));

  // Supports: ON if any part wants them; use the lowest (most aggressive) threshold.
  const anySupport = recs.some((r) => r.params.supportMaterial);
  const minThreshold = Math.min(
    ...recs
      .filter((r) => r.params.supportMaterial)
      .map((r) => r.params.supportThresholdDeg ?? 50),
  );
  // Brim: the widest any part wants.
  const maxBrim = Math.max(...recs.map((r) => r.params.brimWidthMm ?? 0));

  const rationale = [...base.rationale];
  if (anySupport && !base.params.supportMaterial) {
    rationale.push(
      `Supports turned on for the plate — at least one part needs them.`,
    );
  }
  if (maxBrim > (base.params.brimWidthMm ?? 0)) {
    rationale.push(
      `Brim widened to ${maxBrim} mm — the trickiest part on the plate needs it.`,
    );
  }
  // Merge + dedupe warnings across parts.
  const warnings = [...new Set(recs.flatMap((r) => r.warnings))];

  return {
    params: {
      ...base.params,
      supportMaterial: anySupport,
      supportThresholdDeg: anySupport
        ? Number.isFinite(minThreshold)
          ? minThreshold
          : 50
        : base.params.supportThresholdDeg,
      brimWidthMm: maxBrim,
    },
    rationale,
    warnings,
    assumptions: base.assumptions,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
