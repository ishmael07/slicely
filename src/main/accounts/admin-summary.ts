// ─────────────────────────────────────────────────────────────────────────────
// What the owner's admin page shows, read from the accounts directory.
//
// READ-ONLY. Every number here is derived from files the rest of this module
// already writes — by-id/*.json, usage/<day>.ndjson, spend/<day>.json,
// waitlist.ndjson — and nothing is written back. Money is µ¢ integers
// throughout, as in meter.ts; the page converts for display.
//
// Two honesty rules carried over from meter.ts: a day whose spend counter is
// corrupt is reported as `null` ("unknown"), never 0; a ledger line that does
// not parse is skipped rather than guessed at.
//
// HOSTED ONLY, like everything in this directory: merely asking for one of the
// paths creates its folder, so desktop code must never call `adminSummary()`.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getConfig } from "../config";
import { byIdDir, spendFile, usageFile, utcDay, waitlistFile } from "./paths";
import { balanceMicros, getAccount, safeGrantedMicros, safeSpentMicros, type Account, type AccountProvider } from "./store";
import type { WaitlistEntry } from "./waitlist";

const DAY_MS = 86_400_000;
/** How far back the spend/usage series goes. Two weeks reads on one screen. */
export const SUMMARY_DAYS = 14;

export interface AdminAccountRow {
  id: string;
  email: string;
  provider: AccountProvider;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
  grantedMicros: number;
  spentMicros: number;
  balanceMicros: number;
  /** Turns started today (UTC); 0 when the account's counter is for another day. */
  chatsToday: number;
  blocked: boolean;
}

export interface AdminDay {
  day: string;
  /** The global counter for the day; `null` when its file is corrupt. */
  spendMicros: number | null;
  /** From the ledger: what this page can prove was billed, line by line. */
  calls: number;
  ledgerMicros: number;
  tokensIn: number;
  tokensOut: number;
}

export interface AdminModelRow {
  model: string;
  calls: number;
  micros: number;
}

export interface AdminSummary {
  generatedAt: number;
  today: string;
  users: { total: number; newToday: number; new7d: number; active24h: number; blocked: number };
  credit: {
    grantedMicros: number;
    spentMicros: number;
    /** Today's global counter, or `null` if its file is corrupt. */
    spentTodayMicros: number | null;
    dailyCapMicros: number;
  };
  usage: { callsToday: number; calls7d: number; byModel: AdminModelRow[]; days: AdminDay[] };
  /** Live sessions in this process — visitors, signed in or not. */
  sessions: number;
  waitlist: { count: number; entries: Array<Pick<WaitlistEntry, "ts" | "email" | "name">> };
  accounts: AdminAccountRow[];
}

/** One ledger line as meter.ts writes it. Anything else is skipped. */
interface LedgerLine {
  ts: number;
  accountId: string;
  model: string;
  in: number;
  cacheRead: number;
  cacheWrite: number;
  out: number;
  micros: number;
}

function isLedgerLine(x: unknown): x is LedgerLine {
  if (typeof x !== "object" || x === null) return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.ts === "number" &&
    typeof l.model === "string" &&
    typeof l.micros === "number" &&
    Number.isFinite(l.micros)
  );
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Every account on disk, via the store's own reader so its validation applies. */
export function listAccounts(): Account[] {
  const dir = byIdDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Account[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const account = getAccount(name.slice(0, -".json".length));
    if (account) out.push(account);
  }
  return out;
}

/** The day's global spend counter, `null` when the file exists but is unreadable. */
export function readSpend(day: string): number | null {
  const path = spendFile(day);
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { micros?: unknown };
    return typeof parsed.micros === "number" && Number.isFinite(parsed.micros) && parsed.micros >= 0
      ? parsed.micros
      : null;
  } catch {
    return null;
  }
}

/** The day's ledger lines; a missing file is an empty day, a bad line is skipped. */
export function readLedger(day: string): LedgerLine[] {
  const path = usageFile(day);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLedgerLine(parsed)) out.push(parsed);
    } catch {
      /* skipped */
    }
  }
  return out;
}

/** The waitlist as written; one bad line does not lose the rest. */
export function readWaitlist(): WaitlistEntry[] {
  const path = waitlistFile();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: WaitlistEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<WaitlistEntry>;
      if (typeof e.email === "string" && typeof e.ts === "number") {
        out.push({ ts: e.ts, email: e.email, ...(typeof e.name === "string" ? { name: e.name } : {}) });
      }
    } catch {
      /* skipped */
    }
  }
  return out;
}

/** The last `count` UTC days ending today, oldest first. */
export function lastDays(count: number, now = Date.now()): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(utcDay(now - i * DAY_MS));
  return days;
}

export function adminSummary(sessions: number, now = Date.now()): AdminSummary {
  const today = utcDay(now);
  const days = lastDays(SUMMARY_DAYS, now);
  const week = new Set(days.slice(-7));

  const accounts = listAccounts();
  const rows: AdminAccountRow[] = accounts
    .map((a) => ({
      id: a.id,
      email: a.email,
      provider: a.provider,
      ...(a.name ? { name: a.name } : {}),
      createdAt: a.createdAt,
      lastSeenAt: a.lastSeenAt,
      grantedMicros: safeGrantedMicros(a),
      spentMicros: safeSpentMicros(a),
      balanceMicros: balanceMicros(a),
      chatsToday: a.chatDay === today ? num(a.chatCount) : 0,
      blocked: a.blocked === true,
    }))
    .sort((x, y) => y.lastSeenAt - x.lastSeenAt);

  const users = {
    total: rows.length,
    newToday: rows.filter((r) => utcDay(r.createdAt) === today).length,
    new7d: rows.filter((r) => week.has(utcDay(r.createdAt))).length,
    active24h: rows.filter((r) => now - r.lastSeenAt < DAY_MS).length,
    blocked: rows.filter((r) => r.blocked).length,
  };

  const byModel = new Map<string, AdminModelRow>();
  const series: AdminDay[] = [];
  let callsToday = 0;
  let calls7d = 0;
  for (const day of days) {
    const lines = readLedger(day);
    const entry: AdminDay = { day, spendMicros: readSpend(day), calls: lines.length, ledgerMicros: 0, tokensIn: 0, tokensOut: 0 };
    for (const l of lines) {
      entry.ledgerMicros += l.micros;
      entry.tokensIn += num(l.in) + num(l.cacheRead) + num(l.cacheWrite);
      entry.tokensOut += num(l.out);
      const m = byModel.get(l.model) ?? { model: l.model, calls: 0, micros: 0 };
      m.calls += 1;
      m.micros += l.micros;
      byModel.set(l.model, m);
    }
    if (day === today) callsToday = lines.length;
    if (week.has(day)) calls7d += lines.length;
    series.push(entry);
  }

  const waitlist = readWaitlist().sort((a, b) => b.ts - a.ts);

  return {
    generatedAt: now,
    today,
    users,
    credit: {
      grantedMicros: rows.reduce((s, r) => s + r.grantedMicros, 0),
      spentMicros: rows.reduce((s, r) => s + r.spentMicros, 0),
      spentTodayMicros: readSpend(today),
      dailyCapMicros: getConfig().dailySpendCapCents * 1_000_000,
    },
    usage: {
      callsToday,
      calls7d,
      byModel: [...byModel.values()].sort((a, b) => b.micros - a.micros),
      days: series,
    },
    sessions,
    waitlist: { count: waitlist.length, entries: waitlist },
    accounts: rows,
  };
}
