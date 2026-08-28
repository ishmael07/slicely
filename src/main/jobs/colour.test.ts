import { test } from "node:test";
import assert from "node:assert/strict";
import { deltaE76, hexToLab, planColours } from "./colour";
import type { JobPart } from "../../shared/jobs";
import type { FilamentSlot } from "../../shared/printers";

function part(path: string, colourHex?: string): JobPart {
  return { path, name: path, copies: 1, sizeX: 10, sizeY: 10, sizeZ: 10, colourHex };
}

test("Lab/Delta-E nearest-colour picks the perceptually closest slot, where raw RGB distance would pick the wrong one", () => {
  // Hand-verified (sRGB -> linear -> XYZ -> Lab, D65):
  //   black (0,0,0)       Lab (0, 0, 0)
  //   gray  (50,50,50)    Lab (~20.8, 0, 0)      -> Delta-E from black ~20.8
  //   blue  (0,0,60)      Lab (~2.9, 20.7, -35.4) -> Delta-E from black ~41.1
  // But RAW RGB EUCLIDEAN distance from black says the opposite: gray is
  // sqrt(3*50^2)=86.6 away, dark blue is only sqrt(60^2)=60 away. A naive
  // RGB matcher would wrongly pick the dark blue slot; Lab correctly picks
  // gray, because sRGB gamma makes near-black luminance steps perceptually
  // much larger than the same raw numeric step in a saturated blue channel.
  const requested = "#000000";
  const gray: FilamentSlot = { index: 0, colourHex: "#323232", loaded: true };
  const darkBlue: FilamentSlot = { index: 1, colourHex: "#00003c", loaded: true };

  const plan = planColours([part("/a.stl", requested)], [gray, darkBlue]);
  const assignment = plan.assignments[0];
  assert.equal(assignment.reason, "nearest-colour");
  assert.equal(assignment.colourHex, "#323232", "Lab distance should prefer the gray slot over the numerically-closer-in-RGB blue slot");
  assert.equal(assignment.extruder, 1); // slot index 0 -> extruder 1
});

test("deltaE76 sanity: identical colours are 0 apart, and the hand-verified black/gray/blue ordering holds", () => {
  const black = hexToLab("#000000");
  const gray = hexToLab("#323232");
  const blue = hexToLab("#00003c");
  assert.equal(deltaE76(black, black), 0);
  const dBlackGray = deltaE76(black, gray);
  const dBlackBlue = deltaE76(black, blue);
  assert.ok(dBlackGray < dBlackBlue, `expected gray (${dBlackGray}) closer to black than blue (${dBlackBlue})`);
});

test("exact colour match resolves reason 'matched-slot'", () => {
  const slots: FilamentSlot[] = [
    { index: 0, colourHex: "#ff0000", loaded: true },
    { index: 1, colourHex: "#00ff00", loaded: true },
  ];
  const plan = planColours([part("/a.stl", "#00FF00")], slots);
  assert.equal(plan.assignments[0].reason, "matched-slot");
  assert.equal(plan.assignments[0].extruder, 2);
  assert.equal(plan.singleExtruder, false);
});

test("a part with no requested colour gets 'default', not a fabricated preference", () => {
  const slots: FilamentSlot[] = [
    { index: 0, colourHex: "#ff0000", loaded: true },
    { index: 1, colourHex: "#00ff00", loaded: true },
  ];
  const plan = planColours([part("/a.stl")], slots);
  assert.equal(plan.assignments[0].reason, "default");
});

test("singleExtruder warning fires with only one usable slot, and colour is passed through as preview-only", () => {
  const slots: FilamentSlot[] = [{ index: 0, colourHex: "#ff0000", loaded: true }];
  const plan = planColours([part("/a.stl", "#00ff00")], slots);
  assert.equal(plan.singleExtruder, true);
  assert.ok(plan.warnings.some((w) => /preview-only|single-extruder/i.test(w)));
  assert.equal(plan.assignments[0].reason, "user");
  assert.equal(plan.assignments[0].colourHex, "#00ff00");
});

test("an empty/unloaded slot list also reports singleExtruder with a distinct warning", () => {
  const plan = planColours([part("/a.stl", "#123456")], []);
  assert.equal(plan.singleExtruder, true);
  assert.ok(plan.warnings.some((w) => /no loaded filament slots/i.test(w)));
});

test("loaded:false slots are excluded from matching", () => {
  const slots: FilamentSlot[] = [
    { index: 0, colourHex: "#ff0000", loaded: false },
    { index: 1, colourHex: "#ff0000", loaded: true },
  ];
  const plan = planColours([part("/a.stl", "#ff0000")], slots);
  assert.equal(plan.assignments[0].extruder, 2);
});

test("toolChanges counts colour transitions between consecutive parts", () => {
  const slots: FilamentSlot[] = [
    { index: 0, colourHex: "#ff0000", loaded: true },
    { index: 1, colourHex: "#00ff00", loaded: true },
  ];
  const parts = [part("/a.stl", "#ff0000"), part("/b.stl", "#ff0000"), part("/c.stl", "#00ff00")];
  const plan = planColours(parts, slots);
  assert.equal(plan.toolChanges, 1);
  assert.equal(plan.wasteG, 3);
});
