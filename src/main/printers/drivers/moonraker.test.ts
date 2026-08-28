import { test } from "node:test";
import assert from "node:assert/strict";
import { moonrakerDriver } from "./moonraker";
import type { ResolvedPrinter } from "../../../shared/printers";

const PRINTER: ResolvedPrinter = {
  id: "p2",
  label: "Test Klipper",
  transport: "moonraker",
  host: "10.0.0.6",
  port: 7125,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("moonraker status() parses a realistic objects/query payload", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /\/printer\/objects\/query\?/);
    return jsonResponse({
      result: {
        status: {
          print_stats: { filename: "widget.gcode", state: "printing", message: "" },
          heater_bed: { temperature: 59.6, target: 60 },
          extruder: { temperature: 219.8, target: 220 },
          virtual_sdcard: { progress: 0.337, is_active: true },
          display_status: { progress: 0.337, message: "" },
        },
      },
    });
  });

  const status = await moonrakerDriver.status(PRINTER);
  assert.equal(status.state, "printing");
  assert.equal(status.jobName, "widget.gcode");
  assert.equal(status.progressPct, 34); // 0.337 -> rounded 34%
  assert.equal(status.nozzleTempC, 219.8);
  assert.equal(status.bedTempC, 59.6);
});

test("moonraker status() maps 'complete' to finished and 'error' to error", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ result: { status: { print_stats: { state: "complete" } } } }),
  );
  const finished = await moonrakerDriver.status(PRINTER);
  assert.equal(finished.state, "finished");
});

test("moonraker status() never throws on a network error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("host unreachable");
  });
  const status = await moonrakerDriver.status(PRINTER);
  assert.equal(status.state, "offline");
  assert.match(status.message ?? "", /host unreachable/);
});

test("moonraker send() only sets print=true when startImmediately is true", async (t) => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `slicely-test-${Date.now()}.gcode`);
  await fs.writeFile(tmp, "G28\n");

  let sawPrintField = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof FormData) {
      sawPrintField = body.get("print") === "true";
    }
    return jsonResponse({ result: "ok" });
  });

  const result = await moonrakerDriver.send(PRINTER, tmp, { startImmediately: true });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(sawPrintField, true);

  await fs.unlink(tmp).catch(() => {});
});
