// ─────────────────────────────────────────────────────────────────────────────
// action-label.test.ts — what a hand-over button is allowed to promise.
//
// The transcript bug had a twin on screen: hosted Slicely runs the slicer on a
// server, and the button under the reply still said "Open in PrusaSlicer". It
// downloads a file; no window opens anywhere the visitor can see. Two words of
// wording are the whole difference between an honest button and a broken one, so
// they get a test of their own.
//
// Runs in Node and touches no DOM — downloadLabel is pure, which is exactly why
// it was extracted.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadLabel } from "./chat.js";

test("hosted buttons say Download, because that is all they do", () => {
  assert.equal(downloadLabel("project", true), "Download .3mf");
  assert.equal(downloadLabel("gcode", true), "Download G-code");
  for (const what of ["project", "gcode"] as const) {
    const label = downloadLabel(what, true);
    assert.ok(!/PrusaSlicer|Finder|Open/.test(label), `hosted label promises a window: ${label}`);
  }
});

test("the Mac app keeps the wording that is true there", () => {
  // `window.slicely` exists, the file is on this machine, and the .3mf really
  // does open in the app — see cards.ts, which gates its own native buttons the
  // same way.
  assert.equal(downloadLabel("project", false), "Open in PrusaSlicer");
  assert.equal(downloadLabel("gcode", false), "G-code");
});
