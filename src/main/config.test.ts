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
