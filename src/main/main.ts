// ─────────────────────────────────────────────────────────────────────────────
// Electron main process — ONE UI.
//
// The Mac app is the web app. It boots the same Express server the hosted
// deployment runs (in-process, on a random loopback port, in desktop mode) and
// loads the same client into a BrowserWindow. There is no second UI, no second
// copy of the chat transcript, no IPC-shaped clone of the REST API: the window
// talks to the server over HTTP exactly as a browser does, so every feature
// exists once and every fix lands once.
//
// What is left here is the part a browser genuinely cannot do:
//   • start and own the server process,
//   • keep other local processes off that loopback port (the launch token),
//   • decide what the window is allowed to navigate to,
//   • and the handful of native actions the preload bridge exposes (Task E2).
// ─────────────────────────────────────────────────────────────────────────────
import "./desktop-env"; // FIRST: sets SLICELY_MODE / SLICELY_WORKDIR (see the file)
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startServer } from "../server/index";
import { CSP_STRING } from "../server/security";
import type { SessionStore } from "../server/session";
import { sessionState } from "./agent/state";

let win: BrowserWindow | null = null;
/** Set once the server is listening; every window loads exactly this origin. */
let serverUrl = "";
let store: SessionStore | null = null;

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 600,
    // The client draws its own header (see styles.css's `body.is-desktop`), so
    // the traffic lights float over it instead of sitting in a title bar.
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0b0c",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      // The page is ordinary web content now, so it gets the posture ordinary
      // web content gets: no Node, no shared world with the preload, and a
      // sandboxed renderer process.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // A link in the transcript (a model's page on Printables, the PrusaSlicer
  // download) belongs in the user's own browser, not in a second window of an
  // app that is one window by design.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });

  // The window may only ever be our own origin. Anything else — an injected
  // redirect, a stray `location.href` — is refused and handed to the browser.
  win.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(serverUrl)) return;
    event.preventDefault();
    if (/^https?:/.test(target)) void shell.openExternal(target);
  });

  // The agent's `open_in_browser` tool. Set on the main process (not over IPC)
  // because the tool runs HERE, inside the server this process is hosting, in
  // the default session — which is the desktop session (see
  // SessionStore.desktopSession).
  sessionState.openExternal = (target: string) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
  };

  win.on("closed", () => {
    win = null;
  });

  void win.loadURL(url);
}

async function boot(): Promise<void> {
  // A fresh secret per launch, held only in this process's memory and in the
  // window's cookie jar. See server/desktop-token.ts for what it's for.
  const desktopToken = randomBytes(24).toString("hex");

  const started = await startServer({ host: "127.0.0.1", port: 0, desktopToken });
  store = started.store;
  serverUrl = started.url;

  // The same Content-Security-Policy the server sends, applied at the Electron
  // layer as well: a response that somehow reaches the window without passing
  // through Express (an error page, a devtools-injected resource) is covered
  // too, and the policy is stated from the one exported string rather than
  // written out a second time.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP_STRING],
      },
    });
  });

  // BEFORE loadURL, and deliberately not in the URL: a token in a query string
  // ends up in the window title, in history, and in any error report that
  // echoes the address. httpOnly keeps it out of reach of the page's own
  // JavaScript, so an XSS in the client cannot read it back out.
  await session.defaultSession.cookies.set({
    url: serverUrl,
    name: "slicely_desktop",
    value: desktopToken,
    httpOnly: true,
    sameSite: "strict",
  });

  createWindow(serverUrl);
}

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (err) {
    // Nothing useful can happen without the server: no window, no UI. Say so
    // plainly and quit, rather than showing an empty frame forever.
    dialog.showErrorBox(
      "Slicely couldn't start",
      `The local Slicely server failed to start.\n\n${(err as Error).message ?? String(err)}`,
    );
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl);
  });
});

app.on("before-quit", () => {
  store?.stopSweep();
});

app.on("window-all-closed", () => {
  // Standard macOS behaviour for a utility app: quit with the last window
  // rather than lingering as a background agent (and a listening port).
  app.quit();
});
