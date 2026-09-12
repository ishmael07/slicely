import { test } from "node:test";
import assert from "node:assert/strict";
import { getMode, isHosted, isDesktop } from "./mode";

test("unset SLICELY_MODE means hosted — the safe default is the one nobody has to set", () => {
  delete process.env.SLICELY_MODE;
  assert.equal(getMode(), "hosted");
  assert.equal(isHosted(), true);
  assert.equal(isDesktop(), false);
});

test("desktop is opt-in and anything else is rejected loudly", () => {
  process.env.SLICELY_MODE = "desktop";
  assert.equal(getMode(), "desktop");
  process.env.SLICELY_MODE = "banana";
  assert.throws(() => getMode(), /SLICELY_MODE/);
  delete process.env.SLICELY_MODE;
});
