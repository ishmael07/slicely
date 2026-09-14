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
//
// WHICH IS ALSO WHY EVERY NUMBER FROM OUTSIDE IS SANITISED, AND WHY EVERY
// UNREADABLE NUMBER FAILS CLOSED. A provider SDK that omits a usage field, a
// half-written counter, a hand-edited account file — each hands this module a
// `NaN`, and `NaN` is the worst possible value here: it is not > 0, so it
// silently passes every cap, and once written it reads back out of JSON as
// `null`, which is not > 0 either. So:
//
//   • `sanitizeUsage` floors every token count at zero before it is priced;
//   • a cost that is not a safe non-negative integer THROWS and writes nothing;
//   • an unreadable `spend/<day>.json` reads as the whole daily cap, so the free
//     tier is paused rather than uncapped;
//   • an unreadable `spentMicros` reads as the whole grant spent (store.ts's
//     `balanceMicros`), so the account is exhausted rather than unlimited.
//
// In every case the failure costs a visitor a refusal and the owner nothing,
// which is the right way round: the alternative is a corrupt byte on disk
// turning the kill switch off.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, readFileSync } from "node:fs";
import { getConfig } from "../config";
import { centsToMicros, costMicros, priceFor, type TurnUsage } from "../pricing";
import { spendFile, usageFile, utcDay } from "./paths";
import {
  balanceMicros, getAccount, safeSpentMicros, withAccountLock, writeAccount, writeAtomic,
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
 *
 * `null` is a real entry and means CORRUPT: the file is there but its `micros`
 * is not a usable number, so we do not know what has been spent today. It is
 * cached like any other answer, because re-parsing the same broken file on every
 * request would also re-log on every request.
 */
const dayTotals = new Map<string, number | null>();

/** Corruptions already reported, so a broken counter costs one log line rather
 *  than one per request for the life of the deploy. */
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[meter] ${message}`);
}

/**
 * What `spend/<day>.json` says, or `null` when it cannot be read as a number.
 *
 * A MISSING FILE IS ZERO; A BROKEN FILE IS `null`. The distinction is the whole
 * point: nobody has spent anything on a day that has not started, but a day
 * whose counter is unreadable might have spent the entire card, and the two must
 * not answer the same way.
 */
function readDaySpend(day: string): number | null {
  const path = spendFile(day);
  const hit = dayTotals.get(path);
  if (hit !== undefined) return hit;

  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No file yet — nothing has been spent, which IS the honest reading.
    dayTotals.set(path, 0);
    return 0;
  }

  let value: number | null = null;
  try {
    const parsed = JSON.parse(raw) as { micros?: unknown };
    const micros = parsed?.micros;
    if (typeof micros === "number" && Number.isFinite(micros) && micros >= 0) {
      value = Math.floor(micros);
    }
  } catch {
    /* value stays null */
  }
  if (value === null) {
    warnOnce(`${path} is unreadable — free credit is paused for ${day}. Fix or delete the file.`);
  }
  dayTotals.set(path, value);
  return value;
}

/**
 * What has been spent across ALL free accounts on `day`, in µ¢.
 *
 * A day whose counter is corrupt reads as the whole cap, so every caller — not
 * just `freeTierPaused` — sees "the day is spent" rather than "nothing spent".
 */
export function dailySpendMicros(day: string = utcDay()): number {
  const value = readDaySpend(day);
  return value === null ? centsToMicros(getConfig().dailySpendCapCents) : value;
}

/**
 * True when free credit is off for the day because the global cap is spent.
 *
 * The cap is the owner's blast radius, not a per-person limit: one runaway
 * pattern nobody predicted still cannot cost more than `SLICELY_DAILY_SPEND_CAP_CENTS`
 * in a day. `day` is a parameter rather than a clock read so a test can look at
 * tomorrow without mocking time.
 *
 * A corrupt counter pauses the day outright rather than via the comparison, so
 * this stays true even where a cap of 0 makes the arithmetic ambiguous.
 */
export function freeTierPaused(day: string = utcDay()): boolean {
  const spent = readDaySpend(day);
  if (spent === null) return true;
  return spent >= centsToMicros(getConfig().dailySpendCapCents);
}

/** Add to the day's global total, atomically and under its own lock — this
 *  number is shared across every account, so it cannot ride the account's. */
async function addDailySpend(day: string, micros: number): Promise<void> {
  await withAccountLock(`spend:${day}`, async () => {
    const path = spendFile(day);
    const current = readDaySpend(day);
    // A CORRUPT COUNTER IS LEFT EXACTLY AS IT IS. The day is already paused (see
    // `freeTierPaused`), and the two alternatives are both worse: adding to a
    // number we could not read invents a total, and overwriting the file with
    // this one charge silently clears the pause and forgets the rest of the day.
    if (current === null) return;
    const next = current + micros;
    writeAtomic(path, JSON.stringify({ version: 1, micros: next }, null, 2));
    dayTotals.set(path, next);
  });
}

/**
 * One token count as a number we may safely multiply by a price: a non-negative
 * integer, or zero.
 *
 * `undefined` (a field the provider omitted), `NaN`, `Infinity` and negatives
 * all become 0. A NEGATIVE COUNT IS NOT A REFUND: allowing one would let a
 * single call with `inputTokens: -1e9` hand an account more credit than it was
 * granted, and the day's global counter along with it.
 */
function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One provider call's usage with every field sanitised — what gets priced, what
 *  gets charged, and what the ledger records, all the same numbers. */
function sanitizeUsage(usage: TurnUsage): TurnUsage {
  return {
    inputTokens: tokens(usage?.inputTokens),
    cachedInputTokens: tokens(usage?.cachedInputTokens),
    cacheWriteTokens: tokens(usage?.cacheWriteTokens),
    outputTokens: tokens(usage?.outputTokens),
  };
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
  rawUsage: TurnUsage,
): Promise<ChargeResult> {
  // Before anything else, and before the lock does any work: a model with no
  // price row is never charged at zero.
  priceFor(model);
  const usage = sanitizeUsage(rawUsage);
  const micros = costMicros(model, usage);
  // AND NOTHING IS WRITTEN FOR A COST WE CANNOT REPRESENT. Sanitised tokens
  // cannot produce a NaN, but they can produce a number past 2^53 — a token
  // count of MAX_SAFE_INTEGER times a price is no longer an integer, and adding
  // it to `spentMicros` would corrupt the account's whole arithmetic. Refusing
  // here is the same rule as an unpriced model: a paused turn, never a bad write.
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error(`refusing to charge an unrepresentable cost for ${model}: ${String(micros)}`);
  }
  const day = utcDay();

  return withAccountLock(accountId, async () => {
    const account = getAccount(accountId);
    // Charging a vanished account is a bug, not a user-facing condition: a plain
    // Error, so errors.ts turns it into a generic 500 and logs the stack rather
    // than inventing a sentence for something no visitor can act on.
    if (!account) throw new Error(`no such account: ${accountId}`);

    // A CORRUPT RUNNING TOTAL READS AS THE WHOLE GRANT SPENT. `NaN + micros` is
    // `NaN`, which JSON writes as `null` and the next read treats as plenty of
    // credit left — so a single bad byte would make one account unlimited
    // forever. Failing closed costs that account its remaining credit and costs
    // the owner nothing, and `balanceMicros` already reports it as exhausted.
    account.spentMicros = safeSpentMicros(account) + micros;
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

/** Tests only: forget the cached daily totals (including the `null` that marks a
 *  corrupt counter) and which corruptions have been reported, so a new workdir —
 *  or a file a test has just rewritten — starts clean. */
export function resetMeterForTests(): void {
  dayTotals.clear();
  warned.clear();
}
