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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, startServer } from "./index";
import { SessionStore } from "./session";
import {
  DESKTOP_COOKIE,
  DESKTOP_HEADER,
  isAllowedDesktopHost,
  isLoopbackBindHost,
} from "./desktop-token";
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
  /** The real port, for the tests that have to write the `Host` header by hand. */
  port: number;
  store: SessionStore;
}

/** One GET over raw `node:http`, so the request's own `Host` header can be
 *  chosen. `fetch` derives Host from the URL and will not let a caller set it,
 *  which is exactly the header the DNS-rebinding guard is about. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
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
    await fn({ base: `http://127.0.0.1:${port}`, port, store });
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

// ── Fix round 1: desktop mode cannot run open ────────────────────────────────
//
// The guard used to be mounted only `if (opts.desktopToken)`, which meant the
// one configuration that most needs it — a real TCP port on a machine with other
// processes on it — was also the one that silently ran wide open if the caller
// forgot the option. There is no second identity in desktop mode to fall back
// to, so a missing token is a refusal to start.

/** Run `fn` with SLICELY_MODE set, restoring it afterwards. */
async function inMode(mode: "hosted" | "desktop", fn: () => Promise<void>): Promise<void> {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
}

test("desktop: createApp REFUSES to build an app with no launch token", async () => {
  await inMode("desktop", async () => {
    const root = mkdtempSync(join(tmpdir(), "slicely-desktop-notoken-"));
    const store = new SessionStore({
      sessionsRoot: root,
      secretDir: root,
      desktopDir: join(root, "desktop"),
      sweepIntervalMs: 0,
    });
    try {
      assert.throws(
        () => createApp({ sessionStore: store }),
        /desktop requires a per-launch desktop token/i,
        "an unguarded desktop app must not exist at all, let alone listen",
      );
    } finally {
      store.stopSweep();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("hosted: no token is required, because there is no token in hosted mode", async () => {
  await inMode("hosted", async () => {
    const root = mkdtempSync(join(tmpdir(), "slicely-hosted-notoken-"));
    const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
    try {
      assert.doesNotThrow(() => createApp({ sessionStore: store }));
    } finally {
      store.stopSweep();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("desktop: startServer refuses to bind anything but loopback", async () => {
  await inMode("desktop", async () => {
    const root = mkdtempSync(join(tmpdir(), "slicely-desktop-bind-"));
    const store = new SessionStore({
      sessionsRoot: root,
      secretDir: root,
      desktopDir: join(root, "desktop"),
      sweepIntervalMs: 0,
    });
    try {
      // Unset (= every interface, the container default), the wildcards, and a
      // plausible LAN address: each would publish one person's workspace, key
      // and printers to whatever network the Mac is on.
      for (const host of [undefined, "0.0.0.0", "::", "192.168.1.42", "example.com"]) {
        await assert.rejects(
          () => startServer({ host, port: 0, desktopToken: TOKEN, store }),
          /must bind a loopback interface/i,
          `host ${String(host)} must not be bound in desktop mode`,
        );
      }
      // And a missing token is refused here too, not only in createApp.
      await assert.rejects(
        () => startServer({ host: "127.0.0.1", port: 0, store }),
        /desktop requires a per-launch desktop token/i,
      );
    } finally {
      store.stopSweep();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Fix round 1: DNS-rebinding hardening ─────────────────────────────────────
//
// A page on the attacker's own domain can point that domain's DNS at 127.0.0.1
// and have the victim's browser send us requests that look same-origin to it.
// The token already stops those (the browser has no way to learn it), but a
// loopback server should not answer to somebody else's name in the first place.

test("desktop: a request under a rebound host name is refused, token or not", async () => {
  await withApp("desktop", async ({ port }) => {
    // The real thing, as the window sends it: allowed.
    const ok = await rawGet(port, "/api/config", { host: `127.0.0.1:${port}`, [DESKTOP_HEADER]: TOKEN });
    assert.equal(ok.status, 200);

    // The rebinding attack: our port, the attacker's name.
    for (const host of [`attack.evil.example:${port}`, "evil.example", `[::ffff:127.0.0.1]:${port}`]) {
      const bad = await rawGet(port, "/api/config", { host, [DESKTOP_HEADER]: TOKEN });
      assert.equal(bad.status, 403, `Host: ${host} must be refused`);
      assert.deepEqual(JSON.parse(bad.body), { error: "Forbidden.", code: "forbidden" });
    }

    // A loopback name with the wrong port is not this server either.
    const wrongPort = await rawGet(port, "/api/config", {
      host: `127.0.0.1:${port + 1}`,
      [DESKTOP_HEADER]: TOKEN,
    });
    assert.equal(wrongPort.status, 403);

    // The app shell is covered as well, not just the API.
    const shell = await rawGet(port, "/", { host: "evil.example", cookie: `${DESKTOP_COOKIE}=${TOKEN}` });
    assert.equal(shell.status, 403);
  });
});

test("hosted: the Host header is not policed — a hosted server has a real domain", async () => {
  await withApp("hosted", async ({ port }) => {
    const resp = await rawGet(port, "/api/config", { host: "slicely.example" });
    assert.equal(resp.status, 200);
  });
});

test("isLoopbackBindHost / isAllowedDesktopHost, as the two callers rely on them", () => {
  // What may be bound.
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("127.0.0.2"), true, "the whole 127/8 block is loopback");
  assert.equal(isLoopbackBindHost("::1"), true);
  assert.equal(isLoopbackBindHost("localhost"), true);
  assert.equal(isLoopbackBindHost(undefined), false, "unset means every interface");
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(isLoopbackBindHost("192.168.1.42"), false);
  assert.equal(isLoopbackBindHost("127.0.0.1.evil.example"), false);

  // What may be in a Host header, against a server on port 4321.
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321", 4321), true);
  assert.equal(isAllowedDesktopHost("localhost:4321", 4321), true);
  assert.equal(isAllowedDesktopHost("[::1]:4321", 4321), true);
  assert.equal(isAllowedDesktopHost("127.0.0.1:4322", 4321), false, "wrong port");
  assert.equal(isAllowedDesktopHost("127.0.0.1", 4321), false, "no port means 80");
  assert.equal(isAllowedDesktopHost("evil.example:4321", 4321), false);
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321@evil.example:4321", 4321), false, "userinfo");
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321/../x", 4321), false);
  // A FRAGMENT is not part of a host either. This one parses with our hostname
  // and our port and a hash nobody was looking at, so it used to pass — this
  // function answers "is this Host exactly ours", and ours-plus-something isn't.
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321#evil.example", 4321), false, "fragment");
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321#", 4321), false, "even an empty one");
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321?x=1", 4321), false, "query");
  assert.equal(isAllowedDesktopHost(undefined, 4321), false);
  assert.equal(isAllowedDesktopHost("not a host", 4321), false);
  assert.equal(isAllowedDesktopHost("127.0.0.1:4321", undefined), false, "no socket, no answer");
});

// ── Fix round 1: a malformed cookie is not a 500 ─────────────────────────────

test("a malformed percent-escape in the desktop cookie is refused, not a 500", async () => {
  await withApp("desktop", async ({ base }) => {
    // `decodeURIComponent("%zz")` throws a URIError, and the cookie parser runs
    // on the first middleware of EVERY request — so one junk cookie left in a
    // browser turned the whole app, shell included, into a 500.
    for (const cookie of [`${DESKTOP_COOKIE}=%zz`, `${DESKTOP_COOKIE}=%`, `${DESKTOP_COOKIE}=100%`]) {
      const api = await fetch(`${base}/api/config`, { headers: { cookie } });
      assert.equal(api.status, 403, `cookie ${cookie} must be a plain refusal`);
      const shell = await fetch(`${base}/`, { headers: { cookie } });
      assert.equal(shell.status, 403);
    }

    // And a valid token still gets in when a junk cookie rides alongside it.
    const ok = await fetch(`${base}/api/config`, {
      headers: { cookie: `junk=%zz; ${DESKTOP_COOKIE}=${TOKEN}` },
    });
    assert.equal(ok.status, 200);
  });
});

// ── Fix round 1: "delete my data" takes the print queue with it ──────────────

test("desktop: destroy() removes jobs.json and keeps the app's configuration", async () => {
  await withApp("desktop", async ({ base, store }) => {
    // A request first, so the one desktop session exists the way it does in the
    // app rather than only in the store's constructor.
    assert.equal((await fetch(`${base}/api/config`, { headers: withHeader })).status, 200);
    const session = store.get(DEFAULT_SESSION_ID);
    assert.ok(session);

    const file = (name: string) => join(session!.dir, name);
    // Personal data, all of it named here rather than deleted by wildcard.
    writeFileSync(file("jobs.json"), JSON.stringify([{ id: "j1", name: "bracket.stl" }]));
    writeFileSync(file("secrets.json"), "{}");
    writeFileSync(join(session!.uploadsDir, "bracket.stl"), "solid x\nendsolid x\n");
    // Configuration the app needs to keep working.
    writeFileSync(file("settings.json"), "{}");
    writeFileSync(file("printers.json"), "[]");

    await store.destroy(DEFAULT_SESSION_ID);

    assert.equal(existsSync(file("jobs.json")), false, "the print queue names every model and G-code path");
    assert.equal(existsSync(file("secrets.json")), false);
    assert.equal(existsSync(join(session!.uploadsDir, "bracket.stl")), false);
    assert.equal(existsSync(file("settings.json")), true, "settings are configuration, not personal data");
    assert.equal(existsSync(file("printers.json")), true);
    assert.equal(existsSync(session!.dir), true, "the desktop workspace IS userData — it cannot be removed");
  });
});

after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});
