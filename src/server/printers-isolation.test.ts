// Two browsers, one server: a printer belongs to the visitor who added it.
//
// This is the end-to-end half of Task D1. The registry used to be a single
// module-level cache over `<workdir>/printers.json`, so EVERY web visitor
// shared one printer list — anyone could list, rename, delete or arm anyone
// else's printer, and every credential sat in one plaintext file. These tests
// drive the real façade over real HTTP with two cookies and prove that is gone.
//
// The connection probe is INJECTED (`printerTestOverride`), so adding a
// prusa-connect printer never touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "./index";
import { SessionStore, type ChatAgent } from "./session";

// Hosted mode with a real master key: printer credentials are encrypted at
// rest, so the vault must be able to load one.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-printers-iso-"));
}

const stubAgent: () => ChatAgent = () => ({
  async send(_message, emit) {
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised here */
  },
});

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The `name=value` half of a Set-Cookie, ready to send back as `cookie`. */
function cookieOf(resp: Response): string {
  const raw = resp.headers.get("set-cookie");
  assert.ok(raw, "expected a session cookie");
  return raw.split(";")[0];
}

/** The session id inside a signed cookie value, so a test can find the
 *  session's own directory on disk. */
function sessionIdFrom(cookie: string): string {
  return decodeURIComponent(cookie.split("=")[1]).split(".")[0];
}

test("a printer added by one session is invisible and untouchable to another", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      keyValidator: async () => "ok",
      printerTestOverride: async () => ({ ok: true, message: "stub" }),
    }),
  );
  try {
    // ── Session A boots, which is the one call that mints a workspace ──────
    // Every other endpoint answers 401 `no_session` without a cookie (see
    // session.ts's MINTING_ROUTES), exactly as a browser's boot does.
    const cookieA = cookieOf(await fetch(`${base}/api/config`));

    // ── Session A adds a cloud printer with a credential ───────────────────
    const add = await fetch(`${base}/api/printers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieA },
      body: JSON.stringify({
        transport: "prusa-connect",
        label: "A's MK4",
        host: "connect.prusa3d.com",
        token: "tok-A",
      }),
    });
    const addText = await add.text();
    assert.equal(add.status, 201, addText);
    const idA = (JSON.parse(addText) as { printer: { id: string } }).printer.id;
    assert.ok(idA);
    assert.ok(!addText.includes("tok-A"), "the credential must never come back over the wire");

    // ── Session B: a different browser, its own boot call ──────────────────
    const cookieB = cookieOf(await fetch(`${base}/api/config`));
    const listB = await fetch(`${base}/api/printers`, { headers: { cookie: cookieB } });
    assert.deepEqual(await listB.json(), [], "B's printer list is its own, and empty");

    const patch = await fetch(`${base}/api/printers/${idA}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: cookieB },
      body: JSON.stringify({ label: "pwned" }),
    });
    assert.equal(patch.status, 404);
    assert.equal(((await patch.json()) as { code?: string }).code, "not_found");

    const arm = await fetch(`${base}/api/printers/${idA}/autostart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieB },
      body: JSON.stringify({ armed: true }),
    });
    assert.equal(arm.status, 404, "and B certainly cannot arm A's printer to start printing");

    const del = await fetch(`${base}/api/printers/${idA}`, { method: "DELETE", headers: { cookie: cookieB } });
    assert.equal(del.status, 404);

    const statusB = await fetch(`${base}/api/printers/${idA}/status`, { headers: { cookie: cookieB } });
    assert.equal(statusB.status, 404);

    // ── Session A still has exactly what it added, unchanged ───────────────
    const listA = await fetch(`${base}/api/printers`, { headers: { cookie: cookieA } });
    const printersA = (await listA.json()) as Array<{ id: string; label: string; autoStart?: boolean }>;
    assert.equal(printersA.length, 1);
    assert.equal(printersA[0].id, idA);
    assert.equal(printersA[0].label, "A's MK4", "B's PATCH changed nothing");
    assert.equal(printersA[0].autoStart, false, "auto-start is reported, and still off");

    // ── The credential is encrypted in A's own session directory ───────────
    const dirA = store.get(sessionIdFrom(cookieA))?.dir;
    assert.ok(dirA, "session A owns a directory");
    const onDisk = readFileSync(join(dirA, "printer-secrets.json"), "utf8");
    assert.ok(!onDisk.includes("tok-A"), "a printer credential must never hit disk in plaintext");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
