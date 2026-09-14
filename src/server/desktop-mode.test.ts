// ─────────────────────────────────────────────────────────────────────────────
// Tests for desktop mode (Task E1): the launch token that keeps other local
// processes off the Mac app's loopback port, and the single workspace every
// request in that mode resolves to.
//
// Driven over real HTTP against the real app, because what is being tested is
// exactly what another process on the same machine can reach with a socket.
// Hermetic: a temp workdir, a temp-dir-backed store, an ephemeral port, no
// network, no Electron.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, startServer } from "./index";
import { SessionStore } from "./session";
import { DESKTOP_COOKIE, DESKTOP_HEADER } from "./desktop-token";
import { resetConfigForTests } from "../main/config";
import { DEFAULT_SESSION_ID } from "../main/session-context";

// Point every workdir-derived path (the cookie secret, `master.key`, the
// desktop session's own directory) at a temp tree before anything reads config.
const WORKDIR = mkdtempSync(join(tmpdir(), "slicely-desktop-work-"));
process.env.SLICELY_WORKDIR = WORKDIR;
resetConfigForTests();

const TOKEN = "t0ken-for-this-launch";

interface Harness {
  base: string;
  store: SessionStore;
}

/** Run `fn` against a fresh app in `mode`, with the desktop token option set
 *  (which hosted mode is expected to ignore). Everything is torn down after —
 *  the server closed, the sweeper stopped, the temp tree removed. */
async function withApp(
  mode: "hosted" | "desktop",
  fn: (h: Harness) => Promise<void>,
  opts: { desktopToken?: string } = { desktopToken: TOKEN },
): Promise<void> {
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  const root = mkdtempSync(join(tmpdir(), "slicely-desktop-"));
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    desktopDir: join(root, "desktop"),
    sweepIntervalMs: 0,
  });
  const app: Express = createApp({ sessionStore: store, desktopToken: opts.desktopToken });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
  }
}

const withCookie = { cookie: `${DESKTOP_COOKIE}=${TOKEN}` };
const withHeader = { [DESKTOP_HEADER]: TOKEN };

test("desktop: a request without the launch token is refused — the app shell included", async () => {
  await withApp("desktop", async ({ base }) => {
    // The API.
    const api = await fetch(`${base}/api/config`);
    assert.equal(api.status, 403);
    assert.deepEqual(await api.json(), { error: "Forbidden.", code: "forbidden" });

    // And the page itself: serving the client to a local port scanner while
    // refusing the API would be a strange place to draw the line.
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 403);
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 403);

    // A wrong token is no better than none.
    const wrong = await fetch(`${base}/api/config`, { headers: { [DESKTOP_HEADER]: "not-the-token" } });
    assert.equal(wrong.status, 403);
  });
});

test("desktop: the cookie main.ts sets before loadURL gets the window in", async () => {
  await withApp("desktop", async ({ base }) => {
    const shell = await fetch(`${base}/`, { headers: withCookie });
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<title>Slicely<\/title>/);

    const api = await fetch(`${base}/api/config`, { headers: withCookie });
    assert.equal(api.status, 200);
    const body = (await api.json()) as { mode?: string };
    assert.equal(body.mode, "desktop");
  });
});

test("desktop: the header carries the token too, for a caller that isn't a browser", async () => {
  await withApp("desktop", async ({ base }) => {
    const api = await fetch(`${base}/api/config`, { headers: withHeader });
    assert.equal(api.status, 200);
  });
});

test("desktop: every request resolves to the one workspace, at the workdir itself", async () => {
  await withApp("desktop", async ({ base, store }) => {
    // Two requests, no session cookie carried between them — on a hosted server
    // that is two visitors and two workspaces.
    await fetch(`${base}/api/config`, { headers: withHeader });
    await fetch(`${base}/api/printers`, { headers: withHeader });

    assert.equal(store.count(), 1, "the Mac app has exactly one workspace");
    const record = store.get(DEFAULT_SESSION_ID);
    assert.ok(record, "the desktop session IS the default session, so ambient state agrees with it");
    // Its directory is the workdir (here the injected test one), which is what
    // keeps settings.json / printers.json / jobs.json where Electron has always
    // written them.
    assert.match(record!.dir, /desktop$/);
    assert.equal(record!.uploadsDir, join(record!.dir, "uploads"));
  });
});

test("desktop: the token never leaves the server — /api/config doesn't carry it", async () => {
  await withApp("desktop", async ({ base }) => {
    const text = await (await fetch(`${base}/api/config`, { headers: withHeader })).text();
    assert.ok(!text.includes(TOKEN), "the launch token must never be in a client-visible payload");
  });
});

test("hosted: the desktop token option is ignored, not enforced", async () => {
  await withApp("hosted", async ({ base }) => {
    // Same option, passed in the same way. A hosted visitor has no token and
    // must still be served.
    assert.equal((await fetch(`${base}/`)).status, 200);
    const api = await fetch(`${base}/api/config`);
    assert.equal(api.status, 200);
    const body = (await api.json()) as { mode?: string };
    assert.equal(body.mode, "hosted");
  });
});

test("startServer binds the port the OS picks, on loopback, with the token required", async () => {
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  const root = mkdtempSync(join(tmpdir(), "slicely-desktop-boot-"));
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    desktopDir: join(root, "desktop"),
    sweepIntervalMs: 0,
  });
  const started = await startServer({ host: "127.0.0.1", port: 0, desktopToken: TOKEN, store });
  try {
    assert.ok(started.port > 0, "port 0 must resolve to a real port");
    assert.equal(started.url, `http://127.0.0.1:${started.port}`);

    assert.equal((await fetch(`${started.url}/api/config`)).status, 403);
    assert.equal((await fetch(`${started.url}/api/config`, { headers: withHeader })).status, 200);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
  }
});

after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});
