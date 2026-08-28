// Prusa Connect cloud driver — https://connect.prusa3d.com. This is the only
// cloud transport Prusa offers, and it matters a lot for Slicely: it's what
// lets a zero-install (web) deployment print to a Prusa printer without the
// user's LAN being reachable from wherever Slicely is running.
//
// UNVERIFIED, IN FULL: Prusa publishes an open-source client for the
// PRINTER side of Connect's protocol (`Prusa-Connect-SDK-Printer`, how a
// printer registers itself and pushes telemetry), but there is no published
// spec for the CONSUMER side — how a third-party client like Slicely would,
// using a personal account token, list a user's printers, read status, and
// push a file to print. Every endpoint below is a best-effort guess based on
// the `/app/...` path prefix Connect's own web app is known to use and on
// the shape of the printer-side telemetry protocol. Nothing in this file has
// been exercised against a live Connect account. Treat it as a starting
// skeleton: the auth header (Bearer token) and the overall shape (REST +
// multipart upload) are reasonable bets, but every path, field name, and
// status code check here should be confirmed — or replaced — once real API
// access is available. Driver methods still hold the "never throw" contract
// regardless of how wrong a guessed endpoint turns out to be.
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
import { describeError, fetchTimeout, nowIso, safeText } from "../util";

const API_BASE = "https://connect.prusa3d.com";
const UPLOAD_TIMEOUT_MS = 60_000;

function authHeaders(p: ResolvedPrinter): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (p.token) h.Authorization = `Bearer ${p.token}`;
  return h;
}

// UNVERIFIED: field names inferred from what Connect's dashboard displays
// (printer name, state, live temperatures/progress). Real field names,
// nesting, and casing are unconfirmed.
interface ConnectPrinterInfo {
  uuid?: string;
  name?: string;
  state?: string; // guessed values: IDLE | READY | PRINTING | PAUSED | ATTENTION | ERROR | OFFLINE | FINISHED
  telemetry?: {
    temp_nozzle?: number;
    target_nozzle?: number;
    temp_bed?: number;
    target_bed?: number;
    progress?: number;
    time_remaining?: number;
  };
  job?: { file?: { display_name?: string } };
}

function mapState(s: string | undefined): PrinterState {
  switch ((s || "").toUpperCase()) {
    case "PRINTING":
      return "printing";
    case "PAUSED":
      return "paused";
    case "FINISHED":
      return "finished";
    case "ERROR":
    case "ATTENTION":
      return "error";
    case "READY":
    case "IDLE":
      return "idle";
    case "OFFLINE":
      return "offline";
    default:
      return "unknown";
  }
}

export const prusaConnectDriver: PrinterDriver = {
  transport: "prusa-connect",
  defaultPort: 443,
  label: "Prusa Connect (cloud)",
  requiredSecrets: ["token"],

  async test(printer): Promise<PrinterTestResult> {
    if (!printer.token) return { ok: false, message: "Missing Prusa Connect API token." };
    try {
      if (!printer.printerUuid) {
        // UNVERIFIED endpoint: without a printer uuid, the best we can check
        // is that the token itself is accepted by listing the account's
        // printers.
        const res = await fetchTimeout(`${API_BASE}/app/printers`, { headers: authHeaders(printer) });
        if (!res.ok) return { ok: false, message: `Prusa Connect rejected the token (${res.status}).` };
        return { ok: true, message: "Token accepted. Add a printer UUID to target a specific printer." };
      }
      const res = await fetchTimeout(`${API_BASE}/app/printers/${printer.printerUuid}`, {
        headers: authHeaders(printer),
      });
      if (!res.ok) return { ok: false, message: `Prusa Connect replied ${res.status} for this printer.` };
      const json = (await res.json()) as ConnectPrinterInfo;
      return { ok: true, message: `Connected to "${json.name ?? printer.printerUuid}" via Prusa Connect.` };
    } catch (err) {
      return { ok: false, message: `Can't reach Prusa Connect: ${describeError(err)}` };
    }
  },

  async status(printer): Promise<PrinterStatus> {
    if (!printer.token || !printer.printerUuid) {
      return {
        id: printer.id,
        state: "unknown",
        observedAt: nowIso(),
        message: "Missing Prusa Connect token or printer UUID.",
      };
    }
    try {
      const res = await fetchTimeout(`${API_BASE}/app/printers/${printer.printerUuid}`, {
        headers: authHeaders(printer),
      });
      if (!res.ok) {
        return { id: printer.id, state: "offline", observedAt: nowIso(), message: `Prusa Connect → ${res.status}` };
      }
      const json = (await res.json()) as ConnectPrinterInfo;
      const t = json.telemetry;
      return {
        id: printer.id,
        state: mapState(json.state),
        jobName: json.job?.file?.display_name,
        progressPct: t?.progress,
        timeRemainingSec: t?.time_remaining,
        nozzleTempC: t?.temp_nozzle,
        nozzleTargetC: t?.target_nozzle,
        bedTempC: t?.temp_bed,
        bedTargetC: t?.target_bed,
        observedAt: nowIso(),
      };
    } catch (err) {
      return { id: printer.id, state: "offline", observedAt: nowIso(), message: describeError(err) };
    }
  },

  async send(printer, gcodePath, opts): Promise<SendJobResult> {
    if (!printer.token || !printer.printerUuid) {
      return { ok: false, started: false, message: "Missing Prusa Connect token or printer UUID." };
    }
    const name = opts.jobName || basename(gcodePath);
    try {
      const bytes = await readFile(gcodePath);
      // UNVERIFIED: guessed upload endpoint + multipart field name, modeled
      // loosely on Connect's web uploader. Real path/field names unconfirmed.
      const form = new FormData();
      // See octoprint.ts's comment: Buffer's ArrayBufferLike generic doesn't
      // structurally satisfy BlobPart, so re-wrap as a plain Uint8Array.
      form.append("file", new Blob([new Uint8Array(bytes)]), name);
      const res = await fetchTimeout(
        `${API_BASE}/app/printers/${printer.printerUuid}/upload`,
        { method: "POST", headers: authHeaders(printer), body: form },
        UPLOAD_TIMEOUT_MS,
      );
      if (!res.ok) {
        return { ok: false, started: false, message: `Upload to Prusa Connect failed (${res.status}): ${await safeText(res)}` };
      }
      if (!opts.startImmediately) {
        return {
          ok: true,
          started: false,
          message: `Uploaded ${name} to Prusa Connect. Start it from the Connect app (or arm auto-start).`,
        };
      }
      // UNVERIFIED: guessed start-print endpoint + body.
      const startRes = await fetchTimeout(`${API_BASE}/app/printers/${printer.printerUuid}/print`, {
        method: "POST",
        headers: { ...authHeaders(printer), "Content-Type": "application/json" },
        body: JSON.stringify({ file: name }),
      });
      if (!startRes.ok) {
        return {
          ok: true,
          started: false,
          message: `Uploaded ${name}, but starting it automatically failed (${startRes.status}). Start it from the Connect app.`,
        };
      }
      return { ok: true, started: true, message: `Uploaded and started ${name} via Prusa Connect.` };
    } catch (err) {
      return { ok: false, started: false, message: `Upload failed: ${describeError(err)}` };
    }
  },

  // pause/resume/cancel omitted — no verified endpoint for either; see the
  // file-header comment. Guessing here would be worse than not offering it.
};
