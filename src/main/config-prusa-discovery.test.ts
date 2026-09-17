// A packaged Mac app has no .env, so it has to find PrusaSlicer itself. The
// shipped 0.2.0 looked in exactly one place and told a Mac that slices daily
// that PrusaSlicer "isn't installed": Prusa's driver package installs it under
// "/Applications/Original Prusa Drivers/". Discovery must try that too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverPrusaSlicer, prusaSlicerCandidates } from "./config";

test("candidates cover the plain install, Prusa's driver package, and ~/Applications", () => {
  const c = prusaSlicerCandidates("/Users/x");
  assert.ok(c.includes("/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"));
  assert.ok(c.includes("/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"));
  assert.ok(c.includes("/Users/x/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"));
  assert.equal(c[0], "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer");
});

test("the first existing candidate wins", () => {
  const driverPkg = "/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer";
  assert.equal(discoverPrusaSlicer(prusaSlicerCandidates("/Users/x"), (p) => p === driverPkg), driverPkg);
});

test("nothing found falls back to the conventional path, so the error can name it", () => {
  assert.equal(
    discoverPrusaSlicer(prusaSlicerCandidates("/Users/x"), () => false),
    "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
  );
});
