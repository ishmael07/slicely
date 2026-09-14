// Redirect the workdir to a throwaway temp directory before anything
// transitively requires ../config (see the same note in registry.test.ts).
import { existsSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const WORKDIR = mkdtempSync(join(tmpdir(), "slicely-index-test-"));
process.env.SLICELY_WORKDIR = WORKDIR;
// The registry encrypts printer credentials at rest, so the vault needs a
// master key — hosted mode reads one from the environment.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as printers from "./index";
import { resetKeyVaultForTests } from "../keyvault";
import { WireError } from "../../server/errors";

resetKeyVaultForTests();

// Created once for the whole file (see the note at the top) — removed once
// here rather than per test. Left alone, one of these survived every run of
// this file and helped fill the disk (fix round 1, task D1+D2).
after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// These tests run in hosted mode (see the master-key note above), where a
// printer on a private network is refused outright (Task D4) — so the stand-in
// printers live on 203.0.113.0/24, the range reserved for documentation and
// examples, which is exactly what a host in a test is. Their driver never
// reaches the network: every fetch below is stubbed.
const HOST_A = "203.0.113.100";
const HOST_B = "203.0.113.101";
const HOST_C = "203.0.113.102";
const HOST_D = "203.0.113.103";

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
    host: HOST_A,
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
    host: HOST_B,
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
    host: HOST_C,
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
    host: HOST_D,
    apiKey: "super-secret",
  });

  const fetched = await printers.getPrinter(printer.id);
  assert.ok(fetched);
  assert.equal((fetched as unknown as Record<string, unknown>).apiKey, undefined);

  const all = await printers.listPrinters();
  assert.ok(all.every((p) => (p as unknown as Record<string, unknown>).apiKey === undefined));

  await printers.removePrinter(printer.id);
});

// ── Task D2: the "file" transport can only write where a person would ────────

test("the file transport can't be added on a hosted server", async () => {
  await assert.rejects(
    () =>
      printers.addPrinter({
        label: "Someone else's disk",
        transport: "file",
        outputDir: join(homedir(), "Desktop"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof WireError, "a hosted refusal must carry its own status and code");
      assert.equal(err.status, 403);
      assert.equal(err.code, "forbidden_in_hosted_mode");
      return true;
    },
  );
  // Not even without a folder: there is no folder a visitor could collect from.
  await assert.rejects(() => printers.addPrinter({ label: "No folder", transport: "file" }), WireError);
});

test("a file-transport send stays inside the chosen folder, whatever the job is called", async () => {
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = "desktop";
  // Inside the real home directory, because "inside the home directory" is the
  // rule under test. Removed again in the finally below.
  const dir = mkdtempSync(join(homedir(), "slicely-file-transport-test-"));
  const gcodePath = join(tmpdir(), `slicely-file-send-${Date.now()}.gcode`);
  writeFileSync(gcodePath, "G28\n");
  try {
    const { printer, test: probe } = await printers.addPrinter({
      label: "Desktop folder",
      transport: "file",
      outputDir: dir,
    });
    assert.equal(probe.ok, true, probe.message);

    const result = await printers.sendToPrinter(printer.id, gcodePath, { jobName: "../../../escaped" });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.started, false, "a folder never starts a print");
    assert.equal(existsSync(join(dir, "escaped.gcode")), true, "the copy lands in the chosen folder");
    assert.equal(existsSync(join(dir, "..", "escaped.gcode")), false, "and nowhere above it");

    // A hidden system folder is refused even when the record already existed.
    await assert.rejects(() => printers.updatePrinter(printer.id, { outputDir: join(homedir(), ".ssh") }), WireError);

    await printers.removePrinter(printer.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    unlinkSync(gcodePath);
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
  }
});

// ── Task D4: a printer is a printer, not the server itself ───────────────────

test("addPrinter refuses a loopback host BEFORE it probes anything", async () => {
  // The probe is what makes "add a printer" a request the server performs on
  // the user's behalf, so the guard has to come first — a refusal that arrives
  // after the connection test has already read /api/version on localhost is no
  // refusal at all.
  printers.setConnectionTestOverride(() => {
    throw new Error("the connection probe must never run for a blocked host");
  });
  try {
    const before = (await printers.listPrinters()).length;
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254"]) {
      await assert.rejects(
        () => printers.addPrinter({ label: "Not a printer", transport: "octoprint", host, apiKey: "key" }),
        (err: unknown) => {
          assert.ok(err instanceof WireError, `${host}: expected a WireError`);
          assert.equal(err.status, 400, host);
          assert.equal(err.code, "host_blocked", host);
          return true;
        },
        `addPrinter must refuse ${host}`,
      );
    }
    assert.equal((await printers.listPrinters()).length, before, "and nothing was saved");
  } finally {
    printers.setConnectionTestOverride(undefined);
  }
});

test("addPrinter refuses a LAN printer on a hosted server, and updatePrinter can't move one there", async (t) => {
  t.mock.method(globalThis, "fetch", stubOctoprintFetch());
  await assert.rejects(
    () => printers.addPrinter({ label: "Someone's LAN", transport: "octoprint", host: "192.168.1.50", apiKey: "k" }),
    (err: unknown) => {
      assert.ok(err instanceof WireError);
      assert.equal(err.code, "host_blocked");
      return true;
    },
  );

  const { printer } = await printers.addPrinter({
    label: "Public OctoPrint",
    transport: "octoprint",
    host: "203.0.113.120",
    apiKey: "k",
  });
  try {
    // The same rule on the way in through a patch — otherwise a saved record
    // becomes the way around the check it passed when it was created.
    await assert.rejects(
      () => printers.updatePrinter(printer.id, { host: "127.0.0.1" }),
      (err: unknown) => {
        assert.ok(err instanceof WireError);
        assert.equal(err.code, "host_blocked");
        return true;
      },
    );
    // A patch that doesn't touch the host is left alone.
    const renamed = await printers.updatePrinter(printer.id, { label: "Renamed" });
    assert.equal(renamed.label, "Renamed");
  } finally {
    await printers.removePrinter(printer.id);
  }
});
