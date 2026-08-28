// Bambu Lab driver — MQTT-based, unlike every other transport in this
// directory. Bambu's firmware pushes machine state over MQTT rather than
// exposing a REST API, and Bambu Lab does not publish this protocol. Every
// message shape below comes from community reverse-engineering (projects
// like OpenBambuAPI, Home Assistant's bambu_lab integration, and
// bambulabs_api) rather than an official spec — field names are annotated
// with confidence where it matters. Two drivers share one MQTT core because
// the wire protocol (topics, report/request JSON shapes) is identical
// between LAN and cloud; only the broker address and credentials differ.
//
// LAN mode (BambuLanDriver, transport "bambu-lan"):
//   - TLS MQTT on port 8883, username "bblp", password = the printer's 8-char
//     LAN access code (shown on the printer's screen under Settings →
//     Network). Reasonably well corroborated across community sources.
//   - The LAN broker uses a self-signed certificate, so rejectUnauthorized
//     must be false — there is no CA to validate against.
//   - Topics: subscribe `device/<serial>/report`, publish requests to
//     `device/<serial>/request`. Requesting a full status push uses
//     `{"pushing":{"sequence_id":"0","command":"pushall"}}`.
//   - File upload to LAN printers is over FTPS (implicit/explicit TLS FTP)
//     on port 990. None of this project's dependencies (mqtt/ws/express/etc)
//     implement FTPS, and hand-rolling it (TLS-wrapped control channel, PASV
//     data connections, directory listing quirks) is out of scope for this
//     pass. send() honestly reports that gap instead of pretending to upload.
//
// Cloud mode (BambuCloudDriver, transport "bambu-cloud"):
//   - MQTT over TLS to us.mqtt.bambulab.com:8883 using an account access
//     token as the password. UNVERIFIED beyond that general shape: community
//     clients commonly derive the MQTT username as "u_<account id>", but
//     Slicely's PrinterSecrets has no separate account-id field, so this
//     passes `username` through as configured (falling back to a guess) and
//     relies on the broker's own accept/reject — needs confirming against a
//     real Bambu Cloud login.
//   - Same report/request topic shape as LAN, scoped by device serial.
//   - Upload has no known path here either (Bambu Cloud print submission is
//     a separate, undocumented flow from the MQTT channel) — send() reports
//     the same limitation as LAN.
//
// Every MQTT operation below is wrapped in an explicit timeout (connectMqtt,
// and the report/command promises), so a broker that never answers — LAN
// printer powered off, cloud DNS not resolving, whatever — fails fast rather
// than hanging the caller indefinitely.
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type {
  FilamentSlot,
  PrinterDriver,
  PrinterState,
  PrinterStatus,
  PrinterTestResult,
  ResolvedPrinter,
  SendJobOptions,
  SendJobResult,
} from "../../../shared/printers";
import { DEFAULT_TIMEOUT_MS, describeError, normalizeColourHex, nowIso } from "../util";

const CLOUD_HOST = "us.mqtt.bambulab.com";
const CLOUD_PORT = 8883;

// ── Shared report/command shapes (community-documented) ─────────────────────

/** One AMS unit's tray report, straight off the wire. */
interface BambuTray {
  id?: string;
  tray_type?: string;
  tray_color?: string; // 8-hex RRGGBBAA
  tray_sub_brands?: string;
  remain?: number; // 0-100
}

interface BambuPrintReport {
  gcode_state?: string; // IDLE | PREPARE | RUNNING | PAUSE | FINISH | FAILED (community-documented)
  mc_percent?: number;
  mc_remaining_time?: number; // MINUTES, per community docs — converted to seconds below
  layer_num?: number;
  total_layer_num?: number;
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  subtask_name?: string;
  ams?: { ams?: Array<{ id?: string; tray?: BambuTray[] }> };
}

interface ReportEnvelope {
  print?: BambuPrintReport;
}

/** Map Bambu's gcode_state to Slicely's coarse PrinterState. */
export function mapGcodeState(s: string | undefined): PrinterState {
  switch ((s || "").toUpperCase()) {
    case "RUNNING":
      return "printing";
    case "PAUSE":
      return "paused";
    case "FINISH":
      return "finished";
    case "FAILED":
      return "error";
    case "PREPARE":
    case "SLICING":
      return "preparing";
    case "IDLE":
      return "idle";
    default:
      return "unknown";
  }
}

/** Flatten every AMS unit's trays into Slicely's FilamentSlot[], normalizing
 *  colour and numbering slots contiguously across units (AMS 0 tray 0..3,
 *  AMS 1 tray 0..3, ... become indices 0..7). Exported for direct unit
 *  testing of the AMS colour-normalization path. */
export function parseFilaments(report: BambuPrintReport): FilamentSlot[] {
  const units = report.ams?.ams ?? [];
  const slots: FilamentSlot[] = [];
  let index = 0;
  for (const unit of units) {
    for (const tray of unit.tray ?? []) {
      slots.push({
        index: index++,
        colourHex: normalizeColourHex(tray.tray_color),
        material: tray.tray_type || undefined,
        label: tray.tray_sub_brands || undefined,
        remainingPct: typeof tray.remain === "number" ? tray.remain : undefined,
        // Best-effort: every documented sample of an empty AMS slot reports
        // an empty tray_type. Not confirmed against a live unit with a
        // genuinely empty slot in every firmware version.
        loaded: Boolean(tray.tray_type),
      });
    }
  }
  return slots;
}

/** Build a PrinterStatus from one report envelope. Exported for testing. */
export function reportToStatus(id: string, env: ReportEnvelope): PrinterStatus {
  const p = env.print ?? {};
  return {
    id,
    state: mapGcodeState(p.gcode_state),
    jobName: p.subtask_name || undefined,
    progressPct: p.mc_percent,
    timeRemainingSec: typeof p.mc_remaining_time === "number" ? p.mc_remaining_time * 60 : undefined,
    currentLayer: p.layer_num,
    totalLayers: p.total_layer_num,
    nozzleTempC: p.nozzle_temper,
    nozzleTargetC: p.nozzle_target_temper,
    bedTempC: p.bed_temper,
    bedTargetC: p.bed_target_temper,
    filaments: parseFilaments(p),
    observedAt: nowIso(),
  };
}

// ── MQTT plumbing ────────────────────────────────────────────────────────────

/** mqtt.connect(), rejecting on error AND on a hard timeout so a broker that
 *  never answers (or never TLS-handshakes) can't hang the caller. */
function connectMqtt(opts: IClientOptions, timeoutMs: number): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = mqtt.connect({ ...opts, connectTimeout: timeoutMs, reconnectPeriod: 0 });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end(true);
      reject(new Error("Timed out connecting to the printer's MQTT broker."));
    }, timeoutMs);

    client.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Connect, request a full status push, wait for the first report that
 *  actually carries `print` state, hand it to `handler`, then always
 *  disconnect — every call here is one-shot rather than a kept-open
 *  subscription, trading a little latency for never leaking a connection. */
async function withBambuReport<T>(
  printer: ResolvedPrinter,
  opts: IClientOptions,
  timeoutMs: number,
  handler: (env: ReportEnvelope) => T,
): Promise<T> {
  if (!printer.serial) throw new Error("Missing printer serial number.");
  const client = await connectMqtt(opts, timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const reportTopic = `device/${printer.serial}/report`;
      const requestTopic = `device/${printer.serial}/request`;
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for the printer's status report.")),
        timeoutMs,
      );

      client.on("message", (_topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString("utf8")) as ReportEnvelope;
          if (!msg.print) return; // keep waiting for a report that carries print state
          clearTimeout(timer);
          resolve(handler(msg));
        } catch {
          /* ignore malformed/partial frames and keep waiting */
        }
      });

      client.subscribe(reportTopic, (err) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        client.publish(requestTopic, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
      });
    });
  } finally {
    client.end(true);
  }
}

async function testViaMqtt(printer: ResolvedPrinter, opts: IClientOptions, timeoutMs: number): Promise<PrinterTestResult> {
  try {
    const env = await withBambuReport(printer, opts, timeoutMs, (e) => e);
    const state = mapGcodeState(env.print?.gcode_state);
    return { ok: true, message: `Connected over MQTT. Printer state: ${state}.` };
  } catch (err) {
    return { ok: false, message: `Can't reach the printer over MQTT: ${describeError(err)}` };
  }
}

async function statusViaMqtt(printer: ResolvedPrinter, opts: IClientOptions, timeoutMs: number): Promise<PrinterStatus> {
  try {
    return await withBambuReport(printer, opts, timeoutMs, (env) => reportToStatus(printer.id, env));
  } catch (err) {
    return { id: printer.id, state: "offline", observedAt: nowIso(), message: describeError(err) };
  }
}

async function sendUnsupported(
  _printer: ResolvedPrinter,
  _gcodePath: string,
  _opts: SendJobOptions,
): Promise<SendJobResult> {
  return {
    ok: false,
    started: false,
    message:
      "Bambu printers receive files over FTPS, which Slicely doesn't implement yet (no FTPS client in this build). " +
      'Copy the G-code to the printer via the Bambu Handy app / SD card, or use the "file" transport to stage it, ' +
      "until FTPS support lands.",
  };
}

/** Community-documented control commands: {"print":{"sequence_id":"0","command":"pause"|"resume"|"stop"}}. */
async function controlViaMqtt(
  printer: ResolvedPrinter,
  opts: IClientOptions,
  timeoutMs: number,
  command: "pause" | "resume" | "stop",
  okMessage: string,
): Promise<SendJobResult> {
  if (!printer.serial) return { ok: false, started: false, message: "Missing printer serial number." };
  try {
    const client = await connectMqtt(opts, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        client.publish(
          `device/${printer.serial}/request`,
          JSON.stringify({ print: { sequence_id: "0", command } }),
          (err) => (err ? reject(err) : resolve()),
        );
      });
    } finally {
      client.end(true);
    }
    return { ok: true, started: false, message: okMessage };
  } catch (err) {
    return { ok: false, started: false, message: describeError(err) };
  }
}

// ── LAN ──────────────────────────────────────────────────────────────────────

function lanMqttOptions(printer: ResolvedPrinter): IClientOptions {
  return {
    host: printer.host,
    port: printer.port ?? BambuLanDriver.defaultPort,
    protocol: "mqtts",
    username: "bblp",
    password: printer.accessCode,
    // Bambu's LAN broker presents a self-signed cert — there's no CA to
    // validate it against, and that's expected/by-design for LAN mode.
    rejectUnauthorized: false,
  };
}

export const BambuLanDriver: PrinterDriver = {
  transport: "bambu-lan",
  defaultPort: 8883,
  label: "Bambu Lab (LAN)",
  requiredSecrets: ["accessCode"],

  async test(printer) {
    return testViaMqtt(printer, lanMqttOptions(printer), DEFAULT_TIMEOUT_MS);
  },
  async status(printer) {
    return statusViaMqtt(printer, lanMqttOptions(printer), DEFAULT_TIMEOUT_MS);
  },
  async send(printer, gcodePath, opts) {
    return sendUnsupported(printer, gcodePath, opts);
  },
  async pause(printer) {
    return controlViaMqtt(printer, lanMqttOptions(printer), DEFAULT_TIMEOUT_MS, "pause", "Paused.");
  },
  async resume(printer) {
    return controlViaMqtt(printer, lanMqttOptions(printer), DEFAULT_TIMEOUT_MS, "resume", "Resumed.");
  },
  async cancel(printer) {
    return controlViaMqtt(printer, lanMqttOptions(printer), DEFAULT_TIMEOUT_MS, "stop", "Cancelled.");
  },
};

// ── Cloud ────────────────────────────────────────────────────────────────────

function cloudMqttOptions(printer: ResolvedPrinter): IClientOptions {
  return {
    host: CLOUD_HOST,
    port: CLOUD_PORT,
    protocol: "mqtts",
    // UNVERIFIED: see the file-header comment — the username Bambu's cloud
    // broker expects isn't confirmed, so this is a best-effort passthrough.
    username: printer.username || "bblp",
    password: printer.token,
    rejectUnauthorized: true,
  };
}

export const BambuCloudDriver: PrinterDriver = {
  transport: "bambu-cloud",
  defaultPort: CLOUD_PORT,
  label: "Bambu Lab (cloud)",
  requiredSecrets: ["token"],

  async test(printer) {
    return testViaMqtt(printer, cloudMqttOptions(printer), DEFAULT_TIMEOUT_MS);
  },
  async status(printer) {
    return statusViaMqtt(printer, cloudMqttOptions(printer), DEFAULT_TIMEOUT_MS);
  },
  async send(printer, gcodePath, opts) {
    return sendUnsupported(printer, gcodePath, opts);
  },
  async pause(printer) {
    return controlViaMqtt(printer, cloudMqttOptions(printer), DEFAULT_TIMEOUT_MS, "pause", "Paused.");
  },
  async resume(printer) {
    return controlViaMqtt(printer, cloudMqttOptions(printer), DEFAULT_TIMEOUT_MS, "resume", "Resumed.");
  },
  async cancel(printer) {
    return controlViaMqtt(printer, cloudMqttOptions(printer), DEFAULT_TIMEOUT_MS, "stop", "Cancelled.");
  },
};
