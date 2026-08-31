// The settings shared by a headless slice and the GUI the user actually looks
// at. Hermetic: pure argument construction, no PrusaSlicer, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settingArgs } from "./prusaslicer";

test("a requested colour is part of the shared settings, not the slice-only args", () => {
  // This is the whole bug: writeEffectiveConfig builds the GUI's config from
  // settingArgs ALONE. While the colour lived further down, beside the
  // slice-only transforms, asking for a black print sliced black G-code and
  // opened PrusaSlicer showing the default teal.
  const args = settingArgs({ filamentColour: "#000000" });

  assert.ok(args.includes("--filament-colour"), "the spool swatch");
  assert.ok(args.includes("--extruder-colour"), "what the plater paints the object with");
  assert.equal(args[args.indexOf("--filament-colour") + 1], "#000000");
  assert.equal(args[args.indexOf("--extruder-colour") + 1], "#000000");
});

test("a colour is normalised, and nonsense is dropped rather than passed on", () => {
  const short = settingArgs({ filamentColour: "0f0" });
  assert.equal(short[short.indexOf("--filament-colour") + 1], "#00ff00");

  // PrusaSlicer rejects an unparseable colour outright, taking the whole slice
  // down with it — so a bad value must never reach the CLI.
  assert.deepEqual(settingArgs({ filamentColour: "black" }), []);
  assert.deepEqual(settingArgs({}), []);
});
