// ─────────────────────────────────────────────────────────────────────────────
// v2 IPC surface: printers, sourcing, and jobs.
//
// Kept out of main.ts so that file stays about window lifecycle and the agent
// loop. Everything here is a thin, defensive wrapper: it validates what crosses
// the bridge, strips secrets on the way back, and never lets a printer being
// offline reject a renderer promise (the UI renders states, not exceptions).
// ─────────────────────────────────────────────────────────────────────────────
import { ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../shared/types";
import type { PrinterConnection, PrinterStatus, JobEvent } from "../shared/types";
// PrinterSecrets and JobPlanOptions are only meaningful to the main process, so
// they come straight from their contracts rather than the renderer-facing
// types.ts re-export.
import type { PrinterSecrets } from "../shared/printers";
import type { JobPlanOptions } from "../shared/jobs";
import {
  listPrinters,
  addPrinter,
  updatePrinter,
  removePrinter,
  testPrinter,
  printerStatus,
  allStatuses,
  sendToPrinter,
  controlPrinter,
  discoverPrinters,
  setActivePrinter,
  setAutoStart,
  isAutoStartArmed,
  driverLabels,
} from "./printers";
import {
  searchModels,
  resolveUrl,
  sourceAvailability,
} from "./sourcing";
import { planJob, runJob, getJob, listJobs, cancelJob } from "./jobs";

type GetWindow = () => BrowserWindow | null;

/** Push a payload to the renderer, tolerating a closed/destroyed window. */
function push(getWindow: GetWindow, channel: string, payload: unknown): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function registerV2Ipc(getWindow: GetWindow): void {
  // ── Printers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.listPrinters, async () => listPrinters());

  ipcMain.handle(
    IPC.addPrinter,
    async (_e, input: Omit<PrinterConnection, "id"> & PrinterSecrets) =>
      addPrinter(input),
  );

  ipcMain.handle(
    IPC.updatePrinter,
    async (_e, id: string, patch: Partial<PrinterConnection & PrinterSecrets>) =>
      updatePrinter(id, patch),
  );

  ipcMain.handle(IPC.removePrinter, async (_e, id: string) => {
    await removePrinter(id);
  });

  ipcMain.handle(IPC.testPrinter, async (_e, id: string) => testPrinter(id));

  ipcMain.handle(IPC.printerStatuses, async () => allStatuses());

  /**
   * SAFETY: `start` is only a request. The printers layer honours it solely
   * when the user has separately armed auto-start for that printer, so a
   * compromised or buggy renderer cannot begin an unattended print. We re-check
   * here as well — defence in depth — rather than trusting the flag.
   */
  ipcMain.handle(
    IPC.sendToPrinter,
    async (_e, id: string, gcodePath: string, start?: boolean) =>
      sendToPrinter(id, gcodePath, {
        startImmediately: start === true && isAutoStartArmed(id),
      }),
  );

  ipcMain.handle(
    IPC.controlPrinter,
    async (_e, id: string, action: "pause" | "resume" | "cancel") =>
      controlPrinter(id, action),
  );

  ipcMain.handle(IPC.discoverPrinters, async (_e, timeoutMs?: number) =>
    discoverPrinters(timeoutMs),
  );

  ipcMain.handle(IPC.setActivePrinter, async (_e, id: string | undefined) => {
    await setActivePrinter(id);
  });

  ipcMain.handle(IPC.setAutoStart, async (_e, id: string, armed: boolean) => {
    await setAutoStart(id, armed);
  });

  ipcMain.handle(IPC.driverCatalog, async () => driverLabels());

  // ── Sourcing ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.searchModels, async (_e, query: string) =>
    searchModels(query),
  );

  ipcMain.handle(IPC.resolveUrl, async (_e, url: string) => resolveUrl(url));

  ipcMain.handle(IPC.sourceAvailability, async () => sourceAvailability());

  // ── Jobs ───────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC.planJob,
    async (
      _e,
      parts: Array<{ path: string; copies?: number; colourHex?: string }>,
      opts: JobPlanOptions,
    ) => planJob(parts, opts),
  );

  // Job progress is streamed on IPC.jobEvent while the promise runs, so the UI
  // can show plate-by-plate progress on a job that takes minutes.
  ipcMain.handle(IPC.runJob, async (_e, jobId: string) =>
    runJob(jobId, (event: JobEvent) => push(getWindow, IPC.jobEvent, event)),
  );

  ipcMain.handle(IPC.listJobs, async () => listJobs());
  ipcMain.handle(IPC.getJob, async (_e, id: string) => getJob(id));
  ipcMain.handle(IPC.cancelJob, async (_e, id: string) => {
    await cancelJob(id);
  });
}

// ── Printer status polling ───────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastKey = "";

/** A cheap fingerprint of the printer world, so we only push on real change. */
function statusKey(printers: PrinterConnection[], statuses: PrinterStatus[]): string {
  return [
    printers.map((p) => `${p.id}:${p.label}`).join(","),
    statuses
      .map(
        (s) =>
          `${s.id}:${s.state}:${Math.round(s.progressPct ?? -1)}:${
            s.filaments?.map((f) => f.colourHex ?? "").join("|") ?? ""
          }`,
      )
      .join(","),
  ].join("||");
}

/**
 * Poll every connected printer and push to the renderer only when something
 * actually changed. Printers are polled rather than subscribed because the
 * transports disagree: MQTT pushes, REST does not. Polling normalizes that at
 * a cost of one cheap request per printer per interval.
 */
export function startPrinterPolling(getWindow: GetWindow, intervalMs = 5000): void {
  if (pollTimer) return;
  const tick = async (): Promise<void> => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      const [printers, statuses] = await Promise.all([
        listPrinters(),
        allStatuses(),
      ]);
      const key = statusKey(printers, statuses);
      if (key !== lastKey) {
        lastKey = key;
        push(getWindow, IPC.printerEvent, { printers, statuses });
      }
    } catch {
      // A polling failure is not user-visible: the UI keeps the last state.
    }
  };
  void tick();
  pollTimer = setInterval(() => void tick(), intervalMs);
}

export function stopPrinterPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Re-export so main.ts can surface a single printer's status if it needs to. */
export { printerStatus };
