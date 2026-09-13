// "file" transport — no network at all. Copies the sliced G-code into a
// destination folder (default: the session's slices directory from
// getConfig()). This is the always-works fallback: SD-card printers, "just
// show me the file", and the safety net when no networked transport is
// configured or reachable. It can never fail to reach a "printer" (there
// isn't one), so test() only checks that the destination is writable.
//
// ── WHERE IT MAY WRITE ──────────────────────────────────────────────────────
// This is the one driver that writes to the machine Slicely runs on, so it is
// the one driver where a caller-supplied string is a filesystem capability.
// `outputDir` goes through `assertAllowedOutputDir` (desktop only, inside the
// user's home or on a mounted drive under /Volumes, no hidden folders) and the
// filename through `safeJobName` (a basename with a printable extension) —
// see printers/util.ts for why each rule exists. The façade validates both
// when a printer is saved and when a job is sent; re-checking here means a
// record written by an older version, or a caller that bypasses the façade,
// still cannot escape.
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { getConfig } from "../../config";
import { isHosted } from "../../mode";
import { WireError } from "../../../server/errors";
import type { PrinterDriver, PrinterStatus, PrinterTestResult, SendJobResult } from "../../../shared/printers";
import { assertAllowedOutputDir, describeError, nowIso, safeJobName } from "../util";

/**
 * The folder this printer writes into.
 *
 * A user-chosen folder is validated. An empty one means "wherever Slicely puts
 * slices", which is the server's own choice of directory rather than user
 * input — so it is used as-is (it lives under the configured workdir, which may
 * legitimately sit outside the home directory), but only in desktop mode: on a
 * hosted server there is no folder the visitor could ever collect the file
 * from, so the transport itself doesn't apply.
 */
function destDir(outputDir: string | undefined): string {
  if (outputDir && outputDir.trim().length > 0) return assertAllowedOutputDir(outputDir);
  if (isHosted()) {
    throw new WireError(403, "Saving to a folder only works in the Mac app.", "forbidden_in_hosted_mode");
  }
  return getConfig().slicesDir;
}

export const fileDriver: PrinterDriver = {
  transport: "file",
  // Not networked — there's no port to speak of. 0 signals "not applicable"
  // to anything that renders defaultPort as a suggested value.
  defaultPort: 0,
  label: "Folder / SD card",
  requiredSecrets: [],

  async test(printer): Promise<PrinterTestResult> {
    // Contract: test() never throws — a refused directory is a failed probe
    // with the reason the user needs, not an exception.
    let dir: string;
    try {
      dir = destDir(printer.outputDir);
    } catch (err) {
      return { ok: false, message: describeError(err) };
    }
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
    let dir: string;
    try {
      dir = destDir(printer.outputDir);
    } catch (err) {
      return { ok: false, started: false, message: describeError(err) };
    }
    const name = safeJobName(opts.jobName, basename(gcodePath));
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
