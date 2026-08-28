// "file" transport — no network at all. Copies the sliced G-code into a
// destination folder (default: the shared slices directory from
// getConfig()). This is the always-works fallback: SD-card printers, "just
// show me the file", and the safety net when no networked transport is
// configured or reachable. It can never fail to reach a "printer" (there
// isn't one), so test() only checks that the destination is writable.
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { getConfig } from "../../config";
import type { PrinterDriver, PrinterStatus, PrinterTestResult, SendJobResult } from "../../../shared/printers";
import { describeError, nowIso } from "../util";

function destDir(outputDir: string | undefined): string {
  return outputDir && outputDir.trim().length > 0 ? outputDir : getConfig().slicesDir;
}

export const fileDriver: PrinterDriver = {
  transport: "file",
  // Not networked — there's no port to speak of. 0 signals "not applicable"
  // to anything that renders defaultPort as a suggested value.
  defaultPort: 0,
  label: "Folder / SD card",
  requiredSecrets: [],

  async test(printer): Promise<PrinterTestResult> {
    const dir = destDir(printer.outputDir);
    try {
      await mkdir(dir, { recursive: true });
      return { ok: true, message: `Ready — G-code will be copied to ${dir}.` };
    } catch (err) {
      return { ok: false, message: `Can't write to ${dir}: ${describeError(err)}` };
    }
  },

  async status(printer): Promise<PrinterStatus> {
    // A folder has no live print state — this transport is a drop-box, not a
    // printer Slicely can watch.
    return {
      id: printer.id,
      state: "idle",
      observedAt: nowIso(),
      message: "File transport has no live status — check the printer itself.",
    };
  },

  async send(printer, gcodePath, opts): Promise<SendJobResult> {
    const dir = destDir(printer.outputDir);
    const name = opts.jobName || basename(gcodePath);
    try {
      await mkdir(dir, { recursive: true });
      const dest = join(dir, name);
      await copyFile(gcodePath, dest);
      return {
        ok: true,
        // Never "started" — there is no printer here to start anything on.
        started: false,
        message: `Copied to ${dest}. Load it onto the printer yourself (SD card / USB stick).`,
      };
    } catch (err) {
      return { ok: false, started: false, message: `Copy failed: ${describeError(err)}` };
    }
  },
};
