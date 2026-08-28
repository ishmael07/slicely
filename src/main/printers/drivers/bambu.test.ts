// These tests cover the pure report-parsing logic (mapGcodeState,
// parseFilaments, reportToStatus) and the honest "not supported" send()
// paths, which need no network. The MQTT connect/subscribe machinery itself
// (connectMqtt, withBambuReport, controlViaMqtt) opens a real socket by
// design and is NOT exercised here — hermetically testing it would require
// mocking the `mqtt` module or standing up a fake broker, neither of which
// this pass does. That live-connect path is the main coverage gap for this
// driver; see the final report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BambuLanDriver, BambuCloudDriver, mapGcodeState, parseFilaments, reportToStatus } from "./bambu";

test("mapGcodeState covers every documented gcode_state value", () => {
  assert.equal(mapGcodeState("RUNNING"), "printing");
  assert.equal(mapGcodeState("PAUSE"), "paused");
  assert.equal(mapGcodeState("FINISH"), "finished");
  assert.equal(mapGcodeState("FAILED"), "error");
  assert.equal(mapGcodeState("PREPARE"), "preparing");
  assert.equal(mapGcodeState("IDLE"), "idle");
  assert.equal(mapGcodeState(undefined), "unknown");
  assert.equal(mapGcodeState("something-new"), "unknown");
});

test("parseFilaments normalizes AMS tray colour (8-hex RRGGBBAA -> #RRGGBB) across multiple units", () => {
  const slots = parseFilaments({
    ams: {
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PLA", tray_color: "00AE42FF", tray_sub_brands: "Bambu PLA Basic", remain: 80 },
            { id: "1", tray_type: "", tray_color: "", remain: 0 }, // empty slot
          ],
        },
        {
          id: "1",
          tray: [{ id: "0", tray_type: "PETG", tray_color: "1155CCFF", remain: 45 }],
        },
      ],
    },
  });

  assert.equal(slots.length, 3);

  assert.equal(slots[0].index, 0);
  assert.equal(slots[0].colourHex, "#00AE42");
  assert.equal(slots[0].material, "PLA");
  assert.equal(slots[0].label, "Bambu PLA Basic");
  assert.equal(slots[0].remainingPct, 80);
  assert.equal(slots[0].loaded, true);

  // Empty tray: no material, loaded false, colour undefined (nothing to parse).
  assert.equal(slots[1].index, 1);
  assert.equal(slots[1].loaded, false);
  assert.equal(slots[1].colourHex, undefined);

  // Second AMS unit continues the index sequence rather than restarting at 0.
  assert.equal(slots[2].index, 2);
  assert.equal(slots[2].colourHex, "#1155CC");
  assert.equal(slots[2].material, "PETG");
});

test("reportToStatus converts minutes to seconds and carries temps/progress/layers through", () => {
  const status = reportToStatus("bambu-1", {
    print: {
      gcode_state: "RUNNING",
      mc_percent: 61,
      mc_remaining_time: 42, // minutes
      layer_num: 88,
      total_layer_num: 200,
      nozzle_temper: 219.5,
      nozzle_target_temper: 220,
      bed_temper: 59.1,
      bed_target_temper: 60,
      subtask_name: "vase.gcode",
    },
  });

  assert.equal(status.id, "bambu-1");
  assert.equal(status.state, "printing");
  assert.equal(status.jobName, "vase.gcode");
  assert.equal(status.progressPct, 61);
  assert.equal(status.timeRemainingSec, 42 * 60);
  assert.equal(status.currentLayer, 88);
  assert.equal(status.totalLayers, 200);
  assert.equal(status.nozzleTempC, 219.5);
  assert.equal(status.bedTempC, 59.1);
  assert.deepEqual(status.filaments, []);
});

test("bambu-lan send() attempts a real upload and reports why it failed", async () => {
  const printer = {
    id: "b1",
    label: "X1C",
    transport: "bambu-lan" as const,
    host: "10.0.0.20",
    serial: "01P00A000000000",
    accessCode: "12345678",
  };
  // No such file, so the upload fails before any network access. The point is
  // that LAN now goes down the FTPS path instead of refusing outright, and
  // that the failure names the real cause.
  const result = await BambuLanDriver.send(printer, "/tmp/definitely-missing.gcode", {
    startImmediately: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.match(result.message, /Upload failed/i);
  assert.doesNotMatch(
    result.message,
    /doesn't implement|not implemented/i,
    "LAN upload is implemented now; the message must not claim otherwise",
  );
});

test("bambu-lan send() refuses without an access code, and says where to find it", async () => {
  const result = await BambuLanDriver.send(
    { id: "b1", label: "X1C", transport: "bambu-lan" as const, host: "10.0.0.20", serial: "01P" },
    "/tmp/x.gcode",
    { startImmediately: false },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /access code/i);
});

test("bambu-cloud send() still reports the gap, and points at the LAN route", async () => {
  const cloudResult = await BambuCloudDriver.send(
    {
      id: "b2",
      label: "X1C",
      transport: "bambu-cloud" as const,
      serial: "01P00A000000000",
      token: "tok",
    },
    "/tmp/whatever.gcode",
    { startImmediately: false },
  );
  assert.equal(cloudResult.ok, false);
  assert.equal(cloudResult.started, false);
  assert.match(cloudResult.message, /LAN/i, "must point the user at the route that works");
});
