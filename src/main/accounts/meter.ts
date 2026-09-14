// ─────────────────────────────────────────────────────────────────────────────
// The meter — charge a call, count a day, and pause when the day is spent.
//
// CHARGES ARE PER PROVIDER CALL, IMMEDIATELY. A turn is up to twelve calls, so
// charging once at the end would let a tool loop on an empty balance overspend
// twelvefold before anybody noticed. `chargeAccount` is what agent/funding.ts's
// `onUsage()` calls after every single call, and `guard()` re-reads the balance
// before the next one.
//
// THREE COUNTERS, THREE DIFFERENT JOBS:
//   • the ACCOUNT's `spentMicros` bounds what one person can spend (their grant);
//   • `spend/<day>.json` bounds what EVERYONE can spend today — the global kill
//     switch, and the only thing standing between a novel abuse pattern and the
//     owner's whole card;
//   • `chatDay`/`chatCount` bounds how many turns one person may START today,
//     which is what stops a cheap-per-turn account from occupying the server all
//     afternoon.
// A balance alone is not enough: the first is per person, the second is the
// blast radius, the third is throughput.
//
// EVERY READ-MODIFY-WRITE IS UNDER A LOCK. One process serving two tabs races
// on all three counters. The account's own lock is keyed on its id; the day's
// total is shared across accounts, so it gets its own lock keyed `spend:<day>`
// out of the same map (see store.ts's `withAccountLock` — the key is an
// arbitrary string precisely so this needs no second lock table).
//
// AND NOTHING IS WRITTEN FOR A CALL WE CANNOT PRICE. `priceFor` throws first,
// before the account is even read, so an unpriced model is a paused free tier
// rather than a call charged at zero. Metering at zero is the one failure mode
// that silently costs the owner real money.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, readFileSync } from "node:fs";
import { getConfig } from "../config";
import { centsToMicros, costMicros, priceFor, type TurnUsage } from "../pricing";
import { spendFile, usageFile, utcDay } from "./paths";
import {
  balanceMicros, getAccount, withAccountLock, writeAccount, writeAtomic,
  type Account,
} from "./store";

export interface ChargeResult {
  /** The balance AFTER this charge, floored at zero. */
  balanceMicros: number;
  chargedMicros: number;
  exhausted: boolean;
}

/**
 * The day's running total, cached by FILE PATH rather than by day string.
 *
 * The path carries the workdir, so a test that moves `SLICELY_WORKDIR` between
 * cases can never read another case's total out of this map — a cache keyed on
 * "2026-09-14" alone would.
 */
const dayTotals = new Map<string, number>();

/** What has been spent across ALL free accounts on `day`, in µ¢. */
export function dailySpendMicros(day: string = utcDay()): number {
  const path = spendFile(day);
  const hit = dayTotals.get(path);
  if (hit !== undefined) return hit;
  let micros = 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { micros?: unknown };
    if (typeof parsed.micros === "number" && Number.isFinite(parsed.micros) && parsed.micros > 0) {
      micros = Math.floor(parsed.micros);
    }
  } catch {
    /* no file yet, or unreadable — nothing spent is the honest reading */
  }
  dayTotals.set(path, micros);
  return micros;
}

/**
 * True when free credit is off for the day because the global cap is spent.
 *
 * The cap is the owner's blast radius, not a per-person limit: one runaway
 * pattern nobody predicted still cannot cost more than `SLICELY_DAILY_SPEND_CAP_CENTS`
 * in a day. `day` is a parameter rather than a clock read so a test can look at
 * tomorrow without mocking time.
 */
export function freeTierPaused(day: string = utcDay()): boolean {
  return dailySpendMicros(day) >= centsToMicros(getConfig().dailySpendCapCents);
}

/** Add to the day's global total, atomically and under its own lock — this
 *  number is shared across every account, so it cannot ride the account's. */
async function addDailySpend(day: string, micros: number): Promise<void> {
  await withAccountLock(`spend:${day}`, async () => {
    const path = spendFile(day);
    const next = dailySpendMicros(day) + micros;
    writeAtomic(path, JSON.stringify({ version: 1, micros: next }, null, 2));
    dayTotals.set(path, next);
  });
}

/**
 * Charge one provider call to one account: the balance, the ledger, the day.
 *
 * The order is load-bearing. `priceFor` first, so an unpriced model throws
 * before a byte is written. Then the account's own spend and `lastSeenAt`,
 * written atomically. Then the ledger line, appended (`a`), so a crash
 * truncates at most one line rather than corrupting the file. Then the day's
 * global total. All of it inside the account's lock, so two tabs cannot both
 * read the same balance and both spend it.
 */
export async function chargeAccount(
  accountId: string,
  model: string,
  usage: TurnUsage,
): Promise<ChargeResult> {
  // Before anything else, and before the lock does any work: a model with no
  // price row is never charged at zero.
  priceFor(model);
  const micros = costMicros(model, usage);
  const day = utcDay();

  return withAccountLock(accountId, async () => {
    const account = getAccount(accountId);
    // Charging a vanished account is a bug, not a user-facing condition: a plain
    // Error, so errors.ts turns it into a generic 500 and logs the stack rather
    // than inventing a sentence for something no visitor can act on.
    if (!account) throw new Error(`no such account: ${accountId}`);

    account.spentMicros += micros;
    account.lastSeenAt = Date.now();
    writeAccount(account);

    // The owner's audit trail and the input to any future invoice. No email, no
    // IP, no prompt — just which account, which model, how many tokens of each
    // kind, and what it cost.
    const line = JSON.stringify({
      ts: Date.now(),
      accountId,
      model,
      in: usage.inputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: usage.cacheWriteTokens,
      out: usage.outputTokens,
      micros,
    });
    appendFileSync(usageFile(day), `${line}\n`, { mode: 0o600 });

    await addDailySpend(day, micros);

    const balance = balanceMicros(account);
    return { balanceMicros: balance, chargedMicros: micros, exhausted: balance <= 0 };
  });
}

export interface ChatAllowance {
  allowed: boolean;
  used: number;
  limit: number;
}

/** How many turns this account has started today, without counting another.
 *  A `chatDay` in the past reads as zero used — the day has simply rolled over
 *  and the account file has not been touched since. */
export function chatAllowance(account: Account): ChatAllowance {
  const limit = getConfig().freeChatsPerDay;
  const used = account.chatDay === utcDay() ? account.chatCount : 0;
  return { allowed: used < limit, used, limit };
}

/**
 * Count one turn against the account's daily allowance, and say whether it may
 * proceed.
 *
 * This is the one that actually counts, and it is why `chatAllowance` exists
 * separately: the read-only check is the fast pre-flight path, and two tabs
 * asking it at the same moment would both be told yes. Under the lock, at most
 * `limit` turns can ever be counted, and a refusal does not increment — so the
 * forty-first attempt does not push the count to forty-one and lock the account
 * out of tomorrow's first turn as well.
 */
export async function countChatTurn(accountId: string): Promise<ChatAllowance> {
  return withAccountLock(accountId, async () => {
    const account = getAccount(accountId);
    if (!account) throw new Error(`no such account: ${accountId}`);
    const limit = getConfig().freeChatsPerDay;
    const today = utcDay();
    if (account.chatDay !== today) {
      account.chatDay = today;
      account.chatCount = 0;
    }
    if (account.chatCount >= limit) {
      return { allowed: false, used: account.chatCount, limit };
    }
    account.chatCount += 1;
    account.lastSeenAt = Date.now();
    writeAccount(account);
    return { allowed: true, used: account.chatCount, limit };
  });
}

/** Tests only: forget the cached daily totals, so a new workdir starts clean. */
export function resetMeterForTests(): void {
  dayTotals.clear();
}
