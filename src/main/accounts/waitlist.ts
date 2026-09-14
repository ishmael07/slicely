// ─────────────────────────────────────────────────────────────────────────────
// "Tell me when a paid plan opens" — an append-only list, one JSON object per
// line, deduped on the normalised email.
//
// NDJSON rather than a JSON array because the only two things anyone will ever
// do with this file are `wc -l` it and `cut` an address out of it, and both want
// one record per line. Appending also means no read-modify-write: two visitors
// arriving at once cannot lose each other's line.
//
// DEDUPE IS ON THE NORMALISED ADDRESS, the same key one-grant-per-person uses,
// so `Jane.Doe+x@gmail.com` and `janedoe@gmail.com` are one person on the list
// as well as one person in the accounts index. The set is built by reading the
// file ONCE, on first use, and kept in memory after that: the file is small,
// tens of entries at the scale this feature exists for, and re-reading it per
// request would be a disk read on a route whose whole job is to be cheap.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { normalizeEmail } from "./email";
import { accountsRoot, waitlistFile } from "./paths";

export interface WaitlistEntry {
  ts: number;
  /** The address AS TYPED, so a reply can be addressed the way they wrote it.
   *  The dedupe key is derived, never stored. */
  email: string;
  name?: string;
  /** Present only when a signed-in visitor asked. Deliberately no IP: this file
   *  has no retention policy and the privacy policy promises one for addresses. */
  accountId?: string;
}

let seen: Set<string> | undefined;

/** The normalised addresses already on the list, read from disk on first use. */
function known(): Set<string> {
  if (seen) return seen;
  const set = new Set<string>();
  try {
    for (const line of readFileSync(waitlistFile(), "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as { email?: unknown };
        set.add(normalizeEmail(entry.email).normalized);
      } catch {
        // A line we cannot read is a line we cannot dedupe on. Skipping it risks
        // one duplicate; refusing to boot over it would be worse.
      }
    }
  } catch {
    /* no file yet — an empty list */
  }
  seen = set;
  return seen;
}

/**
 * Add `entry`, unless its address is already on the list.
 *
 * `added: false` is NOT a failure and the route does not report it: answering
 * differently for an address already on the list would make this an oracle
 * anybody could walk an address list through.
 */
export function addToWaitlist(entry: WaitlistEntry): { added: boolean } {
  const key = normalizeEmail(entry.email).normalized;
  const set = known();
  if (set.has(key)) return { added: false };
  mkdirSync(accountsRoot(), { recursive: true });
  // `JSON.stringify` escapes a newline in any field, so one object really is one
  // line whatever it holds — and the route refuses a newline in `name` anyway,
  // because a file meant to be read with `wc -l` should not depend on that.
  appendFileSync(waitlistFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  set.add(key);
  return { added: true };
}

/** Tests only: forget the in-memory set, so a fresh workdir starts empty. */
export function resetWaitlistForTests(): void {
  seen = undefined;
}
