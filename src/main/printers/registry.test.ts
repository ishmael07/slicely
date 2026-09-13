// Redirect Slicely's workdir to a throwaway temp directory BEFORE anything
// requires ./registry (which requires ../config, which resolves the workdir
// on first use and is cached for the lifetime of the process). This keeps
// the test hermetic — it never touches the real user's ~/Slicely — and each
// test file is its own `node --test` worker process, so this doesn't leak
// into other test files.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const WORKDIR = mkdtempSync(join(tmpdir(), "slicely-registry-test-"));
process.env.SLICELY_WORKDIR = WORKDIR;
// Printer credentials are encrypted at rest, so the vault needs a master key.
// Hosted mode takes it from the environment (desktop mode would write one into
// the workdir), which is the posture a public deploy runs in.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as registry from "./registry";
import { resetKeyVaultForTests } from "../keyvault";
import { runInSession, sessionContext } from "../session-context";

resetKeyVaultForTests();

/** The registry resolves its files inside the AMBIENT session's directory, so
 *  every test runs inside one. These single-session tests share "t". */
const DIR_T = mkdtempSync(join(tmpdir(), "slicely-registry-t-"));
function inT<T>(fn: () => T): T {
  return runInSession(sessionContext("t", DIR_T), fn);
}

// Every mkdtempSync call in this file is a REAL directory under $TMPDIR. Left
// alone, a few hundred survived across repeated test runs and helped fill the
// disk (fix round 1, task D1+D2) — these two are created once for the whole
// file, so they are removed once here; each test below that makes its own
// removes it in a finally.
after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
  rmSync(DIR_T, { recursive: true, force: true });
});

test("addConnection / listConnections round-trip with secrets stripped from the public listing", () => {
  inT(() => {
    const created = registry.addConnection({
      label: "Workshop MK4",
      transport: "prusalink",
      host: "10.0.0.50",
      port: 80,
      enabled: true,
      apiKey: "top-secret-key",
    });

    assert.ok(created.id);
    assert.equal(created.label, "Workshop MK4");
    // The connection object itself has no field a secret could live in.
    assert.equal((created as unknown as Record<string, unknown>).apiKey, undefined);

    const listed = registry.listConnections();
    const found = listed.find((p) => p.id === created.id);
    assert.ok(found);
    assert.equal((found as unknown as Record<string, unknown>).apiKey, undefined);

    const resolved = registry.resolve(created.id);
    assert.equal(resolved.apiKey, "top-secret-key");
    assert.equal(resolved.host, "10.0.0.50");

    registry.removeConnection(created.id);
  });
});

test("printer-secrets.json is written with mode 0600", () => {
  inT(() => {
    const created = registry.addConnection({
      label: "Secret-mode check",
      transport: "octoprint",
      host: "10.0.0.51",
      apiKey: "abc",
    });

    const secretsPath = join(DIR_T, "printer-secrets.json");
    const mode = statSync(secretsPath).mode & 0o777;
    assert.equal(mode, 0o600);

    registry.removeConnection(created.id);
  });
});

test("updateConnection merges connection fields and secret fields independently", () => {
  inT(() => {
    const created = registry.addConnection({
      label: "Before",
      transport: "moonraker",
      host: "10.0.0.52",
    });

    const updated = registry.updateConnection(created.id, { label: "After", apiKey: "new-key" });
    assert.equal(updated.label, "After");
    assert.equal(updated.host, "10.0.0.52"); // untouched fields survive the merge

    const resolved = registry.resolve(created.id);
    assert.equal(resolved.apiKey, "new-key");

    registry.removeConnection(created.id);
  });
});

test("removeConnection deletes the connection, its secrets, and clears active/auto-start", () => {
  inT(() => {
    const created = registry.addConnection({
      label: "Doomed",
      transport: "octoprint",
      host: "10.0.0.53",
      apiKey: "x",
    });

    registry.setActiveId(created.id);
    registry.setAutoStart(created.id, true);
    assert.equal(registry.getActiveId(), created.id);
    assert.equal(registry.isAutoStartArmed(created.id), true);

    registry.removeConnection(created.id);

    assert.equal(registry.getConnection(created.id), undefined);
    assert.equal(registry.getActiveId(), undefined);
    assert.equal(registry.isAutoStartArmed(created.id), false);
    assert.throws(() => registry.resolve(created.id));
  });
});

test("setActiveId and setAutoStart reject unknown printer ids", () => {
  inT(() => {
    assert.throws(() => registry.setActiveId("no-such-id"));
    assert.throws(() => registry.setAutoStart("no-such-id", true));
  });
});

// ── Per-session isolation (Task D1) ─────────────────────────────────────────

test("one registry per session: a second visitor sees none of the first's printers", () => {
  const dirA = mkdtempSync(join(tmpdir(), "slicely-registry-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "slicely-registry-b-"));
  try {
    const idA = runInSession(sessionContext("A", dirA), () => {
      const created = registry.addConnection({
        label: "A's MK4",
        transport: "prusalink",
        host: "10.0.0.60",
        apiKey: "k-A",
      });
      assert.equal(registry.listConnections().length, 1);
      return created.id;
    });

    runInSession(sessionContext("B", dirB), () => {
      assert.deepEqual(registry.listConnections(), [], "B's registry is its own, and empty");
      assert.equal(registry.getConnection(idA), undefined);
      assert.throws(() => registry.resolve(idA), /not found/i);
      assert.throws(() => registry.updateConnection(idA, { label: "pwned" }), /not found/i);
      assert.throws(() => registry.setAutoStart(idA, true), /not found/i);
      assert.throws(() => registry.setActiveId(idA), /not found/i);
    });

    const onDisk = readFileSync(join(dirA, "printer-secrets.json"), "utf8");
    assert.ok(!onDisk.includes("k-A"), "a printer credential must never hit disk in plaintext");
    assert.match(onDisk, /"version": 2/);

    // Dropping the cache (what a swept/destroyed session does) must not lose
    // the printer — the file on disk is still the truth.
    registry.disposeSessionPrinters("A");
    runInSession(sessionContext("A", dirA), () => {
      const listed = registry.listConnections();
      assert.equal(listed.length, 1, "re-read from disk after the cache was dropped");
      assert.equal(listed[0].label, "A's MK4");
      assert.equal(listed[0].autoStart, false);
      assert.equal(registry.resolve(idA).apiKey, "k-A", "and the secret still decrypts");
    });
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("a legacy plaintext printer-secrets.json is read once and rewritten encrypted", () => {
  const dir = mkdtempSync(join(tmpdir(), "slicely-registry-v1-"));
  try {
    writeFileSync(
      join(dir, "printers.json"),
      JSON.stringify({
        version: 1,
        printers: [{ id: "p1", label: "Old Timer", transport: "octoprint", host: "10.0.0.61", enabled: true }],
        autoStart: [],
      }),
    );
    // v1 format: a bare map of printer id -> plaintext PrinterSecrets.
    writeFileSync(join(dir, "printer-secrets.json"), JSON.stringify({ p1: { apiKey: "legacy-key" } }));

    runInSession(sessionContext("L", dir), () => {
      assert.equal(registry.resolve("p1").apiKey, "legacy-key", "a v1 file is still readable");
    });

    const onDisk = readFileSync(join(dir, "printer-secrets.json"), "utf8");
    assert.ok(!onDisk.includes("legacy-key"), "and is rewritten as ciphertext on first read");
    assert.match(onDisk, /"version": 2/);

    registry.disposeSessionPrinters("L");
    runInSession(sessionContext("L", dir), () => {
      assert.equal(registry.resolve("p1").apiKey, "legacy-key", "the rewritten file decrypts back");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoStart is reported from the arming list, and a patch can't fake it", () => {
  // SAFETY: the UI reads `autoStart` off the listing to decide whether it must
  // warn about an uncleared bed. If a PATCH could write that field onto the
  // connection record, the listing would claim "armed" for a printer that
  // isn't (or worse, the reverse) — so it is always derived, never stored.
  const dir = mkdtempSync(join(tmpdir(), "slicely-registry-arm-"));
  try {
    runInSession(sessionContext("S", dir), () => {
      const created = registry.addConnection({ label: "Arm Me", transport: "octoprint", host: "10.0.0.62" });
      assert.equal(registry.listConnections()[0].autoStart, false);

      registry.updateConnection(created.id, { autoStart: true });
      assert.equal(registry.isAutoStartArmed(created.id), false, "a patch must not arm auto-start");
      assert.equal(registry.listConnections()[0].autoStart, false);

      registry.setAutoStart(created.id, true);
      assert.equal(registry.listConnections()[0].autoStart, true);
      assert.equal(registry.getConnection(created.id)?.autoStart, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// NOTE: registry.ts's tolerate-a-corrupt-file behavior (readJsonSafe's
// try/catch around JSON.parse, used by loadStore/loadSecrets) is exercised
// only indirectly here: the caches are per session, so a fresh session id
// pointed at a directory holding a corrupt file is the way to reach it (see
// the legacy-file test for the shape of such a setup).
