// The agent can only ask for what the tool schema lets it say.
//
// slice_model, slice_and_open and open_in_slicer took ONE filamentColour, so
// "make it teal and black" could not be expressed and one colour was dropped
// on the way in. These assertions are about the surface, not the plumbing: a
// schema that loses an argument loses it silently, with no failing slice to
// point at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./tools";

function propsOf(name: string): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return ((tool!.schema.properties ?? {}) as Record<string, unknown>) ?? {};
}

for (const name of ["slice_model", "slice_and_open", "open_in_slicer"]) {
  test(`${name} can be told more than one colour`, () => {
    const props = propsOf(name);
    assert.ok(props.filamentColour, "one colour must still be expressible");
    assert.ok(props.colours, "several colours must be expressible");
    assert.ok(props.colourStops, "colours at named heights must be expressible");
  });
}

test("plan_job accepts colour stops as well as equal bands", () => {
  const props = propsOf("plan_job");
  assert.ok(props.colourBands);
  assert.ok(props.colourStops);
});

test("a colour stop must say what colour, and may say where in any of three ways", () => {
  const stops = propsOf("slice_model").colourStops as {
    items: { properties: Record<string, unknown>; required: string[] };
  };
  assert.deepEqual(stops.items.required, ["colourHex"]);
  for (const key of ["atZ", "atLayer", "atFraction"]) {
    assert.ok(stops.items.properties[key], `a stop must be expressible ${key}`);
  }
});

test("filamentColour's description sends more than one colour elsewhere", () => {
  // The schema text is the only place the model learns not to collapse two
  // colours into one. Losing that line reintroduces the bug with every test
  // still green.
  const desc = String((propsOf("slice_model").filamentColour as { description: string }).description);
  assert.match(desc, /colourStops|colours/, "it must name the multi-colour argument");
  assert.match(desc, /single|ONE/i, "it must say it is for one colour only");
});

test("per-extruder settings are dropped before slicing a multi-extruder project", async () => {
  // PrusaSlicer's precedence is overrides > --load, and an override REPLACES a
  // vector rather than filling one slot of it. Sending "--nozzle-diameter 0.4"
  // to a two-extruder config leaves a one-extruder printer, and painting that
  // referred to the second colour prints in one. Verified against 2.9.5 on a
  // real MakerWorld model: 32 tool changes without these, 0 with them.
  const { withoutPerExtruderOverrides } = await import("./tools");
  const stripped = withoutPerExtruderOverrides({
    layerHeightMm: 0.2,
    fillDensityPct: 20,
    perimeters: 3,
    nozzleDiameterMm: 0.4,
    filamentColour: "#000000",
  });
  assert.equal(stripped.nozzleDiameterMm, undefined, "a scalar nozzle collapses the vector");
  assert.equal(stripped.filamentColour, undefined, "so does a scalar colour");
  assert.equal(stripped.layerHeightMm, 0.2, "scalars must survive untouched");
  assert.equal(stripped.fillDensityPct, 20);
  assert.equal(stripped.perimeters, 3);
});
