// Redirect the workdir to a throwaway temp directory before anything
// transitively requires ../config (see the same note in registry.test.ts).
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

process.env.SLICELY_WORKDIR = mkdtempSync(join(tmpdir(), "slicely-index-test-"));
// The registry encrypts printer credentials at rest, so the vault needs a
// master key — hosted mode reads one from the environment.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

import { test } from "node:test";
import assert from "node:assert/strict";
import * as printers from "./index";
import { resetKeyVaultForTests } from "../keyvault";

resetKeyVaultForTests();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Stub fetch for a real octoprint driver: version probe always succeeds,
 *  and file upload always succeeds, echoing whether OctoPrint was asked to
 *  print immediately (mirrors what a real server would do). */
function stubOctoprintFetch() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/api/version")) {
      return jsonResponse({ server: "1.9.0", text: "OctoPrint 1.9.0" });
    }
    if (url.endsWith("/api/files/local")) {
      const body = init?.body;
      const started = body instanceof FormData && body.get("print") === "true";
      return jsonResponse({ done: true, started }, 201);
    }
    throw new Error(`unexpected fetch in stub: ${url}`);
  };
}

test("sendToPrinter: asked to start but auto-start unarmed => uploads, but started:false with guidance", async (t) => {
  t.mock.method(globalThis, "fetch", stubOctoprintFetch());

  const { printer, test: testResult } = await printers.addPrinter({
    label: "Gate Test Printer",
    transport: "octoprint",
    host: "10.0.0.100",
    port: 80,
    apiKey: "key",
  });
  assert.equal(testResult.ok, true);
  assert.equal(printers.isAutoStartArmed(printer.id), false);

  const gcodePath = join(tmpdir(), `slicely-gate-test-${Date.now()}.gcode`);
  writeFileSync(gcodePath, "G28\n");

  const result = await printers.sendToPrinter(printer.id, gcodePath, { startImmediately: true });

  assert.equal(result.ok, true); // upload itself succeeded
  assert.equal(result.started, false); // but the safety gate held
  assert.match(result.message, /auto-start/i);
  assert.match(result.message, /setAutoStart/);

  unlinkSync(gcodePath);
  await printers.removePrinter(printer.id);
});

test("sendToPrinter: asked to start AND armed => actually starts", async (t) => {
  t.mock.method(globalThis, "fetch", stubOctoprintFetch());

  const { printer } = await printers.addPrinter({
    label: "Armed Printer",
    transport: "octoprint",
    host: "10.0.0.101",
    port: 80,
    apiKey: "key",
  });

  await printers.setAutoStart(printer.id, true);
  assert.equal(printers.isAutoStartArmed(printer.id), true);

  const gcodePath = join(tmpdir(), `slicely-gate-test-armed-${Date.now()}.gcode`);
  writeFileSync(gcodePath, "G28\n");

  const result = await printers.sendToPrinter(printer.id, gcodePath, { startImmediately: true });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);

  unlinkSync(gcodePath);
  await printers.removePrinter(printer.id);
});

test("sendToPrinter: startImmediately defaults to false when the caller doesn't ask", async (t) => {
  t.mock.method(globalThis, "fetch", stubOctoprintFetch());

  const { printer } = await printers.addPrinter({
    label: "Default Printer",
    transport: "octoprint",
    host: "10.0.0.102",
    apiKey: "key",
  });
  await printers.setAutoStart(printer.id, true); // even armed...

  const gcodePath = join(tmpdir(), `slicely-gate-test-default-${Date.now()}.gcode`);
  writeFileSync(gcodePath, "G28\n");

  // ...caller passes no opts at all: still must not start.
  const result = await printers.sendToPrinter(printer.id, gcodePath);
  assert.equal(result.started, false);

  unlinkSync(gcodePath);
  await printers.removePrinter(printer.id);
});

test("driverLabels lists every transport with a defaultPort and requiredSecrets", () => {
  const labels = printers.driverLabels();
  const transports = labels.map((l) => l.transport).sort();
  assert.deepEqual(transports, [
    "bambu-cloud",
    "bambu-lan",
    "file",
    "moonraker",
    "octoprint",
    "prusa-connect",
    "prusalink",
  ]);
  const octoprint = labels.find((l) => l.transport === "octoprint");
  assert.equal(octoprint?.defaultPort, 80);
  assert.deepEqual(octoprint?.requiredSecrets, ["apiKey"]);
});

test("getPrinter/listPrinters never expose secrets", async (t) => {
  t.mock.method(globalThis, "fetch", stubOctoprintFetch());
  const { printer } = await printers.addPrinter({
    label: "Secret Check",
    transport: "octoprint",
    host: "10.0.0.103",
    apiKey: "super-secret",
  });

  const fetched = await printers.getPrinter(printer.id);
  assert.ok(fetched);
  assert.equal((fetched as unknown as Record<string, unknown>).apiKey, undefined);

  const all = await printers.listPrinters();
  assert.ok(all.every((p) => (p as unknown as Record<string, unknown>).apiKey === undefined));

  await printers.removePrinter(printer.id);
});
