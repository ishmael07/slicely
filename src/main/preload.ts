// ─────────────────────────────────────────────────────────────────────────────
// The preload bridge — the whole of it.
//
// This file used to be the Mac app's API: chat, settings, printers, sourcing,
// jobs, forty-odd channels mirroring the HTTP API one module over. The window
// now loads the web client, which speaks HTTP like every other browser, so all
// of that is gone and what is left is the four things a web page cannot do on
// macOS and nothing else:
//
//   • open a sliced G-code in PrusaSlicer's viewer,
//   • reveal it in Finder,
//   • ask for files through the native open dialog,
//   • learn the real on-disk path of a dropped file.
//
// Four, and no fifth: a channel nobody calls is still a channel a compromised
// page can call, so anything the client does not use is not exposed. (Two were
// removed in fix round 1 for exactly that reason — an "open in the editor" call
// no button ever invoked, and a synchronous `version()` nothing displayed.)
//
// TOKENS, NOT PATHS. The first two take the opaque G-code token the server
// already handed the page; the main process resolves it against this session's
// own registry (see main.ts). The page therefore cannot ask macOS to open
// `/etc/passwd`, or anything else it wasn't given — a path it makes up resolves
// to nothing.
//
// Runs in an isolated, sandboxed context: `contextIsolation: true`,
// `sandbox: true`, `nodeIntegration: false`. The only things reachable from
// here are Electron's own renderer-side APIs, which is exactly enough.
// ─────────────────────────────────────────────────────────────────────────────
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/types";
import type { SlicelyDesktopApi } from "../shared/types";

const api: SlicelyDesktopApi = {
  openGcode: (token) => ipcRenderer.invoke(IPC.openGcode, token),
  revealGcode: (token) => ipcRenderer.invoke(IPC.revealGcode, token),
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),

  // The one place a real path crosses the bridge, and it crosses OUTWARD: the
  // browser knows these files only as opaque `File` handles, so on the desktop
  // the client hands their paths to POST /api/attach-local and the server copies
  // them in from disk instead of the page re-uploading bytes that are already on
  // this machine. Synchronous because a DataTransfer's files are only valid
  // during the drop event.
  pathsForDrop: (files) => {
    const out: string[] = [];
    for (const file of files) {
      try {
        const path = webUtils.getPathForFile(file);
        if (path) out.push(path);
      } catch {
        // Not a real file (a dragged image from a web page, say) — the client
        // falls back to the ordinary multipart upload for whatever is left.
      }
    }
    return out;
  },
};

contextBridge.exposeInMainWorld("slicely", api);
