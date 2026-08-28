// Klipper/Moonraker REST driver. Moonraker's HTTP API is documented at
// moonraker.readthedocs.io/en/latest/web_api/. On a LAN it's usually
// unauthenticated (the client IP is in Moonraker's trusted_clients list), but
// Slicely sends X-Api-Key when the user has supplied one — Moonraker's
// optional API-key auth for untrusted clients.
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

const UPLOAD_TIMEOUT_MS = 60_000;

function baseUrl(p: ResolvedPrinter): string {
  return `http://${p.host}:${p.port ?? moonrakerDriver.defaultPort}`;
}

function headers(p: ResolvedPrinter): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (p.apiKey) h["X-Api-Key"] = p.apiKey;
  return h;
}

interface PrinterInfo {
  result?: { state?: string; state_message?: string; software_version?: string; hostname?: string };
}

interface ObjectsQuery {
  result?: {
    status?: {
      print_stats?: { filename?: string; state?: string; message?: string };
      heater_bed?: { temperature?: number; target?: number };
      extruder?: { temperature?: number; target?: number };
      virtual_sdcard?: { progress?: number; is_active?: boolean };
      display_status?: { progress?: number; message?: string };
    };
  };
}

/** Map Klipper's print_stats.state to Slicely's coarse PrinterState. Values
 *  per Moonraker's docs: standby, printing, paused, complete, cancelled, error. */
function mapState(s: string | undefined): PrinterState {
  switch (s) {
    case "printing":
      return "printing";
    case "paused":
      return "paused";
    case "complete":
      return "finished";
    case "cancelled":
      return "idle";
    case "error":
      return "error";
    case "standby":
      return "idle";
    default:
      return "unknown";
  }
}

export const moonrakerDriver: PrinterDriver = {
  transport: "moonraker",
  defaultPort: 7125,
  label: "Moonraker (Klipper)",
  requiredSecrets: [],

  async test(printer): Promise<PrinterTestResult> {
    try {
      const res = await fetchTimeout(`${baseUrl(printer)}/printer/info`, { headers: headers(printer) });
      if (!res.ok) {
        return {
          ok: false,
          message:
            res.status === 401
              ? "Moonraker rejected the API key."
              : `Moonraker replied ${res.status}. Check the host and port.`,
        };
      }
      const json = (await res.json()) as PrinterInfo;
      return {
        ok: true,
        message: `Connected to Moonraker${json.result?.hostname ? ` (${json.result.hostname})` : ""}.`,
        version: json.result?.software_version,
      };
    } catch (err) {
      return { ok: false, message: `Can't reach Moonraker: ${describeError(err)}` };
    }
  },

  async status(printer): Promise<PrinterStatus> {
    try {
      const qs = "print_stats&heater_bed&extruder&virtual_sdcard&display_status";
      const res = await fetchTimeout(`${baseUrl(printer)}/printer/objects/query?${qs}`, {
        headers: headers(printer),
      });
      if (!res.ok) {
        return { id: printer.id, state: "offline", observedAt: nowIso(), message: `Moonraker → ${res.status}` };
      }
      const json = (await res.json()) as ObjectsQuery;
      const st = json.result?.status;
      // display_status.progress mirrors virtual_sdcard.progress but also
      // covers non-SD (virtual file) prints — prefer it, fall back to the SD
      // value. Both are 0..1 fractions.
      const progress = st?.display_status?.progress ?? st?.virtual_sdcard?.progress;

      return {
        id: printer.id,
        state: mapState(st?.print_stats?.state),
        jobName: st?.print_stats?.filename || undefined,
        progressPct: progress !== undefined ? Math.round(progress * 100) : undefined,
        nozzleTempC: st?.extruder?.temperature,
        nozzleTargetC: st?.extruder?.target,
        bedTempC: st?.heater_bed?.temperature,
        bedTargetC: st?.heater_bed?.target,
        message: st?.print_stats?.message || undefined,
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
      // See octoprint.ts's comment: Buffer's ArrayBufferLike generic doesn't
      // structurally satisfy BlobPart, so re-wrap as a plain Uint8Array.
      form.append("file", new Blob([new Uint8Array(bytes)]), name);
      if (opts.startImmediately) form.append("print", "true");

      const res = await fetchTimeout(
        `${baseUrl(printer)}/server/files/upload`,
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
          : `Uploaded ${name}. Start it from Mainsail/Fluidd (or arm auto-start).`,
      };
    } catch (err) {
      return { ok: false, started: false, message: `Upload failed: ${describeError(err)}` };
    }
  },

  async pause(printer) {
    return simplePost(printer, "/printer/print/pause", "Paused.");
  },
  async resume(printer) {
    return simplePost(printer, "/printer/print/resume", "Resumed.");
  },
  async cancel(printer) {
    return simplePost(printer, "/printer/print/cancel", "Cancelled.");
  },
};

async function simplePost(printer: ResolvedPrinter, path: string, okMessage: string): Promise<SendJobResult> {
  try {
    const res = await fetchTimeout(
      `${baseUrl(printer)}${path}`,
      { method: "POST", headers: headers(printer) },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, started: false, message: `Moonraker refused (${res.status}).` };
    return { ok: true, started: false, message: okMessage };
  } catch (err) {
    return { ok: false, started: false, message: describeError(err) };
  }
}
