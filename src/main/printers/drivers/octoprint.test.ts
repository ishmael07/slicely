import { test } from "node:test";
import assert from "node:assert/strict";
import { octoprintDriver } from "./octoprint";
import type { ResolvedPrinter } from "../../../shared/printers";

const PRINTER: ResolvedPrinter = {
  id: "p1",
  label: "Test OctoPrint",
  transport: "octoprint",
  host: "10.0.0.5",
  port: 80,
  apiKey: "secret-key",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("octoprint status() parses a realistic /api/printer + /api/job payload", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(url);
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["X-Api-Key"], "secret-key");

    if (url.endsWith("/api/printer")) {
      return jsonResponse({
        state: {
          text: "Printing",
          flags: {
            operational: true,
            printing: true,
            paused: false,
            error: false,
            ready: false,
            closedOrError: false,
          },
        },
        temperature: {
          tool0: { actual: 214.3, target: 215 },
          bed: { actual: 59.8, target: 60 },
        },
      });
    }
    if (url.endsWith("/api/job")) {
      return jsonResponse({
        job: { file: { name: "benchy.gcode" } },
        progress: { completion: 42.5, printTimeLeft: 1800 },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const status = await octoprintDriver.status(PRINTER);

  assert.equal(status.id, "p1");
  assert.equal(status.state, "printing");
  assert.equal(status.jobName, "benchy.gcode");
  assert.equal(status.progressPct, 42.5);
  assert.equal(status.timeRemainingSec, 1800);
  assert.equal(status.nozzleTempC, 214.3);
  assert.equal(status.nozzleTargetC, 215);
  assert.equal(status.bedTempC, 59.8);
  assert.equal(status.bedTargetC, 60);
  assert.equal(calls.length, 2);
});

test("octoprint status() reports offline (never throws) on a network failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });

  const status = await octoprintDriver.status(PRINTER);
  assert.equal(status.state, "offline");
  assert.match(status.message ?? "", /ECONNREFUSED/);
});

test("octoprint status() maps a 409 (server up, printer not connected) to idle, not offline", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/printer")) return new Response("", { status: 409 });
    return jsonResponse({});
  });

  const status = await octoprintDriver.status(PRINTER);
  assert.equal(status.state, "idle");
});

test("octoprint send() never starts the print by default", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ done: true }, 201));

  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `slicely-test-${Date.now()}.gcode`);
  await fs.writeFile(tmp, "G28\n");

  const result = await octoprintDriver.send(PRINTER, tmp, { startImmediately: false });
  assert.equal(result.ok, true);
  assert.equal(result.started, false);

  await fs.unlink(tmp).catch(() => {});
});
