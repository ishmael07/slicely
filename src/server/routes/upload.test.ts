// Tests for POST /api/upload: the ACCEPTED_UPLOAD_EXTS allowlist, filename
// sanitization against path traversal, and — the big one — that a file one
// session uploads can't be operated on from a different session. Hermetic:
// an ephemeral HTTP server, a temp-dir session store, and no PrusaSlicer
// binary is ever invoked (the isolation check in routes/slice.ts runs and
// rejects BEFORE the route would need to shell out to it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore } from "../session";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function setCookieValue(resp: Response): string | undefined {
  const raw = resp.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
}

test("upload rejects a file whose extension isn't in ACCEPTED_UPLOAD_EXTS", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    const fd = new FormData();
    fd.append("files", new Blob(["MZ"], { type: "application/octet-stream" }), "malware.exe");
    const resp = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
    const data = (await resp.json()) as { error: string };
    assert.equal(resp.status, 400);
    assert.match(data.error, /No accepted files/);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path-traversal filename is sanitized to a plain basename inside the session's own directory", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    const fd = new FormData();
    fd.append("files", new Blob(["solid x\nendsolid x\n"], { type: "application/octet-stream" }), "../../../../etc/evil.stl");
    const resp = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
    const data = (await resp.json()) as { uploaded: Array<{ localPath: string; fileName: string }> };
    assert.equal(resp.status, 200);
    assert.equal(data.uploaded.length, 1);

    const { localPath, fileName } = data.uploaded[0];
    assert.ok(!fileName.includes("/") && !fileName.includes(".."), `fileName leaked a path: ${fileName}`);
    assert.ok(!localPath.includes(".."), `localPath contains a traversal segment: ${localPath}`);
    assert.ok(localPath.startsWith(root), `file escaped the sessions root: ${localPath}`);
    assert.ok(existsSync(localPath), "the uploaded file should exist where reported");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session isolation: session B cannot slice a file session A uploaded", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    // Session A uploads a file.
    const fd = new FormData();
    fd.append("files", new Blob(["solid x\nendsolid x\n"]), "part.stl");
    const uploadResp = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
    const cookieA = setCookieValue(uploadResp);
    assert.ok(cookieA, "session A should have gotten a cookie");
    const uploadData = (await uploadResp.json()) as { uploaded: Array<{ localPath: string }> };
    const sessionAsPath = uploadData.uploaded[0].localPath;

    // Session B — a request with NO cookie, i.e. a different browser — tries
    // to slice the exact path session A's upload just produced.
    const sliceResp = await fetch(`${base}/api/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [sessionAsPath] }),
    });
    const sliceData = (await sliceResp.json()) as { error: string };
    assert.equal(sliceResp.status, 403);
    assert.match(sliceData.error, /not part of this session/);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
