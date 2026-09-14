import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { centsToMicros, costMicros, UnpricedModelError, type TurnUsage } from "../pricing";
import {
  findOrCreateAccount, getAccount, resetAccountsForTests, writeAccount,
  type Account, type SignInProfile,
} from "./store";
import {
  chargeAccount, dailySpendMicros, freeTierPaused, countChatTurn, chatAllowance,
  resetMeterForTests,
} from "./meter";
import { usageFile, spendFile, utcDay } from "./paths";

function freshWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "slicely-meter-"));
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  resetAccountsForTests();
  resetMeterForTests();
  return dir;
}

const GRANT = centsToMicros(50);

function profile(over: Partial<SignInProfile> = {}): SignInProfile {
  return {
    provider: "google",
    providerUserId: "107812345",
    email: "Jane.Doe@gmail.com",
    normalizedEmail: "janedoe@gmail.com",
    name: "Jane Doe",
    ...over,
  };
}

function newAccount(): Account {
  return findOrCreateAccount(profile(), GRANT).account;
}

/** The spec §4.3 worked example: one "find me a phone stand" turn. 4,714,000 µ¢. */
const SPEC_USAGE: TurnUsage = {
  inputTokens: 8_670,
  cachedInputTokens: 18_000,
  cacheWriteTokens: 6_000,
  outputTokens: 1_120,
};

/** Exactly 1,000 µ¢ on claude-sonnet-5 (5 input tokens × 200¢/1M). */
const TINY_USAGE: TurnUsage = {
  inputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function ledgerLines(day = utcDay()): string[] {
  return readFileSync(usageFile(day), "utf8").split("\n").filter((l) => l.length > 0);
}

test("one charge moves the balance, the ledger and the day's total by the same amount", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    const result = await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);
    assert.equal(result.chargedMicros, 4_714_000);
    assert.equal(result.balanceMicros, 45_286_000);
    assert.equal(result.exhausted, false);
    assert.equal(getAccount(account.id)!.spentMicros, 4_714_000);
    assert.equal(ledgerLines().length, 1, "exactly one ledger line per provider call");
    assert.equal(dailySpendMicros(), 4_714_000);
    assert.equal(
      (JSON.parse(readFileSync(spendFile(utcDay()), "utf8")) as { micros: number }).micros,
      4_714_000,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a ledger line is the audit trail and nothing else — no email, no IP, no prompt", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);
    const line = JSON.parse(ledgerLines()[0]) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(line).sort(),
      ["accountId", "cacheRead", "cacheWrite", "in", "micros", "model", "out", "ts"],
    );
    assert.equal(line.accountId, account.id);
    assert.equal(line.model, "claude-sonnet-5");
    assert.equal(line.in, 8_670);
    assert.equal(line.cacheRead, 18_000);
    assert.equal(line.cacheWrite, 6_000);
    assert.equal(line.out, 1_120);
    assert.equal(line.micros, costMicros("claude-sonnet-5", SPEC_USAGE));
    assert.equal(typeof line.ts, "number");
    const raw = readFileSync(usageFile(utcDay()), "utf8");
    for (const forbidden of ["janedoe", "gmail", "127.0.0.1", "phone stand", "sk-"]) {
      assert.ok(!raw.includes(forbidden), `${forbidden} must never reach the ledger`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the eleventh turn like that empties the grant, and the balance floors at zero", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    let last = await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);
    for (let i = 1; i < 11; i += 1) {
      last = await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);
    }
    assert.equal(last.balanceMicros, 0, "floored, never negative");
    assert.equal(last.exhausted, true);
    assert.equal(ledgerLines().length, 11);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unpriced model is refused before anything is written", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    await assert.rejects(
      () => chargeAccount(account.id, "claude-imaginary-9", SPEC_USAGE),
      UnpricedModelError,
    );
    assert.equal(getAccount(account.id)!.spentMicros, 0);
    assert.equal(existsSync(usageFile(utcDay())), false, "no ledger line for a call we cannot price");
    assert.equal(existsSync(spendFile(utcDay())), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the day has a ceiling, and tomorrow is a new day", async () => {
  const dir = freshWorkdir();
  try {
    assert.equal(freeTierPaused(), false, "nothing spent yet");
    process.env.SLICELY_DAILY_SPEND_CAP_CENTS = "1";   // 1¢ = 1,000,000 µ¢
    resetConfigForTests();
    const account = newAccount();
    await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);
    assert.equal(freeTierPaused(), true, "4.7¢ is over a 1¢ cap");
    const tomorrow = utcDay(Date.now() + 24 * 60 * 60 * 1000);
    assert.equal(dailySpendMicros(tomorrow), 0);
    assert.equal(freeTierPaused(tomorrow), false, "the cap is per UTC day");
  } finally {
    delete process.env.SLICELY_DAILY_SPEND_CAP_CENTS;
    resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forty chats a day, and the forty-first is refused without counting", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    assert.deepEqual(await countChatTurn(account.id), { allowed: true, used: 1, limit: 40 });
    for (let i = 2; i <= 40; i += 1) {
      assert.deepEqual(await countChatTurn(account.id), { allowed: true, used: i, limit: 40 });
    }
    assert.deepEqual(await countChatTurn(account.id), { allowed: false, used: 40, limit: 40 });
    assert.equal(getAccount(account.id)!.chatCount, 40, "a refusal does not count");
    assert.deepEqual(chatAllowance(getAccount(account.id)!), { allowed: false, used: 40, limit: 40 });

    // Yesterday's count is not today's.
    const live = getAccount(account.id)!;
    live.chatDay = utcDay(Date.now() - 24 * 60 * 60 * 1000);
    writeAccount(live);
    assert.deepEqual(chatAllowance(live), { allowed: true, used: 0, limit: 40 });
    assert.deepEqual(await countChatTurn(account.id), { allowed: true, used: 1, limit: 40 });
    assert.equal(getAccount(account.id)!.chatDay, utcDay());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("twenty concurrent charges lose nothing", async () => {
  const dir = freshWorkdir();
  try {
    const account = newAccount();
    await Promise.all(
      Array.from({ length: 20 }, () => chargeAccount(account.id, "claude-sonnet-5", TINY_USAGE)),
    );
    resetAccountsForTests();
    assert.equal(getAccount(account.id)!.spentMicros, 20_000, "no lost charge");
    assert.equal(ledgerLines().length, 20);
    assert.equal(dailySpendMicros(), 20_000, "and the day's total agrees");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
