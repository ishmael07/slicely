// OctoPrint REST driver. OctoPrint's HTTP API is public and stable
// (docs.octoprint.org/en/master/api/) — this implements the slice Slicely
// needs: a version probe, printer + job status, G-code upload, and job
// control. Field names below (state.flags.*, temperature.tool0/bed,
// job.file.name, progress.completion/printTimeLeft) match that published API.
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  PrinterDriver,
  PrinterState,
  PrinterStatus,
  PrinterTestResult,
  ResolvedPrinter,
  SendJobResult,
} from "../../../shared/printers";
import { DEFAULT_TIMEOUT_MS, describeError, fetchTimeout, nowIso, safeText } from "../util";

// Uploads can legitimately take much longer than a status probe — a sliced
// plate can be tens of MB and OctoPrint writes it to disk before replying.
const UPLOAD_TIMEOUT_MS = 60_000;

function baseUrl(p: ResolvedPrinter): string {
  return `http://${p.host}:${p.port ?? octoprintDriver.defaultPort}`;
}

function headers(p: ResolvedPrinter): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (p.apiKey) h["X-Api-Key"] = p.apiKey;
  return h;
}

interface OctoVersion {
  api?: string;
  server?: string;
  text?: string;
}

interface OctoPrinterState {
  state?: { text?: string; flags?: Record<string, boolean> };
  temperature?: Record<string, { actual?: number; target?: number } | undefined>;
}

interface OctoJob {
  job?: { file?: { name?: string } };
  progress?: { completion?: number | null; printTimeLeft?: number | null };
}

/** Map OctoPrint's `state.flags` bag to Slicely's coarse PrinterState.
 *  Checked in priority order: an active/error condition always wins over the
 *  merely-connected flags (`operational`/`ready`), which are also set while
 *  printing. */
function mapState(flags: Record<string, boolean> | undefined): PrinterState {
  if (!flags) return "unknown";
  if (flags.printing) return "printing";
  if (flags.paused || flags.pausing) return "paused";
  // "cancelling" is a brief transitional flag on the way back to idle — still
  // actively printing from the user's point of view.
  if (flags.cancelling) return "printing";
  if (flags.error || flags.closedOrError) return "error";
  if (flags.ready || flags.operational) return "idle";
  return "unknown";
}

export const octoprintDriver: PrinterDriver = {
  transport: "octoprint",
  defaultPort: 80,
  label: "OctoPrint",
  requiredSecrets: ["apiKey"],

  async test(printer): Promise<PrinterTestResult> {
    try {
      const res = await fetchTimeout(`${baseUrl(printer)}/api/version`, { headers: headers(printer) });
      if (!res.ok) {
        return {
          ok: false,
          message:
            res.status === 401 || res.status === 403
              ? "OctoPrint rejected the API key."
              : `OctoPrint replied ${res.status}. Check the host and port.`,
        };
      }
      const json = (await res.json()) as OctoVersion;
      return {
        ok: true,
        message: `Connected to OctoPrint${json.server ? ` ${json.server}` : ""}.`,
        version: json.server,
      };
    } catch (err) {
      return { ok: false, message: `Can't reach OctoPrint: ${describeError(err)}` };
    }
  },

  async status(printer): Promise<PrinterStatus> {
    try {
      const [printerRes, jobRes] = await Promise.all([
        fetchTimeout(`${baseUrl(printer)}/api/printer`, { headers: headers(printer) }),
        fetchTimeout(`${baseUrl(printer)}/api/job`, { headers: headers(printer) }),
      ]);

      if (!printerRes.ok) {
        // OctoPrint returns 409 when the server is up but not connected to
        // the printer board (e.g. USB unplugged) — that's "idle-ish", not
        // network-offline, so it gets its own message rather than "offline".
        return {
          id: printer.id,
          state: printerRes.status === 409 ? "idle" : "offline",
          observedAt: nowIso(),
          message:
            printerRes.status === 409
              ? "OctoPrint is running but not connected to the printer."
              : `OctoPrint /api/printer → ${printerRes.status}`,
        };
      }

      const p = (await printerRes.json()) as OctoPrinterState;
      const j = jobRes.ok ? ((await jobRes.json()) as OctoJob) : undefined;
      const tool0 = p.temperature?.tool0;
      const bed = p.temperature?.bed;

      return {
        id: printer.id,
        state: mapState(p.state?.flags),
        jobName: j?.job?.file?.name ?? undefined,
        progressPct: j?.progress?.completion ?? undefined,
        timeRemainingSec: j?.progress?.printTimeLeft ?? undefined,
        nozzleTempC: tool0?.actual,
        nozzleTargetC: tool0?.target,
        bedTempC: bed?.actual,
        bedTargetC: bed?.target,
        observedAt: nowIso(),
      };
    } catch (err) {
      return { id: printer.id, state: "offline", observedAt: nowIso(), message: describeError(err) };
    }
  },

  async send(printer, gcodePath, opts): Promise<SendJobResult> {
    const name = opts.jobName || basename(gcodePath);
    try {
      const bytes = await readFile(gcodePath);
      const form = new FormData();
      // Buffer's ArrayBufferLike generic (which can be a SharedArrayBuffer)
      // doesn't structurally satisfy BlobPart's ArrayBuffer-backed view —
      // re-wrapping as a plain Uint8Array (a real, non-shared ArrayBuffer)
      // satisfies the type and costs one copy of an already-small G-code file.
      form.append("file", new Blob([new Uint8Array(bytes)]), name);
      // Always select the upload so it's the ready-to-print file in
      // OctoPrint's UI; "print" is the actual start switch and stays
      // false unless the caller (the safety-gated façade) says otherwise.
      form.append("select", "true");
      form.append("print", opts.startImmediately ? "true" : "false");

      const res = await fetchTimeout(
        `${baseUrl(printer)}/api/files/local`,
        { method: "POST", headers: headers(printer), body: form },
        UPLOAD_TIMEOUT_MS,
      );
      if (!res.ok) {
        return { ok: false, started: false, message: `Upload failed (${res.status}): ${await safeText(res)}` };
      }
      return {
        ok: true,
        started: opts.startImmediately,
        message: opts.startImmediately
          ? `Uploaded and started ${name}.`
          : `Uploaded ${name}. Start it from OctoPrint (or arm auto-start).`,
      };
    } catch (err) {
      return { ok: false, started: false, message: `Upload failed: ${describeError(err)}` };
    }
  },

  async pause(printer) {
    return jobCommand(printer, { command: "pause", action: "pause" }, "Paused.");
  },
  async resume(printer) {
    return jobCommand(printer, { command: "pause", action: "resume" }, "Resumed.");
  },
  async cancel(printer) {
    return jobCommand(printer, { command: "cancel" }, "Cancelled.");
  },
};

async function jobCommand(
  printer: ResolvedPrinter,
  body: Record<string, string>,
  okMessage: string,
): Promise<SendJobResult> {
  try {
    const res = await fetchTimeout(
      `${baseUrl(printer)}/api/job`,
      {
        method: "POST",
        headers: { ...headers(printer), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, started: false, message: `OctoPrint refused (${res.status}).` };
    return { ok: true, started: false, message: okMessage };
  } catch (err) {
    return { ok: false, started: false, message: describeError(err) };
  }
}
