// Preload bridge. Runs in an isolated context with access to Node, and exposes
// a minimal, typed API to the renderer via contextBridge — the renderer itself
// has no Node access.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import type {
  AgentEvent,
  SlicelyApi,
  PrinterConnection,
  PrinterStatus,
  JobEvent,
} from "../shared/types";

const api: SlicelyApi = {
  sendMessage: (message) => ipcRenderer.invoke(IPC.sendMessage, message),
  cancel: () => ipcRenderer.send(IPC.cancel),
  onAgentEvent: (handler) => {
    const listener = (_e: unknown, event: AgentEvent) => handler(event);
    ipcRenderer.on(IPC.agentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
  },
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  getConfigState: () => ipcRenderer.invoke(IPC.getConfigState),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openInSlicer: (path) => ipcRenderer.invoke(IPC.importModel, path),
  revealPath: (path) => ipcRenderer.invoke(IPC.revealPath, path),
  openSlicer: (path) => ipcRenderer.invoke(IPC.openSlicer, path),
  openGcode: (path) => ipcRenderer.invoke(IPC.openGcode, path),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  updatePreferences: (patch) =>
    ipcRenderer.invoke(IPC.updatePreferences, patch),
  pickFile: () => ipcRenderer.invoke(IPC.pickFile),
  uploadFiles: (paths) => ipcRenderer.invoke(IPC.uploadFiles, paths),
  resizeWindow: (height) => ipcRenderer.send(IPC.resizeWindow, height),

  // ── v2: printers ───────────────────────────────────────────────────────────
  listPrinters: () => ipcRenderer.invoke(IPC.listPrinters),
  addPrinter: (input) => ipcRenderer.invoke(IPC.addPrinter, input),
  updatePrinter: (id, patch) => ipcRenderer.invoke(IPC.updatePrinter, id, patch),
  removePrinter: (id) => ipcRenderer.invoke(IPC.removePrinter, id),
  testPrinter: (id) => ipcRenderer.invoke(IPC.testPrinter, id),
  printerStatuses: () => ipcRenderer.invoke(IPC.printerStatuses),
  sendToPrinter: (id, gcodePath, start) =>
    ipcRenderer.invoke(IPC.sendToPrinter, id, gcodePath, start),
  controlPrinter: (id, action) =>
    ipcRenderer.invoke(IPC.controlPrinter, id, action),
  discoverPrinters: (timeoutMs) =>
    ipcRenderer.invoke(IPC.discoverPrinters, timeoutMs),
  setActivePrinter: (id) => ipcRenderer.invoke(IPC.setActivePrinter, id),
  setAutoStart: (id, armed) => ipcRenderer.invoke(IPC.setAutoStart, id, armed),
  driverCatalog: () => ipcRenderer.invoke(IPC.driverCatalog),
  onPrinterEvent: (handler) => {
    const listener = (
      _e: unknown,
      payload: { printers: PrinterConnection[]; statuses: PrinterStatus[] },
    ) => handler(payload);
    ipcRenderer.on(IPC.printerEvent, listener);
    return () => ipcRenderer.removeListener(IPC.printerEvent, listener);
  },

  // ── v2: sourcing ───────────────────────────────────────────────────────────
  searchModels: (query) => ipcRenderer.invoke(IPC.searchModels, query),
  resolveUrl: (url) => ipcRenderer.invoke(IPC.resolveUrl, url),
  sourceAvailability: () => ipcRenderer.invoke(IPC.sourceAvailability),

  // ── v2: jobs ───────────────────────────────────────────────────────────────
  planJob: (parts, opts) => ipcRenderer.invoke(IPC.planJob, parts, opts),
  runJob: (jobId) => ipcRenderer.invoke(IPC.runJob, jobId),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs),
  getJob: (id) => ipcRenderer.invoke(IPC.getJob, id),
  cancelJob: (id) => ipcRenderer.invoke(IPC.cancelJob, id),
  onJobEvent: (handler) => {
    const listener = (_e: unknown, event: JobEvent) => handler(event);
    ipcRenderer.on(IPC.jobEvent, listener);
    return () => ipcRenderer.removeListener(IPC.jobEvent, listener);
  },
};

contextBridge.exposeInMainWorld("slicely", api);
