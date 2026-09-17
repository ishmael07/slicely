// The admin summary is derived from files the accounts module writes. What
// has to hold: accounts are counted and rowed from by-id, the ledger and the
// spend counter roll up per day, a corrupt spend file reads as "unknown" (null)
// and never as 0, bad ledger lines are skipped, and the waitlist comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { findOrCreateAccount, resetAccountsForTests } from "./store";
import { addToWaitlist, resetWaitlistForTests } from "./waitlist";
import { utcDay } from "./paths";
import { normalizeEmail } from "./email";
import { adminSummary, lastDays, readLedger, readSpend } from "./admin-summary";

process.env.SLICELY_MODE = "hosted";

function fresh(): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "slicely-admin-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetAccountsForTests();
  resetWaitlistForTests();
  return {
    root,
    close: () => {
      delete process.env.SLICELY_WORKDIR;
      resetConfigForTests();
      resetAccountsForTests();
      resetWaitlistForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function ledgerLine(accountId: string, model: string, micros: number, ts = Date.now()): string {
  return JSON.stringify({ ts, accountId, model, in: 100, cacheRead: 50, cacheWrite: 0, out: 20, micros });
}

test("lastDays ends today and is oldest first", () => {
  const now = Date.UTC(2026, 8, 17, 12);
  const days = lastDays(3, now);
  assert.deepEqual(days, ["2026-09-15", "2026-09-16", "2026-09-17"]);
});

test("accounts, ledger, spend and waitlist roll up into one summary", () => {
  const f = fresh();
  try {
    const grant = 50 * 1_000_000; // 50¢ in µ¢
    const profile = (provider: "github" | "google", providerUserId: string, email: string, name?: string) => ({
      provider,
      providerUserId,
      email,
      normalizedEmail: normalizeEmail(email).normalized,
      ...(name ? { name } : {}),
    });
    const a = findOrCreateAccount(profile("github", "1", "Owner.Person@gmail.com", "Owner"), grant);
    const b = findOrCreateAccount(profile("google", "2", "b@example.com"), grant);
    assert.ok(a.account && b.account);

    const today = utcDay();
    const usageDir = join(f.root, "accounts", "usage");
    const spendDir = join(f.root, "accounts", "spend");
    mkdirSync(usageDir, { recursive: true });
    mkdirSync(spendDir, { recursive: true });
    writeFileSync(
      join(usageDir, `${today}.ndjson`),
      [ledgerLine(a.account.id, "claude-sonnet-5", 3_000_000), "not json", ledgerLine(b.account.id, "claude-sonnet-5", 1_000_000), ""].join("\n"),
    );
    writeFileSync(join(spendDir, `${today}.json`), JSON.stringify({ version: 1, micros: 4_000_000 }));
    addToWaitlist({ ts: Date.now(), email: "later@example.com", name: "Later" });

    const s = adminSummary(7);

    assert.equal(s.users.total, 2);
    assert.equal(s.users.newToday, 2);
    assert.equal(s.users.active24h, 2);
    assert.equal(s.sessions, 7);
    assert.equal(s.credit.grantedMicros, 2 * grant);
    assert.equal(s.credit.spentTodayMicros, 4_000_000);
    assert.equal(s.usage.callsToday, 2, "the bad line is skipped, the two good ones count");
    assert.deepEqual(s.usage.byModel, [{ model: "claude-sonnet-5", calls: 2, micros: 4_000_000 }]);
    const last = s.usage.days[s.usage.days.length - 1];
    assert.equal(last.day, today);
    assert.equal(last.ledgerMicros, 4_000_000);
    assert.equal(last.tokensIn, 300);
    assert.equal(s.waitlist.count, 1);
    assert.equal(s.waitlist.entries[0].email, "later@example.com");
    const owner = s.accounts.find((r) => r.email === "Owner.Person@gmail.com");
    assert.ok(owner);
    assert.equal(owner.provider, "github");
    assert.equal(owner.balanceMicros, grant);
  } finally {
    f.close();
  }
});

test("a corrupt spend counter is unknown, never zero; a missing one is zero", () => {
  const f = fresh();
  try {
    const day = utcDay();
    const spendDir = join(f.root, "accounts", "spend");
    mkdirSync(spendDir, { recursive: true });
    writeFileSync(join(spendDir, `${day}.json`), "{ not json");
    assert.equal(readSpend(day), null);
    assert.equal(readSpend("2000-01-01"), 0);
    assert.equal(adminSummary(0).credit.spentTodayMicros, null);
  } finally {
    f.close();
  }
});

test("an empty deployment summarises to zeros without creating errors", () => {
  const f = fresh();
  try {
    const s = adminSummary(0);
    assert.equal(s.users.total, 0);
    assert.equal(s.usage.callsToday, 0);
    assert.equal(s.waitlist.count, 0);
    assert.equal(s.usage.days.length, 14);
    assert.deepEqual(readLedger(utcDay()), []);
  } finally {
    f.close();
  }
});
