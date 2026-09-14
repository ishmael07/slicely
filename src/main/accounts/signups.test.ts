import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { hashIp, countSignup, signupAllowance, resetSignupsForTests } from "./signups";
import { signupsFile, utcDay } from "./paths";

function freshWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "slicely-signups-"));
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  resetSignupsForTests();
  return dir;
}

test("an address is hashed, stably, and is not recoverable from the hash", () => {
  const dir = freshWorkdir();
  try {
    const h = hashIp("1.2.3.4");
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.equal(hashIp("1.2.3.4"), h, "stable across calls");
    assert.notEqual(hashIp("1.2.3.5"), h, "one address per counter");
    assert.ok(!h.includes("1.2.3.4"), "the address itself is never in the hash");
    assert.ok(!hashIp("2001:db8::1").includes("2001"), "nor for IPv6");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("three signups an address a day, and the fourth is refused", () => {
  const dir = freshWorkdir();
  try {
    assert.deepEqual(signupAllowance("1.2.3.4"), { allowed: true, used: 0, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: true, used: 1, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: true, used: 2, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: true, used: 3, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: false, used: 3, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: false, used: 3, limit: 3 },
      "a refusal does not keep counting");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the counter file holds no address, in either family", () => {
  const dir = freshWorkdir();
  try {
    countSignup("198.51.100.7");
    countSignup("2001:db8::dead:beef");
    const raw = readFileSync(signupsFile(utcDay()), "utf8");
    assert.ok(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(raw), "no dotted quad");
    assert.ok(!/[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i.test(raw), "no IPv6 literal");
    assert.ok(!raw.includes("198.51.100.7"));
    assert.ok(!raw.includes("2001:db8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a different address has its own budget", () => {
  const dir = freshWorkdir();
  try {
    countSignup("1.2.3.4");
    countSignup("1.2.3.4");
    countSignup("1.2.3.4");
    assert.equal(countSignup("1.2.3.4").allowed, false);
    assert.deepEqual(countSignup("5.6.7.8"), { allowed: true, used: 1, limit: 3 },
      "one address being out does not lock out the next visitor");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the counts survive a restart — the salt and the file are both on disk", () => {
  const dir = freshWorkdir();
  try {
    countSignup("1.2.3.4");
    countSignup("1.2.3.4");
    countSignup("1.2.3.4");
    resetSignupsForTests();                 // as if the server restarted
    assert.deepEqual(signupAllowance("1.2.3.4"), { allowed: false, used: 3, limit: 3 });
    assert.deepEqual(countSignup("1.2.3.4"), { allowed: false, used: 3, limit: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
