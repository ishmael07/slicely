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
//   • Running check: `pgrep -x PrusaSlicer`
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  ModelInfo,
  SliceParams,
  SliceMetrics,
  SlicerStatus,
} from "../shared/types";
import { getConfig } from "./config";

const APP_NAME = "PrusaSlicer";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a process, capture stdout/stderr, resolve on exit (never rejects). */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { windowsHide: true });

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function binaryPath(): string {
  return getConfig().prusaSlicerPath;
}

/** Resolve install + running state + version. */
export async function getStatus(): Promise<SlicerStatus> {
  const bin = binaryPath();
  const installed = existsSync(bin);
  const running = await isRunning();
  let version: string | undefined;

  if (installed) {
    version = await getVersion(bin);
  }

  return { installed, running, binaryPath: bin, version, appName: APP_NAME };
}

async function isRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", APP_NAME], (err, stdout) => {
      // pgrep exits 1 with no match; that's "not running", not an error.
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

async function getVersion(bin: string): Promise<string | undefined> {
  const { stdout, stderr } = await run(bin, ["--help"], 15_000);
  const banner = (stdout + stderr).split("\n", 1)[0] ?? "";
  // First line looks like: "PrusaSlicer-2.9.0+... based on Slic3r ..."
  const m = banner.match(/PrusaSlicer-([^\s]+)/i);
  return m ? m[1] : undefined;
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
  const { code, stdout, stderr } = await run(bin, ["--info", stlPath], 60_000);
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

/** Slice an STL to G-code with the given params, then parse metrics. */
export async function slice(
  stlPath: string,
  params: SliceParams = {},
): Promise<SliceMetrics> {
  const bin = assertInstalled();
  if (!existsSync(stlPath)) {
    throw new Error(`Model file not found: ${stlPath}`);
  }

  const cfg = getConfig();
  const base = basename(stlPath, extname(stlPath));
  const gcodePath = join(cfg.slicesDir, `${base}.gcode`);

  const args: string[] = ["--export-gcode", stlPath, "--output", gcodePath];

  // Load a real printer/filament config if the user exported one.
  if (cfg.prusaConfigIni && existsSync(cfg.prusaConfigIni)) {
    args.push("--load", cfg.prusaConfigIni);
  }

  // CLI overrides take precedence over --load values.
  if (typeof params.layerHeightMm === "number") {
    args.push("--layer-height", String(params.layerHeightMm));
  }
  if (typeof params.fillDensityPct === "number") {
    // fill_density is a percent option; pass the bare number.
    args.push("--fill-density", String(params.fillDensityPct));
  }
  if (typeof params.supportMaterial === "boolean") {
    args.push(params.supportMaterial ? "--support-material" : "--no-support-material");
  }
  if (typeof params.brimWidthMm === "number") {
    args.push("--brim-width", String(params.brimWidthMm));
  }
  if (typeof params.nozzleDiameterMm === "number") {
    args.push("--nozzle-diameter", String(params.nozzleDiameterMm));
  }

  const { code, stdout, stderr } = await run(bin, args, 300_000);

  if (!existsSync(gcodePath)) {
    const reason =
      stderr.trim() ||
      stdout.trim() ||
      `exit ${code}. The print may be empty or outside the print volume.`;
    throw new Error(`Slicing failed: ${reason}`);
  }

  return parseMetrics(gcodePath);
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

/** Open a model file in the PrusaSlicer GUI for the user. */
export async function openInGui(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const { code, stderr } = await run("open", ["-a", APP_NAME, filePath], 15_000);
  if (code !== 0) {
    throw new Error(`Couldn't open PrusaSlicer: ${stderr.trim() || `exit ${code}`}`);
  }
}

/**
 * Heuristic, non-binding slicing recommendation based on model dimensions.
 * The agent uses this as a starting point and explains the reasoning to the
 * user; it is not a substitute for the user's own judgement.
 */
export function recommendSettings(info: ModelInfo): {
  params: SliceParams;
  rationale: string[];
} {
  const maxDim = Math.max(info.sizeX, info.sizeY, info.sizeZ);
  const rationale: string[] = [];

  // Layer height: finer for small/detailed, coarser for big/chunky.
  let layerHeightMm = 0.2;
  if (maxDim <= 30) {
    layerHeightMm = 0.12;
    rationale.push(
      `Small part (${maxDim.toFixed(0)} mm) → 0.12 mm layers for finer detail.`,
    );
  } else if (maxDim >= 150) {
    layerHeightMm = 0.28;
    rationale.push(
      `Large part (${maxDim.toFixed(0)} mm) → 0.28 mm layers to cut print time.`,
    );
  } else {
    rationale.push(`Medium part → 0.2 mm layers (a good general default).`);
  }

  // Infill: light for decorative, heavier as parts get larger/structural.
  let fillDensityPct = 15;
  if (maxDim >= 120) {
    fillDensityPct = 20;
    rationale.push(`Larger part → 20% infill for added rigidity.`);
  } else {
    rationale.push(`15% infill is plenty for a decorative/light part.`);
  }

  // Supports: suggest when the part is tall relative to its footprint, which
  // correlates with overhangs. This is a coarse heuristic — flag it as such.
  const footprint = Math.max(info.sizeX, info.sizeY);
  const supportMaterial = info.sizeZ > footprint * 1.5;
  rationale.push(
    supportMaterial
      ? `Tall relative to its base (${info.sizeZ.toFixed(0)} mm vs ${footprint.toFixed(
          0,
        )} mm) → supports likely needed for overhangs. Eyeball the preview to confirm.`
      : `Squat profile → probably no supports needed. Check the preview for overhangs.`,
  );

  // Brim helps adhesion for tall/narrow parts.
  const brimWidthMm = supportMaterial ? 4 : 0;
  if (brimWidthMm > 0) {
    rationale.push(`Added a 4 mm brim to improve first-layer adhesion.`);
  }

  return {
    params: { layerHeightMm, fillDensityPct, supportMaterial, brimWidthMm },
    rationale,
  };
}
