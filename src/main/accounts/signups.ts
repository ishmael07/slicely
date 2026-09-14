// stub until accounts/core merges
//
// Task A3 owns this file. The salt lives at `<accountsRoot>/.signup-salt` (0600)
// rather than being the cookie secret, because `src/main` must not depend on
// `src/server`; the property that matters — a hash useless off this machine — is
// the same either way. Only `countSignup` is called from lane B.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { accountsRoot, signupsFile, utcDay } from "./paths";

export interface SignupAllowance {
  allowed: boolean;
  used: number;
  limit: number;
}

function limit(): number {
  const n = Number.parseInt((process.env.SLICELY_SIGNUPS_PER_IP_PER_DAY ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

function saltPath(): string {
  return join(accountsRoot(), ".signup-salt");
}

function salt(): Buffer {
  const path = saltPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path);
      if (raw.length === 32) return raw;
    }
  } catch {
    /* fall through and make a new one */
  }
  const fresh = randomBytes(32);
  try {
    mkdirSync(accountsRoot(), { recursive: true });
    writeFileSync(path, fresh, { mode: 0o600 });
  } catch {
    /* worst case: a fresh salt, which only resets today's counters */
  }
  return fresh;
}

/** The counter stores a SALTED HASH, never the address: the privacy policy says
 *  server logs keep IPs for 14 days, and an accounts file holding raw addresses
 *  indefinitely would contradict it. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(salt()).update(ip).digest("hex").slice(0, 32);
}

function read(day: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(signupsFile(day), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function write(day: string, counts: Record<string, number>): void {
  mkdirSync(join(accountsRoot(), "signups"), { recursive: true });
  writeFileSync(signupsFile(day), JSON.stringify(counts));
}

export function signupAllowance(ip: string): SignupAllowance {
  const used = read(utcDay())[hashIp(ip)] ?? 0;
  return { allowed: used < limit(), used, limit: limit() };
}

/** Charge one signup to this address, or refuse. Called only when the sign-in
 *  really would create a new account. */
export function countSignup(ip: string): SignupAllowance {
  const day = utcDay();
  const counts = read(day);
  const key = hashIp(ip);
  const used = counts[key] ?? 0;
  if (used >= limit()) return { allowed: false, used, limit: limit() };
  counts[key] = used + 1;
  write(day, counts);
  return { allowed: true, used: used + 1, limit: limit() };
}

export function resetSignupsForTests(): void {
  /* stub: nothing is cached in memory */
}
