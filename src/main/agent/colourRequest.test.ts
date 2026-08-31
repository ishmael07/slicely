// Turning what a user said about colour into something the pipeline can act on.
//
// The failure this replaces: slice_model and open_in_slicer took a single
// `filamentColour` string, so "make it teal and black" had nowhere to put the
// second colour and one of them was silently dropped. A request naming two
// colours is a two-colour print, and has to survive as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { colourRequest } from "./colourRequest";

test("one colour is a plain filament colour, not a band", () => {
  const req = colourRequest({ filamentColour: "#000000" });
  assert.equal(req.filamentColour, "#000000");
  assert.deepEqual(req.bands, []);
  assert.equal(req.isMultiColour, false);
});

test("two colours become bands, bottom first, and the print starts in the first", () => {
  const req = colourRequest({ colours: ["#008080", "#000000"] });
  assert.deepEqual(req.bands, ["#008080", "#000000"]);
  assert.equal(req.filamentColour, "#008080", "the plate should open in the colour it starts in");
  assert.equal(req.isMultiColour, true);
});

test("a single entry in `colours` is the same as naming one colour", () => {
  const req = colourRequest({ colours: ["#C81E1E"] });
  assert.equal(req.filamentColour, "#c81e1e");
  assert.deepEqual(req.bands, []);
  assert.equal(req.isMultiColour, false);
});

test("explicit stops are kept as stops and are multi-colour", () => {
  const req = colourRequest({
    colourStops: [
      { atZ: 0, colourHex: "#000000" },
      { atZ: 5, colourHex: "#008080" },
    ],
  });
  assert.equal(req.stops.length, 2);
  assert.equal(req.isMultiColour, true);
  assert.equal(req.filamentColour, "#000000", "the stop at the bed is the starting colour");
});

test("stops win over bands — naming a height is the more specific request", () => {
  const req = colourRequest({
    colours: ["#FF0000", "#00FF00"],
    colourStops: [{ atZ: 5, colourHex: "#0000FF" }],
  });
  assert.equal(req.stops.length, 1);
  assert.deepEqual(req.bands, [], "bands must not fight the stops");
});

test("colours that are not colours are dropped rather than guessed at", () => {
  const req = colourRequest({ colours: ["teal", "#000000"] });
  assert.deepEqual(req.bands, [], "one usable colour is not two colours");
  assert.equal(req.filamentColour, "#000000");
});

test("short hex and missing hashes are accepted, because people type them", () => {
  const req = colourRequest({ colours: ["0f0", "000"] });
  assert.deepEqual(req.bands, ["#00ff00", "#000000"]);
});

test("saying nothing about colour asks for nothing", () => {
  const req = colourRequest({});
  assert.equal(req.filamentColour, undefined);
  assert.deepEqual(req.bands, []);
  assert.deepEqual(req.stops, []);
  assert.equal(req.isMultiColour, false);
});

test("an explicit filamentColour is not overridden by a single-entry colours list", () => {
  const req = colourRequest({ filamentColour: "#111111", colours: ["#222222"] });
  assert.equal(req.filamentColour, "#111111");
});
