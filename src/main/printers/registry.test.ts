// Redirect Slicely's workdir to a throwaway temp directory BEFORE anything
// requires ./registry (which requires ../config, which resolves the workdir
// on first use and is cached for the lifetime of the process). This keeps
// the test hermetic — it never touches the real user's ~/Slicely — and each
// test file is its own `node --test` worker process, so this doesn't leak
// into other test files.
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SLICELY_WORKDIR = mkdtempSync(join(tmpdir(), "slicely-registry-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import * as registry from "./registry";
import { getConfig } from "../config";

test("addConnection / listConnections round-trip with secrets stripped from the public listing", () => {
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

test("printer-secrets.json is written with mode 0600", () => {
  const created = registry.addConnection({
    label: "Secret-mode check",
    transport: "octoprint",
    host: "10.0.0.51",
    apiKey: "abc",
  });

  const secretsPath = join(getConfig().workdir, "printer-secrets.json");
  const mode = statSync(secretsPath).mode & 0o777;
  assert.equal(mode, 0o600);

  registry.removeConnection(created.id);
});

test("updateConnection merges connection fields and secret fields independently", () => {
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

test("removeConnection deletes the connection, its secrets, and clears active/auto-start", () => {
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

test("setActiveId and setAutoStart reject unknown printer ids", () => {
  assert.throws(() => registry.setActiveId("no-such-id"));
  assert.throws(() => registry.setAutoStart("no-such-id", true));
});

// NOTE: registry.ts's tolerate-a-corrupt-file behavior (readJsonSafe's
// try/catch around JSON.parse, used by loadStore/loadSecrets) is not
// exercised by an automated test here — registry caches the parsed store in
// a module-level variable on first read, and both that cache and
// getConfig()'s own workdir cache are process-lifetime, so re-triggering a
// *fresh* read against a corrupt file requires a separate process (e.g.
// `node -e` against the compiled output with SLICELY_WORKDIR pointed at a
// directory containing a hand-written corrupt printers.json). The code path
// is a plain try/catch with no branching logic, so this is a real but small
// gap: worth a manual/child-process check before relying on it, not a
// correctness claim made without evidence.
