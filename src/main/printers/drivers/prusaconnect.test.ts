// Note: unlike the other drivers' tests, there is no "realistic recorded
// payload" to test against here — prusaconnect.ts's schema is itself a
// documented guess (see its file-header comment). These tests exercise the
// driver's own parsing/mapping code against that guessed schema, which is
// still useful regression coverage even though it can't be validated against
// a real Prusa Connect account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prusaConnectDriver } from "./prusaconnect";
import type { ResolvedPrinter } from "../../../shared/printers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PRINTER: ResolvedPrinter = {
  id: "p6",
  label: "Connect MK4",
  transport: "prusa-connect",
  printerUuid: "uuid-123",
  token: "tok-abc",
};

test("prusa-connect status() sends a Bearer token and parses the guessed telemetry shape", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.Authorization, "Bearer tok-abc");
    assert.ok(url.endsWith("/app/printers/uuid-123"));
    return jsonResponse({
      name: "Connect MK4",
      state: "PRINTING",
      telemetry: { temp_nozzle: 210, target_nozzle: 215, temp_bed: 59, target_bed: 60, progress: 50, time_remaining: 900 },
      job: { file: { display_name: "part.gcode" } },
    });
  });

  const status = await prusaConnectDriver.status(PRINTER);
  assert.equal(status.state, "printing");
  assert.equal(status.jobName, "part.gcode");
  assert.equal(status.progressPct, 50);
  assert.equal(status.nozzleTempC, 210);
  assert.equal(status.bedTempC, 59);
});

test("prusa-connect status() returns 'unknown' (not offline) when token/uuid are missing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  const status = await prusaConnectDriver.status({ ...PRINTER, token: undefined });
  assert.equal(status.state, "unknown");
});

test("prusa-connect status() never throws on a network failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("DNS failure");
  });
  const status = await prusaConnectDriver.status(PRINTER);
  assert.equal(status.state, "offline");
});
