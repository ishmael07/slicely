// stub until accounts/core merges
//
// Task A1 owns this file. The signatures below are the ones frozen in the plan
// (A1's Interfaces block) and lane B codes against them; the merge replaces this
// file wholesale with A1's version, which is expected to be the same shape.
//
// The accounts directory sits BESIDE `sessions/`, not inside one, which is what
// keeps it unreachable from the agent: `isInsideSessionWorkspace()` confines
// every tool path to the session directory, so a hosted `resolvePath` cannot
// name anything under here.
import { join } from "node:path";
import { getConfig } from "../config";

export function accountsRoot(): string {
  return join(getConfig().workdir, "accounts");
}

export function accountFile(id: string): string {
  return join(accountsRoot(), "by-id", `${id}.json`);
}

export function indexFile(): string {
  return join(accountsRoot(), "index.json");
}

export function usageFile(day: string): string {
  return join(accountsRoot(), "usage", `${day}.ndjson`);
}

export function spendFile(day: string): string {
  return join(accountsRoot(), "spend", `${day}.json`);
}

export function signupsFile(day: string): string {
  return join(accountsRoot(), "signups", `${day}.json`);
}

export function waitlistFile(): string {
  return join(accountsRoot(), "waitlist.ndjson");
}

/** "YYYY-MM-DD" in UTC. Every per-day file is keyed on this, so a server that
 *  moves timezone (or a visitor who does) still sees one day boundary. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
