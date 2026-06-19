// Preload bridge. Runs in an isolated context with access to Node, and exposes
// a minimal, typed API to the renderer via contextBridge — the renderer itself
// has no Node access.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import type { AgentEvent, SlicelyApi } from "../shared/types";

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
  resizeWindow: (height) => ipcRenderer.send(IPC.resizeWindow, height),
};

contextBridge.exposeInMainWorld("slicely", api);
