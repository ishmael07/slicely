// ─────────────────────────────────────────────────────────────────────────────
// How many new accounts one address may create in a day.
//
// The grant is the thing worth farming: fifty cents times a thousand throwaway
// sign-ups is real money, and the email checks alone do not stop somebody with a
// domain of their own. So new accounts are counted per address per UTC day, on
// top of (not instead of) one-grant-per-normalised-email.
//
// WE STORE A SALTED HASH, NEVER THE ADDRESS. site/privacy.html says server logs
// keep IPs for fourteen days; an accounts file holding raw addresses
// indefinitely would quietly contradict that. `sha256(salt ‖ ip)` truncated to
// 128 bits is a counter key and nothing else: it cannot be reversed, it cannot
// be correlated with anyone else's logs, and it is useless off this machine.
//
// THE SALT IS OUR OWN, not the cookie-signing secret. Reaching for that would
// mean `src/main` importing from `src/server`, which is a layering rule this
// codebase keeps on purpose (main/ knows nothing about HTTP). So this module
// reads or creates its own 32 bytes at `<accountsRoot>/.signup-salt`, mode 0600
// — the same shape as session.ts's `loadOrCreateSecret`, and the same property:
// the hashes are meaningless anywhere but here, and rotate if the file is
// deleted.
//
// NO LOCK, AND THAT IS DELIBERATE. `countSignup` is fully synchronous: read,
// increment, write, with no `await` anywhere in between, so it cannot interleave
// with another copy of itself on a single-threaded event loop. Making it async
// would ADD the race it would then need a lock to remove.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config";
import { accountsRoot, ensureDir, signupsFile, utcDay } from "./paths";
import { writeAtomic } from "./store";

/** Cached by path, not globally: a test that moves `SLICELY_WORKDIR` must never
 *  hash with the previous workdir's salt. */
const salts = new Map<string, Buffer>();

function saltPath(): string {
  return join(accountsRoot(), ".signup-salt");
}

/** This machine's signup salt, created once and then read off disk. If it
 *  cannot be persisted the process still gets a usable salt — the counters just
 *  reset on the next restart, which is a weaker cap rather than a broken one. */
function salt(): Buffer {
  const path = saltPath();
  const hit = salts.get(path);
  if (hit) return hit;
  try {
    const hex = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      const existing = Buffer.from(hex, "hex");
      salts.set(path, existing);
      return existing;
    }
  } catch {
    /* fall through to generating a fresh one */
  }
  const fresh = randomBytes(32);
  try {
    // `accountsRoot()` does NOT create its own directory — only the per-file
    // accessors do, and the salt lives at the root next to `index.json` rather
    // than in a subdirectory. Without this the very first `hashIp` on a fresh
    // workdir fails to persist and falls through to a per-process salt, which is
    // a daily signup cap that resets on every restart.
    ensureDir(accountsRoot());
    writeFileSync(path, fresh.toString("hex"), { mode: 0o600 });
  } catch {
    /* worst case: a fresh salt per process start, so the day's counts reset */
  }
  salts.set(path, fresh);
  return fresh;
}

/** A counter key for one address: 32 lowercase hex characters, from which the
 *  address cannot be recovered. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(salt()).update(ip).digest("hex").slice(0, 32);
}

export interface SignupAllowance {
  allowed: boolean;
  used: number;
  limit: number;
}

/** `{ "<hashedIp>": count }` for one day. */
function readCounts(day: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(signupsFile(day), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          out[key] = Math.floor(value);
        }
      }
      return out;
    }
  } catch {
    /* no file yet, or unreadable — nobody has signed up today */
  }
  return {};
}

/** What this address has already used today, without spending any of it. */
export function signupAllowance(ip: string): SignupAllowance {
  const limit = getConfig().signupsPerIpPerDay;
  const used = readCounts(utcDay())[hashIp(ip)] ?? 0;
  return { allowed: used < limit, used, limit };
}

/**
 * Count one new account against this address's daily allowance.
 *
 * A refusal does NOT increment: a blocked attempt must not push the count past
 * the cap, or a persistent script would extend its own lockout indefinitely and
 * the honest visitor behind the same NAT would never get back in.
 */
export function countSignup(ip: string): SignupAllowance {
  const limit = getConfig().signupsPerIpPerDay;
  const day = utcDay();
  const counts = readCounts(day);
  const key = hashIp(ip);
  const used = counts[key] ?? 0;
  if (used >= limit) return { allowed: false, used, limit };
  counts[key] = used + 1;
  writeAtomic(signupsFile(day), JSON.stringify(counts, null, 2));
  return { allowed: true, used: used + 1, limit };
}

/** Tests only: forget the cached salt, so a new workdir reads its own. */
export function resetSignupsForTests(): void {
  salts.clear();
}
