// ─────────────────────────────────────────────────────────────────────────────
// Where an account lives on disk — the one place these six paths are spelled.
//
// Everything sits under `<workdir>/accounts/`, deliberately OUTSIDE every
// session directory. Two things fall out of that for free: the agent's own path
// guard (`isSafeWorkspaceRelPath` in main/session-context.ts) already refuses
// every reachable path into it, so no tool can read another person's account;
// and session.ts's file sweeper only ever walks a session's scratch folders, so
// nothing here is ever aged out.
//
// HOSTED ONLY. Accounts do not exist in desktop mode (the owner IS the user),
// and nothing in the desktop path calls into this directory — see
// agent/funding.ts, which answers `undefined` before it asks for a path.
// Because each accessor creates its own directory on first use, merely ASKING
// for a path is what makes the folder; that is why no desktop-mode code may
// call one.
//
// The day-partitioned files (`usage/`, `spend/`, `signups/`) are keyed on a UTC
// day, not a local one, so a server moved between regions — or a visitor in
// another timezone — never sees a counter reset twice or skip a day.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config";

/** `<workdir>/accounts` — the root of everything in this module. */
export function accountsRoot(): string {
  return join(getConfig().workdir, "accounts");
}

/** `mkdir -p` on first use, then hand the directory back. Cheap and idempotent,
 *  the same way getConfig() treats the workdir itself.
 *
 *  Exported because signups.ts keeps `.signup-salt` at the root of this
 *  directory rather than in a subdirectory, and so has no path accessor of its
 *  own to create it. */
export function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* surfaced later when we actually try to write */
  }
  return dir;
}

/** `<root>/by-id` — one JSON file per account, and the only non-derived record
 *  of a person. store.ts reads the directory back to rebuild a lost index. */
export function byIdDir(): string {
  return ensureDir(join(accountsRoot(), "by-id"));
}

/** `<root>/by-id/<id>.json` — one account. */
export function accountFile(id: string): string {
  return join(byIdDir(), `${id}.json`);
}

/** `<root>/index.json` — the two lookup maps plus the retired list. */
export function indexFile(): string {
  return join(ensureDir(accountsRoot()), "index.json");
}

/** `<root>/usage/<day>.ndjson` — the append-only ledger, one line per call. */
export function usageFile(day: string): string {
  return join(ensureDir(join(accountsRoot(), "usage")), `${day}.ndjson`);
}

/** `<root>/spend/<day>.json` — the global daily kill-switch counter. */
export function spendFile(day: string): string {
  return join(ensureDir(join(accountsRoot(), "spend")), `${day}.json`);
}

/** `<root>/signups/<day>.json` — hashed-IP signup counts for one day. */
export function signupsFile(day: string): string {
  return join(ensureDir(join(accountsRoot(), "signups")), `${day}.json`);
}

/** `<root>/waitlist.ndjson` — append-only, deduped on the normalised email. */
export function waitlistFile(): string {
  return join(ensureDir(accountsRoot()), "waitlist.ndjson");
}

/** Today in UTC as "YYYY-MM-DD". Every daily counter in this module agrees on
 *  this one definition of a day. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
