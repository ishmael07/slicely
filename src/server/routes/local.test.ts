// ─────────────────────────────────────────────────────────────────────────────
// Tests for POST /api/attach-local (Task E2) — the one endpoint that takes a
// filesystem path from a client, so the tests are mostly about what it REFUSES:
// the hosted mode it must never work in, a path outside the user's own folders,
// and a file that isn't a mesh.
//
// Hermetic: a temp workdir, a temp-dir-backed store, an ephemeral port, no
// network. The one file that has to live under `$HOME` (because that is the
// boundary being tested) is created in a temp directory there and removed
// afterwards.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../index";
import { DESKTOP_HEADER } from "../desktop-token";
import { SessionStore } from "../session";
import { resetConfigForTests } from "../../main/config";
import { DEFAULT_SESSION_ID } from "../../main/session-context";
import type { WorkspaceFile } from "../../shared/types";

const WORKDIR = mkdtempSync(join(tmpdir(), "slicely-attach-work-"));
process.env.SLICELY_WORKDIR = WORKDIR;
resetConfigForTests();

/** A real mesh file under the user's home directory — the only place the
 *  desktop boundary allows a by-path attach from. NOT dot-prefixed: hidden
 *  components are refused on purpose, which would make this a test of the wrong
 *  thing. */
const HOME_DIR = mkdtempSync(join(homedir(), "slicely-attach-test-"));

/** The desktop launch token this harness's app is built with. Hosted mode
 *  ignores it, which is why the same value can be sent in both modes. */
const TOKEN = "attach-local-test-token";

interface Harness {
  base: string;
  store: SessionStore;
  desktopDir: string;
}

async function withApp(mode: "hosted" | "desktop", fn: (h: Harness) => Promise<void>): Promise<void> {
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  const root = mkdtempSync(join(tmpdir(), "slicely-attach-"));
  const desktopDir = join(root, "desktop");
  const store = new SessionStore({
    sessionsRoot: root,
    secretDir: root,
    desktopDir,
    sweepIntervalMs: 0,
  });
  // Desktop mode refuses to build an app without a launch token (see
  // index.ts), so the harness mints one and every request below carries it.
  const server: Server = createServer(createApp({ sessionStore: store, desktopToken: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store, desktopDir });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
  }
}

async function attach(base: string, paths: unknown): Promise<Response> {
  // Boot first: in hosted mode GET /api/config is the only call that may mint a
  // workspace, so without its cookie /api/attach-local answers 401 `no_session`
  // and never reaches the refusal this file is about. (Desktop mode mints
  // nothing — there is one workspace and it already exists — so the cookie is
  // harmless there.)
  const boot = await fetch(`${base}/api/config`, { headers: { [DESKTOP_HEADER]: TOKEN } });
  const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
  return fetch(`${base}/api/attach-local`, {
    method: "POST",
    headers: { "content-type": "application/json", [DESKTOP_HEADER]: TOKEN, cookie },
    body: JSON.stringify({ paths }),
  });
}

/** A minimal but genuinely parseable ASCII STL, written where the test wants it. */
function writeStl(path: string): string {
  writeFileSync(
    path,
    [
      "solid cube",
      "facet normal 0 0 1",
      "  outer loop",
      "    vertex 0 0 0",
      "    vertex 1 0 0",
      "    vertex 0 1 0",
      "  endloop",
      "endfacet",
      "endsolid cube",
      "",
    ].join("\n"),
  );
  return path;
}

test("hosted: attaching a local path is refused — the disk isn't the visitor's", async () => {
  await withApp("hosted", async ({ base }) => {
    const stl = writeStl(join(HOME_DIR, "hosted-refused.stl"));
    const resp = await attach(base, [stl]);
    assert.equal(resp.status, 403);
    const body = (await resp.json()) as { code?: string };
    assert.equal(body.code, "forbidden_in_hosted_mode");
  });
});

test("desktop: a mesh under the user's home is copied into the session's uploads", async () => {
  await withApp("desktop", async ({ base, store, desktopDir }) => {
    const stl = writeStl(join(HOME_DIR, "bracket.stl"));
    const resp = await attach(base, [stl]);
    const text = await resp.text();
    assert.equal(resp.status, 200, text);

    // The wire shape is a WorkspaceFile: a name and a workspace-RELATIVE path,
    // never the absolute one (see toWorkspaceFile).
    const body = JSON.parse(text) as { uploaded?: WorkspaceFile[]; rejected?: string[] };
    assert.equal(body.uploaded?.length, 1);
    assert.equal(body.uploaded![0].name, "bracket.stl");
    assert.equal(body.uploaded![0].relPath, "uploads/bracket.stl");
    assert.equal(body.uploaded![0].sliceable, true);
    assert.ok(!text.includes(desktopDir), "no absolute server path may appear in the body");
    assert.deepEqual(body.rejected, []);

    // It really is in the workspace, and the original is untouched.
    const uploads = join(desktopDir, "uploads");
    assert.ok(readdirSync(uploads).includes("bracket.stl"), `uploads held ${readdirSync(uploads).join(", ")}`);
    assert.ok(existsSync(stl), "attaching must copy, not move, the user's own file");

    // And it became the active model, exactly as an upload would.
    const record = store.get(DEFAULT_SESSION_ID);
    assert.equal(record?.activeModelPaths.length, 1);
    assert.equal(record?.activeModelPaths[0], join(uploads, "bracket.stl"));
  });
});

test("desktop: a path outside the user's own folders is refused", async () => {
  await withApp("desktop", async ({ base }) => {
    // An accepted extension, so this is the containment check answering and not
    // the extension check: `/etc` is not the user's, whatever it is called.
    const resp = await attach(base, ["/etc/slicely-not-yours.stl"]);
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { code?: string; error?: string };
    assert.equal(body.code, "not_in_workspace");
    assert.ok(!(body.error ?? "").includes("/etc"), "an error must not echo a filesystem path");
  });
});

test("desktop: a hidden file in the user's home is refused too", async () => {
  await withApp("desktop", async ({ base }) => {
    const resp = await attach(base, [join(homedir(), ".ssh", "id_rsa.stl")]);
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { code?: string };
    assert.equal(body.code, "not_in_workspace");
  });
});

test("desktop: a file that isn't a mesh is refused before anything is read", async () => {
  await withApp("desktop", async ({ base, desktopDir }) => {
    const exe = join(HOME_DIR, "totally-a-model.exe");
    writeFileSync(exe, "MZ");
    const resp = await attach(base, [exe]);
    assert.equal(resp.status, 400);
    assert.match(((await resp.json()) as { error?: string }).error ?? "", /Unsupported file type/);
    assert.ok(!existsSync(join(desktopDir, "uploads", "totally-a-model.exe")));
  });
});

test("desktop: the batch is refused whole — one bad path attaches nothing", async () => {
  await withApp("desktop", async ({ base, desktopDir }) => {
    const good = writeStl(join(HOME_DIR, "good-part.stl"));
    const resp = await attach(base, [good, "/etc/passwd.stl"]);
    assert.equal(resp.status, 400);
    assert.ok(
      !existsSync(join(desktopDir, "uploads", "good-part.stl")),
      "a refused batch must not half-attach",
    );
  });
});

test("desktop: nonsense bodies are a bad request, not a crash", async () => {
  await withApp("desktop", async ({ base }) => {
    assert.equal((await attach(base, [])).status, 400);
    assert.equal((await attach(base, "not-an-array")).status, 400);
    assert.equal((await attach(base, [42])).status, 400);
    assert.equal((await attach(base, new Array(13).fill("/x.stl"))).status, 400);
  });
});

after(() => {
  rmSync(HOME_DIR, { recursive: true, force: true });
  rmSync(WORKDIR, { recursive: true, force: true });
});
