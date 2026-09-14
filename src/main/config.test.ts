import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigForTests } from "./config";

test("the default workdir is not the repo (or ~/Slicely, which is the repo on a case-insensitive disk)", () => {
  const saved = process.env.SLICELY_WORKDIR;
  delete process.env.SLICELY_WORKDIR;
  resetConfigForTests();
  const cfg = getConfig();
  assert.equal(cfg.workdir, join(homedir(), "Slicely-data"));
  assert.notEqual(cfg.workdir, join(homedir(), "Slicely"));
  if (saved !== undefined) process.env.SLICELY_WORKDIR = saved;
  resetConfigForTests();
});

test("SLICELY_WORKDIR still wins", () => {
  process.env.SLICELY_WORKDIR = "/tmp/slicely-test-workdir";
  resetConfigForTests();
  assert.equal(getConfig().workdir, "/tmp/slicely-test-workdir");
  delete process.env.SLICELY_WORKDIR;
  resetConfigForTests();
});

test("the four money and limit caps may be set to zero — that is the kill switch", () => {
  const saved = { ...process.env };
  try {
    // Zero has to MEAN zero for these four, or there is no way to turn the free
    // tier off from the environment: the owner's only other option is to unset
    // the OAuth client or the provider key, which also takes sign-in away.
    process.env.SLICELY_FREE_CREDIT_CENTS = "0";
    process.env.SLICELY_DAILY_SPEND_CAP_CENTS = "0";
    process.env.SLICELY_SIGNUPS_PER_IP_PER_DAY = "0";
    process.env.SLICELY_FREE_CHATS_PER_DAY = "0";
    // And not for these, where zero is a broken app rather than a policy.
    process.env.SLICELY_MAX_SLICES = "0";
    process.env.SLICELY_FREE_MAX_OUTPUT_TOKENS = "0";
    process.env.SLICELY_MAX_HISTORY_TURNS = "0";
    resetConfigForTests();
    const cfg = getConfig();
    assert.equal(cfg.freeCreditCents, 0);
    assert.equal(cfg.dailySpendCapCents, 0);
    assert.equal(cfg.signupsPerIpPerDay, 0);
    assert.equal(cfg.freeChatsPerDay, 0);
    assert.equal(cfg.maxSlices, 2, "a slicer concurrency of zero would just stop the app");
    assert.equal(cfg.freeMaxOutputTokens, 4000);
    assert.equal(cfg.maxHistoryTurns, 12);

    // A negative is still nonsense everywhere, and so is a non-number.
    process.env.SLICELY_FREE_CREDIT_CENTS = "-1";
    process.env.SLICELY_FREE_CHATS_PER_DAY = "lots";
    resetConfigForTests();
    const bad = getConfig();
    assert.equal(bad.freeCreditCents, 50);
    assert.equal(bad.freeChatsPerDay, 40);
  } finally {
    for (const name of ["SLICELY_FREE_CREDIT_CENTS", "SLICELY_DAILY_SPEND_CAP_CENTS",
                        "SLICELY_SIGNUPS_PER_IP_PER_DAY", "SLICELY_FREE_CHATS_PER_DAY",
                        "SLICELY_MAX_SLICES", "SLICELY_FREE_MAX_OUTPUT_TOKENS",
                        "SLICELY_MAX_HISTORY_TURNS"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetConfigForTests();
  }
});
