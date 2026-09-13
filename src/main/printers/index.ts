// Print transport façade — the ONLY module other parts of Slicely (the
// agent, the IPC bridge, the web server) should import from this directory.
// It wires together the registry (persistence) and the per-transport drivers
// (network clients) behind the exact function signatures other in-flight
// work is coding against.
//
// ── SAFETY: the auto-start gate ─────────────────────────────────────────────
// Starting a print on a bed that still holds the previous part can damage the
// printer and is a genuine fire risk. No consumer FDM printer reliably
// senses whether its bed is actually clear. Because of that, sendToPrinter()
// enforces one rule that must NEVER be "simplified away":
//
//   startImmediately may become true ONLY when BOTH:
//     (a) the caller explicitly asked for it (opts.startImmediately === true), AND
//     (b) isAutoStartArmed(id) is true for THIS SPECIFIC printer.
//
// Arming is a per-printer, explicit, persisted opt-in (setAutoStart) — it is
// never inferred, never defaulted on, and never implied by any other setting.
// If a caller asks to start but the printer isn't armed, the file still
// uploads (so nothing is lost) and the result says started:false with a
// message explaining exactly how to arm it. Do not "helpfully" start the
// print anyway, do not arm a printer implicitly on first use, and do not let
// a batch/automation code path bypass this by calling a driver directly —
// always go through sendToPrinter.
import type {
  DiscoveredPrinter,
  PrinterConnection,
  PrinterDriver,
  PrinterSecrets,
  PrinterStatus,
  PrinterTestResult,
  PrinterTransport,
  ResolvedPrinter,
  SendJobOptions,
  SendJobResult,
} from "../../shared/printers";
import { basename } from "node:path";
import * as registry from "./registry";
import { discoverPrinters as runDiscovery } from "./discovery";
import { assertAllowedOutputDir, describeError, nowIso, safeJobName } from "./util";
import { isHosted } from "../mode";
import { WireError } from "../../server/errors";
import { octoprintDriver } from "./drivers/octoprint";
import { moonrakerDriver } from "./drivers/moonraker";
import { prusalinkDriver } from "./drivers/prusalink";
import { prusaConnectDriver } from "./drivers/prusaconnect";
import { BambuLanDriver, BambuCloudDriver } from "./drivers/bambu";
import { fileDriver } from "./drivers/file";

const DRIVERS: Record<PrinterTransport, PrinterDriver> = {
  octoprint: octoprintDriver,
  moonraker: moonrakerDriver,
  prusalink: prusalinkDriver,
  "prusa-connect": prusaConnectDriver,
  "bambu-lan": BambuLanDriver,
  "bambu-cloud": BambuCloudDriver,
  file: fileDriver,
};

function driverFor(transport: PrinterTransport): PrinterDriver {
  return DRIVERS[transport];
}

/** A stand-in for `driver.test()`. */
export type ConnectionProbe = (printer: ResolvedPrinter) => Promise<PrinterTestResult>;

/**
 * Replace the driver probe every `testPrinter()` (and therefore `addPrinter()`)
 * call makes. TESTS ONLY: an HTTP-level test needs to add a printer without a
 * real printer — or any network — on the other end, and stubbing global
 * `fetch` isn't available to a test that is itself talking HTTP to the server
 * under test. Production never calls this; `createApp`'s `printerTestOverride`
 * is the only caller, and that option exists for the same reason.
 */
let probeOverride: ConnectionProbe | undefined;
export function setConnectionTestOverride(fn: ConnectionProbe | undefined): void {
  probeOverride = fn;
}

/** Every configured printer, secrets stripped. */
export async function listPrinters(): Promise<PrinterConnection[]> {
  return registry.listConnections();
}

export async function getPrinter(id: string): Promise<PrinterConnection | undefined> {
  return registry.getConnection(id);
}

/**
 * Add a printer and immediately probe it. Anything the probe discovers about
 * the printer's geometry (bed size, nozzle, filament slots, model) is merged
 * back onto the saved connection, so a successful add is immediately usable
 * for slicing without a second round trip through settings.
 */
export async function addPrinter(
  input: Omit<PrinterConnection, "id"> & PrinterSecrets,
): Promise<{ printer: PrinterConnection; test: PrinterTestResult }> {
  const printer = registry.addConnection(checkOutputDir(input.transport, input));
  const test = await testPrinter(printer.id);

  const patch: Partial<PrinterConnection> = {};
  if (test.ok) patch.lastSeenAt = nowIso();
  if (test.discovered?.model) patch.model = test.discovered.model;
  if (test.discovered?.bed) patch.bed = test.discovered.bed;
  if (test.discovered?.nozzleMm) patch.nozzleMm = test.discovered.nozzleMm;
  if (test.discovered?.filamentSlots) patch.filamentSlots = test.discovered.filamentSlots;

  const finalPrinter = Object.keys(patch).length > 0 ? registry.updateConnection(printer.id, patch) : printer;
  return { printer: finalPrinter, test };
}

export async function updatePrinter(
  id: string,
  patch: Partial<PrinterConnection & PrinterSecrets>,
): Promise<PrinterConnection> {
  const transport = patch.transport ?? registry.getConnection(id)?.transport;
  return registry.updateConnection(id, checkOutputDir(transport, patch));
}

/**
 * Validate the "file" transport's destination folder before it is ever stored.
 *
 * `outputDir` is the one connection field that is a filesystem capability: the
 * driver copies a file into it. So it is checked HERE, at save time — a
 * validated record is worth more than a check deferred to every send — and
 * normalised to its resolved form so there is exactly one spelling on disk.
 * The "file" transport is desktop-only (a hosted server's folders are not the
 * visitor's), which `assertAllowedOutputDir` enforces; a `file` printer with no
 * folder at all is refused the same way, so hosted mode can't hold one.
 * Returns the input (with the resolved directory) so callers can pass it
 * straight to the registry.
 */
function checkOutputDir<T extends { outputDir?: string }>(
  transport: PrinterTransport | undefined,
  input: T,
): T {
  if (transport !== "file" && input.outputDir === undefined) return input;
  if (transport === "file" && isHosted()) {
    throw new WireError(403, "Saving to a folder only works in the Mac app.", "forbidden_in_hosted_mode");
  }
  if (typeof input.outputDir !== "string" || input.outputDir.trim().length === 0) return input;
  return { ...input, outputDir: assertAllowedOutputDir(input.outputDir) };
}

export async function removePrinter(id: string): Promise<void> {
  registry.removeConnection(id);
}

/** Probe reachability + credentials. Driver.test() is contracted never to
 *  throw; the try/catch is defense-in-depth against a driver bug. */
export async function testPrinter(id: string): Promise<PrinterTestResult> {
  const printer = registry.resolve(id);
  const driver = driverFor(printer.transport);
  const probe: ConnectionProbe = probeOverride ?? ((p) => driver.test(p));
  try {
    return await probe(printer);
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

/** Live status for one printer. Updates lastSeenAt when the printer actually
 *  answered (not on "offline"/"unknown", which mean it didn't). */
export async function printerStatus(id: string): Promise<PrinterStatus> {
  const printer = registry.resolve(id);
  const driver = driverFor(printer.transport);
  try {
    const status = await driver.status(printer);
    if (status.state !== "offline" && status.state !== "unknown") {
      registry.updateConnection(id, { lastSeenAt: nowIso() });
    }
    return status;
  } catch (err) {
    return { id, state: "offline", observedAt: nowIso(), message: describeError(err) };
  }
}

/** Status for every enabled printer, fetched concurrently. */
export async function allStatuses(): Promise<PrinterStatus[]> {
  const printers = registry.listConnections().filter((p) => p.enabled !== false);
  return Promise.all(printers.map((p) => printerStatus(p.id)));
}

/**
 * Upload a G-code file to a printer, and — ONLY if the safety gate above
 * allows it — start it. See the file-header comment; this function is the
 * one and only place that gate is enforced, so every caller (agent, IPC,
 * HTTP route) automatically gets the same safety behavior no matter how it
 * asks.
 */
export async function sendToPrinter(
  id: string,
  gcodePath: string,
  opts: Partial<SendJobOptions> = {},
): Promise<SendJobResult> {
  const printer = registry.resolve(id);
  const driver = driverFor(printer.transport);

  const requestedStart = opts.startImmediately === true;
  const armed = registry.isAutoStartArmed(id);
  const finalOpts: SendJobOptions = {
    startImmediately: requestedStart && armed,
    // The job name becomes a filename on a printer or in a folder, so it is
    // sanitised HERE, once, for every transport — no driver has to remember
    // (see safeJobName). The G-code's own basename is the fallback.
    jobName: safeJobName(opts.jobName, basename(gcodePath)),
  };

  let result: SendJobResult;
  try {
    result = await driver.send(printer, gcodePath, finalOpts);
  } catch (err) {
    return { ok: false, started: false, message: describeError(err) };
  }

  if (requestedStart && !armed && result.ok) {
    // The upload succeeded but the safety gate held — say exactly why, and
    // exactly how to change it, rather than silently downgrading to "queued".
    result = {
      ...result,
      started: false,
      message: `${result.message} Auto-start is off for this printer — call setAutoStart to arm it once you've confirmed the bed is clear.`,
    };
  }

  return result;
}

/** Pause/resume/cancel the active job. Not every transport supports every
 *  action (see each driver's file header for what's implemented). */
export async function controlPrinter(id: string, action: "pause" | "resume" | "cancel"): Promise<SendJobResult> {
  const printer = registry.resolve(id);
  const driver = driverFor(printer.transport);
  const fn = driver[action];
  if (!fn) {
    return { ok: false, started: false, message: `${driver.label} doesn't support ${action}.` };
  }
  try {
    return await fn.call(driver, printer);
  } catch (err) {
    return { ok: false, started: false, message: describeError(err) };
  }
}

/** LAN discovery, minus printers already configured (same transport + host +
 *  port) — the picker shouldn't re-suggest a printer the user already added. */
export async function discoverPrinters(timeoutMs?: number): Promise<DiscoveredPrinter[]> {
  const results = await runDiscovery(timeoutMs);
  const existing = new Set(
    registry.listConnections().map((p) => `${p.transport}:${p.host ?? ""}:${p.port ?? ""}`),
  );
  return results.filter((r) => !existing.has(`${r.transport}:${r.host}:${r.port}`));
}

export function getActivePrinterId(): string | undefined {
  return registry.getActiveId();
}

export async function setActivePrinter(id: string | undefined): Promise<void> {
  registry.setActiveId(id);
}

/** Arm or disarm unattended auto-start for one printer. This is the ONLY way
 *  sendToPrinter's startImmediately can ever take effect — see the
 *  file-header safety comment. */
export async function setAutoStart(id: string, armed: boolean): Promise<void> {
  registry.setAutoStart(id, armed);
}

export function isAutoStartArmed(id: string): boolean {
  return registry.isAutoStartArmed(id);
}

/** Everything the setup UI needs to render the transport picker, without
 *  reaching into individual driver modules. */
export function driverLabels(): Array<{
  transport: PrinterTransport;
  label: string;
  defaultPort: number;
  requiredSecrets: string[];
}> {
  return Object.values(DRIVERS).map((d) => ({
    transport: d.transport,
    label: d.label,
    defaultPort: d.defaultPort,
    requiredSecrets: [...d.requiredSecrets],
  }));
}
