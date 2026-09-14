// ─────────────────────────────────────────────────────────────────────────────
// POST /api/slice and GET /api/preview — what they say a file is, and what they
// say when it isn't there.
//
// Three separate defects live here, all of them about the SHAPE of a reference
// rather than about slicing:
//
//   • `/api/slice`'s `info` described a model by `displayName` alone, while
//     `/api/upload` described the same model by `relPath`. Two endpoints, two
//     vocabularies, and only one of them can drive the 3D viewer — a caller that
//     had just sliced could not preview what it sliced without asking again.
//   • `/api/preview` for a file that is gone answered 500 "Something went
//     wrong". It leaked nothing, but it is the wrong sentence: a client cannot
//     tell "your session lost that file" from "the server is broken".
//   • The subtree rule (uploads/downloads/slices only) was asked of the
//     caller's SPELLING, so it bound the relative form and skipped the absolute
//     one — and `<session.dir>/secrets.json` is inside the session. That is the
//     encrypted Anthropic key, and `/api/preview` reads file contents.
//
// Hermetic: an ephemeral server, a temp session store, and a shell script on
// PRUSASLICER_PATH standing in for the slicer.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore } from "../session";
import { resetConfigForTests } from "../../main/config";

/** The smallest STL that parses as a real mesh — both `--info` (faked) and
 *  `previewMesh` (real) have to be able to read it. */
const ONE_FACET_STL = [
  "solid cube",
  "  facet normal 0 0 1",
  "    outer loop",
  "      vertex 0 0 0",
  "      vertex 1 0 0",
  "      vertex 0 1 0",
  "    endloop",
  "  endfacet",
  "endsolid cube",
  "",
].join("\n");

const FAKE_SLICER = `#!/bin/sh
out=""
info=0
prev=""
for a in "$@"; do
  [ "$a" = "--info" ] && info=1
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
if [ "$info" = "1" ]; then
  echo "size_x = 20.000000"
  echo "size_y = 20.000000"
  echo "size_z = 20.000000"
  echo "number_of_facets = 1"
  echo "manifold = yes"
  exit 0
fi
if [ -n "$out" ]; then
  {
    echo "; fake slicer"
    echo "; estimated printing time (normal mode) = 9m"
    echo "; total filament used [g] = 1.5"
  } > "$out"
fi
exit 0
`;

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Rig {
  base: string;
  cookie: string;
  sessionDir: string;
  root: string;
  close: () => Promise<void>;
}

/** A booted session with `uploads/cube.stl` in it and a fake slicer installed. */
async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "slicely-slice-route-"));
  const fake = join(root, "fake-prusaslicer");
  writeFileSync(fake, FAKE_SLICER);
  chmodSync(fake, 0o755);
  const prevBin = process.env.PRUSASLICER_PATH;
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  const prevConfig = process.env.PRUSASLICER_CONFIG_INI;
  process.env.PRUSASLICER_PATH = fake;
  process.env.SLICELY_WORKDIR = root;
  delete process.env.PRUSASLICER_CONFIG_INI;
  resetConfigForTests();

  const store = new SessionStore({ sessionsRoot: join(root, "sessions"), secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  const boot = await fetch(`${base}/api/config`);
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";")[0];
  const session = store.get(decodeURIComponent(cookie.split("=")[1]).split(".")[0])!;
  writeFileSync(join(session.uploadsDir, "cube.stl"), ONE_FACET_STL);
  // The real thing this guard exists for. Written so "it is unreachable" is a
  // statement about a file that is actually there.
  writeFileSync(join(session.dir, "secrets.json"), '{"ciphertext":"nope"}');

  return {
    base,
    cookie,
    sessionDir: session.dir,
    root,
    close: async () => {
      await close();
      store.stopSweep();
      if (prevBin === undefined) delete process.env.PRUSASLICER_PATH;
      else process.env.PRUSASLICER_PATH = prevBin;
      if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
      else process.env.SLICELY_WORKDIR = prevWorkdir;
      if (prevConfig === undefined) delete process.env.PRUSASLICER_CONFIG_INI;
      else process.env.PRUSASLICER_CONFIG_INI = prevConfig;
      resetConfigForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("POST /api/slice describes the model the same way /api/upload does", async () => {
  const r = await rig();
  try {
    const resp = await fetch(`${r.base}/api/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: r.cookie },
      body: JSON.stringify({ paths: ["uploads/cube.stl"] }),
    });
    const raw = await resp.text();
    assert.equal(resp.status, 200, raw);
    const body = JSON.parse(raw) as {
      info: { relPath?: string; displayName?: string; filePath?: string };
      plates: Array<{ gcodeId?: string; displayName?: string; gcodePath?: string }>;
    };

    // The same reference /api/upload hands out, and the same one /api/preview
    // takes back — so a caller that sliced can drive the viewer from this body.
    assert.equal(body.info.relPath, "uploads/cube.stl");
    // Kept alongside, because it is the name a person reads.
    assert.equal(body.info.displayName, "cube.stl");
    assert.equal(body.info.filePath, undefined, "the absolute path stays on the server");
    assert.ok(body.plates[0].gcodeId, "the output is addressed by token");
    assert.equal(body.plates[0].gcodePath, undefined);
    for (const needle of ["/Users", "/private", r.root, r.sessionDir]) {
      assert.ok(!raw.includes(needle), `the slice body leaks ${needle}:\n${raw}`);
    }

    // And the round trip the two endpoints now share.
    const preview = await fetch(
      `${r.base}/api/preview?path=${encodeURIComponent(body.info.relPath!)}`,
      { headers: { cookie: r.cookie } },
    );
    assert.equal(preview.status, 200, await preview.text());
  } finally {
    await r.close();
  }
});

test("GET /api/preview for a file that is gone is 404 not_found, not 500", async () => {
  const r = await rig();
  try {
    const resp = await fetch(`${r.base}/api/preview?path=uploads/never-uploaded.stl`, {
      headers: { cookie: r.cookie },
    });
    const raw = await resp.text();
    assert.equal(resp.status, 404, raw);
    const body = JSON.parse(raw) as { error: string; code?: string };
    assert.equal(body.code, "not_found");
    // Still no layout: "gone" is the whole of what a caller can act on.
    assert.ok(!raw.includes(r.sessionDir), raw);

    // A path that is not in the workspace at all keeps its own answer — the two
    // cases must stay distinguishable for the client, and indistinguishable to
    // anyone probing for another session's files (that one names nothing).
    const outside = await fetch(`${r.base}/api/preview?path=${encodeURIComponent("/etc/passwd")}`, {
      headers: { cookie: r.cookie },
    });
    assert.equal(outside.status, 400);
    assert.equal(((await outside.json()) as { code?: string }).code, "not_in_workspace");
  } finally {
    await r.close();
  }
});

test("the uploads/downloads/slices rule binds an ABSOLUTE path too", async () => {
  const r = await rig();
  try {
    // Inside the session, so containment said yes — and it is the encrypted
    // Anthropic key. Spelled relatively (`uploads/../secrets.json`) this was
    // already refused; spelled absolutely it was not.
    for (const name of ["secrets.json", "printer-secrets.json", ".session-secret", "settings.json"]) {
      const abs = join(r.sessionDir, name);
      const resp = await fetch(`${r.base}/api/preview?path=${encodeURIComponent(abs)}`, {
        headers: { cookie: r.cookie },
      });
      const raw = await resp.text();
      assert.equal(resp.status, 400, `${name} must be refused, got ${resp.status}: ${raw}`);
      assert.equal((JSON.parse(raw) as { code?: string }).code, "not_in_workspace");
    }

    // Nor is the session's own top level addressable as a directory.
    const dirResp = await fetch(`${r.base}/api/preview?path=${encodeURIComponent(r.sessionDir)}`, {
      headers: { cookie: r.cookie },
    });
    assert.equal(dirResp.status, 400);

    // And the legitimate absolute form still works, so this is a subtree rule
    // and not a ban on absolute paths (the desktop's attach-local flow sends
    // them, and older clients did too).
    const ok = await fetch(
      `${r.base}/api/preview?path=${encodeURIComponent(join(r.sessionDir, "uploads", "cube.stl"))}`,
      { headers: { cookie: r.cookie } },
    );
    assert.equal(ok.status, 200, await ok.text());

    // Same rule on the slicing door, which runs the file through PrusaSlicer.
    const slice = await fetch(`${r.base}/api/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: r.cookie },
      body: JSON.stringify({ paths: [join(r.sessionDir, "secrets.json")] }),
    });
    assert.equal(slice.status, 400);
    assert.equal(((await slice.json()) as { code?: string }).code, "not_in_workspace");
  } finally {
    await r.close();
  }
});
