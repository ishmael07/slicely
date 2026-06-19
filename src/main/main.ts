// Electron main process. Creates the frameless "chat rectangle" window, wires
// IPC between the renderer and the Slicely agent, and bridges browser/slicer
// side effects.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/types";
import type { AgentEvent } from "../shared/types";
import { configState } from "./config";
import { sessionState } from "./agent/state";
import { SlicelyAgent } from "./agent/agent";
import { getStatus, openInGui } from "./prusaslicer";

let win: BrowserWindow | null = null;
let agent: SlicelyAgent | null = null;

// Window dimensions — a tall, narrow chat bar, not a full app window.
const WIN_WIDTH = 440;
const WIN_HEIGHT = 620;
const WIN_MIN_HEIGHT = 240;
const WIN_MAX_HEIGHT = 900;

function createWindow(): void {
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 380,
    maxWidth: 560,
    minHeight: WIN_MIN_HEIGHT,
    maxHeight: WIN_MAX_HEIGHT,
    frame: false,
    titleBarStyle: "hiddenInset",
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(join(__dirname, "../renderer/index.html"));

  // Let the agent open external URLs (open_in_browser tool) in the system browser.
  sessionState.openExternal = (url: string) => {
    void shell.openExternal(url);
  };

  win.on("closed", () => {
    win = null;
  });
}

function emitToRenderer(event: AgentEvent): void {
  win?.webContents.send(IPC.agentEvent, event);
}

function getAgent(): SlicelyAgent {
  if (!agent) agent = new SlicelyAgent();
  return agent;
}

function registerIpc(): void {
  // Renderer → agent: a user message. Streams events back via IPC.agentEvent.
  ipcMain.handle(IPC.sendMessage, async (_e, message: string) => {
    try {
      await getAgent().send(message, emitToRenderer);
    } catch (err) {
      emitToRenderer({
        type: "error",
        message: (err as Error).message ?? String(err),
      });
      emitToRenderer({ type: "done" });
    }
  });

  ipcMain.on(IPC.cancel, () => {
    agent?.cancel();
  });

  ipcMain.handle(IPC.getStatus, async () => getStatus());

  ipcMain.handle(IPC.getConfigState, async () => configState());

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });

  // Direct "Open in slicer" actions from a card / metric-panel button.
  ipcMain.handle(IPC.importModel, async (_e, path: string) => {
    await openInGui(path);
  });
  ipcMain.handle(IPC.openSlicer, async (_e, path: string) => {
    await openInGui(path);
  });

  // Reveal a sliced G-code file in Finder.
  ipcMain.handle(IPC.revealPath, async (_e, path: string) => {
    if (path) shell.showItemInFolder(path);
  });

  // Renderer asks the window to grow/shrink to fit its content.
  ipcMain.on(IPC.resizeWindow, (_e, height: number) => {
    if (!win) return;
    const clamped = Math.max(
      WIN_MIN_HEIGHT,
      Math.min(Math.round(height), WIN_MAX_HEIGHT),
    );
    const [w] = win.getSize();
    win.setSize(w, clamped, false);
  });
}

// Poll PrusaSlicer status and push to the renderer only when it changes, so
// the UI's status pill reflects the user opening/closing PrusaSlicer live.
let lastStatusKey = "";
let statusTimer: ReturnType<typeof setInterval> | null = null;

function startStatusPolling(): void {
  const tick = async () => {
    if (!win) return;
    try {
      const status = await getStatus();
      const key = `${status.installed}|${status.running}|${status.version ?? ""}`;
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        emitToRenderer({ type: "status", status });
      }
    } catch {
      /* transient; try again next tick */
    }
  };
  void tick();
  statusTimer = setInterval(tick, 4000);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startStatusPolling();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  if (statusTimer) clearInterval(statusTimer);
});

app.on("window-all-closed", () => {
  // Standard macOS behaviour: quit when all windows close (this is a utility
  // app, not a background agent).
  app.quit();
});
