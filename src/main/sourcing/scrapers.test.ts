// The three scraped meta-search engines are off by default.
//
// They sit behind bot protection that refuses an honestly-identified request,
// so they return nothing — while Yeggi alone spent 10,003ms of a 10,265ms
// search timing out. Turning them off took the same search to 1,191ms with
// identical results. This pins that default, and the escape hatch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { yeggiProvider } from "./providers/yeggi";
import { thangsProvider } from "./providers/thangs";
import { stlfinderProvider } from "./providers/stlfinder";

const SCRAPERS = [yeggiProvider, thangsProvider, stlfinderProvider];

function withFlag(value: string | undefined, fn: () => void): void {
  const prev = process.env.SLICELY_ENABLE_SCRAPERS;
  if (value === undefined) delete process.env.SLICELY_ENABLE_SCRAPERS;
  else process.env.SLICELY_ENABLE_SCRAPERS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SLICELY_ENABLE_SCRAPERS;
    else process.env.SLICELY_ENABLE_SCRAPERS = prev;
  }
}

test("bot-blocked engines are off unless explicitly enabled", () => {
  withFlag(undefined, () => {
    for (const p of SCRAPERS) {
      const a = p.availability();
      assert.equal(a.searchable, false, `${p.id} should be off by default`);
      assert.equal(a.status, "off", `${p.id} should report the off status`);
      // How to turn it back on is the operator's line, not the visitor's.
      assert.match(
        a.operatorHint ?? "",
        /SLICELY_ENABLE_SCRAPERS/,
        `${p.id} should say how to turn it back on`,
      );
      assert.doesNotMatch(a.note, /SLICELY_ENABLE_SCRAPERS/, `${p.id}'s note is user-facing`);
      assert.match(
        a.blockedReason ?? "",
        /SLICELY_ENABLE_SCRAPERS/,
        `${p.id} should keep the fuller sentence for diagnostics`,
      );
    }
  });
});

test("the flag turns them back on, since the block is theirs and may lift", () => {
  for (const value of ["1", "true", "yes"]) {
    withFlag(value, () => {
      for (const p of SCRAPERS) {
        assert.equal(p.availability().searchable, true, `${p.id} with flag=${value}`);
      }
    });
  }
});

test("an unrelated value does not accidentally enable them", () => {
  for (const value of ["0", "false", "no", ""]) {
    withFlag(value, () => {
      for (const p of SCRAPERS) {
        assert.equal(p.availability().searchable, false, `${p.id} with flag=${value}`);
      }
    });
  }
});
