// Tests for POST /api/upload: the ACCEPTED_UPLOAD_EXTS allowlist, filename
// sanitization against path traversal, and — the big one — that a file one
// session uploads can't be operated on from a different session. Hermetic:
// an ephemeral HTTP server, a temp-dir session store, and no PrusaSlicer
// binary is ever invoked (the isolation check in routes/slice.ts runs and
// rejects BEFORE the route would need to shell out to it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore } from "../session";
import { resetConfigForTests } from "../../main/config";
import { buildZip } from "../../main/sourcing/zipFixture";

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

/** Boot a session the way the client does. GET /api/config is the ONE call that
 *  may mint a workspace (session.ts's MINTING_ROUTES); /api/upload without a
 *  cookie is 401 `no_session`, so every upload here starts with this. */
async function boot(base: string): Promise<string> {
  const resp = await fetch(`${base}/api/config`);
  assert.equal(resp.status, 200);
  const cookie = setCookieValue(resp);
  assert.ok(cookie, "the boot call should mint a session cookie");
  return cookie!;
}

test("upload rejects a file whose extension isn't in ACCEPTED_UPLOAD_EXTS", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    const fd = new FormData();
    fd.append("files", new Blob(["MZ"], { type: "application/octet-stream" }), "malware.exe");
    const resp = await fetch(`${base}/api/upload`, {
      method: "POST",
      body: fd,
      headers: { cookie: await boot(base) },
    });
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
    const cookie = await boot(base);
    const resp = await fetch(`${base}/api/upload`, { method: "POST", body: fd, headers: { cookie } });
    const text = await resp.text();
    const data = JSON.parse(text) as { uploaded: Array<{ name: string; relPath: string }> };
    assert.equal(resp.status, 200);
    assert.equal(data.uploaded.length, 1);

    const { name, relPath } = data.uploaded[0];
    assert.ok(!name.includes("/") && !name.includes(".."), `name leaked a path: ${name}`);
    assert.equal(relPath, "uploads/evil.stl", `relPath is a plain workspace path: ${relPath}`);
    // The body names nothing outside the visitor's own workspace — no absolute
    // path at all, which is the constraint the old `localPath` broke.
    assert.ok(!text.includes(root), `the reply leaked the sessions root: ${text}`);

    // And the file really is where the relative path says it is, resolved
    // against this session's own directory.
    const session = store.get(
      decodeURIComponent(cookie.split("=")[1]).split(".")[0],
    );
    assert.ok(session, "the cookie should name a live session");
    assert.ok(existsSync(join(session!.dir, relPath)), "the uploaded file should exist where reported");
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
    const cookieA = await boot(base);
    const uploadResp = await fetch(`${base}/api/upload`, {
      method: "POST",
      body: fd,
      headers: { cookie: cookieA },
    });
    const uploadData = (await uploadResp.json()) as { uploaded: Array<{ relPath: string }> };
    assert.equal(uploadData.uploaded[0].relPath, "uploads/part.stl");
    // A's file named the way A's own session resolves it — the absolute path the
    // wire deliberately no longer carries.
    const sessionA = store.get(decodeURIComponent(cookieA.split("=")[1]).split(".")[0])!;
    const sessionAsPath = join(sessionA.dir, uploadData.uploaded[0].relPath);

    // Session B — a DIFFERENT browser with its own workspace — tries to slice
    // the exact path session A's upload just produced.
    const cookieB = await boot(base);
    const sliceResp = await fetch(`${base}/api/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieB },
      body: JSON.stringify({ paths: [sessionAsPath] }),
    });
    // 400 with the stable code (Task D8), not a 403: a 403 distinguishes
    // "exists but isn't yours" from "doesn't exist", which is a probe for
    // another session's files. And the body must not echo the path back —
    // that is how the sessions root (and a live session id) leaked.
    const raw = await sliceResp.text();
    const sliceData = JSON.parse(raw) as { error: string; code?: string };
    assert.equal(sliceResp.status, 400);
    assert.equal(sliceData.code, "not_in_workspace");
    assert.ok(!raw.includes(root), `the reply leaked the sessions root: ${raw}`);
    assert.ok(!raw.includes(sessionAsPath), `the reply echoed the path back: ${raw}`);
    assert.ok(!/\/(Users|home|data|private|var|tmp)\//.test(raw), `the reply carries an absolute path: ${raw}`);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uploaded files land under the session's own directory, never in a global uploads/", async () => {
  const root = tmpRoot();
  const workdir = tmpRoot();
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.SLICELY_WORKDIR = workdir;
  resetConfigForTests();

  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    const fd = new FormData();
    // 1 KB each — the point is where they land, not how big they are.
    fd.append("files", new Blob(["solid a\n" + "x".repeat(1000) + "\nendsolid a\n"]), "a.stl");
    fd.append("files", new Blob(["solid b\n" + "y".repeat(1000) + "\nendsolid b\n"]), "b.stl");
    const resp = await fetch(`${base}/api/upload`, {
      method: "POST",
      body: fd,
      headers: { cookie: await boot(base) },
    });
    const data = (await resp.json()) as { uploaded: Array<{ name: string; relPath: string }> };
    assert.equal(resp.status, 200);
    assert.equal(data.uploaded.length, 2);

    const sessionDir = [...readdirSync(root)]
      .map((entry) => join(root, entry))
      .find((entry) => existsSync(join(entry, "uploads")));
    assert.ok(sessionDir, "the session's own directory should be under the sessions root");
    for (const u of data.uploaded) {
      assert.match(u.relPath, /^uploads\//, `not a workspace path: ${u.relPath}`);
      assert.ok(existsSync(join(sessionDir!, u.relPath)), `missing on disk: ${u.relPath}`);
    }

    // THE REGRESSION: main/uploads.ts used to copy every upload into the ONE
    // global `<workdir>/uploads` directory first, so a hosted server had every
    // visitor's files piled into a shared folder (and a second copy of each on
    // disk) before they were moved into the session. Nothing may write there.
    assert.ok(
      !existsSync(join(workdir, "uploads")),
      `a global uploads/ dir was written: ${readdirSync(workdir).join(", ")}`,
    );
  } finally {
    await close();
    store.stopSweep();
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a zip with more entries than the cap is refused, not expanded", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    // 501 tiny STLs: harmless in bytes (~10 KB total), hostile in entry count.
    // Without an entry cap the extractor writes 501 files and the route stores
    // 501 UploadResults per request — a cheap way to hammer a shared server.
    const zip = buildZip(
      Array.from({ length: 501 }, (_, i) => ({
        name: `part-${i}.stl`,
        content: Buffer.from(`solid p${i}\nendsolid p${i}\n`),
      })),
    );
    const fd = new FormData();
    fd.append("files", new Blob([new Uint8Array(zip)]), "parts.zip");
    const resp = await fetch(`${base}/api/upload`, {
      method: "POST",
      body: fd,
      headers: { cookie: await boot(base) },
    });
    const data = (await resp.json()) as { error: string; code?: string };
    assert.equal(resp.status, 400);
    assert.equal(data.code, "zip_too_many_entries");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch bigger than the 600 MB cap is refused before its bytes are read", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(createApp({ sessionStore: store }));
  try {
    // A declared 700 MB body, of which we send 64 bytes. The point is that the
    // server answers from the header alone: 12 × 200 MB used to be an accepted
    // request, so the only way to prove the cap is to watch it refuse one
    // WITHOUT us having to actually transfer 700 MB.
    const url = new URL("/api/upload", base);
    const cookie = await boot(base);
    let sent: ClientRequest | undefined;
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      sent = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "multipart/form-data; boundary=----slicely",
            "content-length": String(700 * 1024 * 1024),
            // A booted session, like any real client: without it the request is
            // refused for having no session before its size is even looked at.
            cookie,
          },
        },
        (resp) => {
          let text = "";
          resp.setEncoding("utf8");
          resp.on("data", (d: string) => (text += d));
          resp.on("end", () => resolve({ status: resp.statusCode ?? 0, body: text }));
        },
      );
      sent.on("error", (e) => reject(e));
      sent.write("------slicely\r\n");
      // Deliberately never end(): the declared Content-Length is never met.
    }).catch((e: Error) => ({ status: 0, body: e.message }));
    // We are the rude client here — hang up so the server can close.
    sent?.destroy();

    assert.equal(answer.status, 413);
    const data = JSON.parse(answer.body) as { error: string; code?: string };
    assert.equal(data.code, "too_large");
    assert.match(data.error, /600 MB max per batch/);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
