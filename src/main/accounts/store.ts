// stub until accounts/core merges
//
// Task A1 owns this file: the real one is atomic, locked, and keeps the
// `retired` list that stops a deleted account from being re-granted. This stub
// implements only what lane B's routes call — `findOrCreateAccount`,
// `accountExistsFor`, `getAccount`, `balanceMicros` — with the frozen
// signatures, so routes/auth.ts is written against the real interface and the
// merge is a file swap.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { accountFile, indexFile } from "./paths";

export type AccountProvider = "google" | "github";

export interface Account {
  version: 1;
  id: string;
  provider: AccountProvider;
  providerUserId: string;
  email: string;
  normalizedEmail: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
  grantedMicros: number;
  spentMicros: number;
  chatDay: string;
  chatCount: number;
  blocked?: true;
}

export interface SignInProfile {
  provider: AccountProvider;
  providerUserId: string;
  email: string;
  normalizedEmail: string;
  name?: string;
}

export interface SignInOutcome {
  account: Account;
  /** True only the very first time a normalised email is seen. Drives the IP
   *  counter: only a GRANT costs a signup. */
  granted: boolean;
}

interface AccountIndex {
  version: 1;
  byEmail: Record<string, string>;
  byProvider: Record<string, string>;
  retired: string[];
}

function readIndex(): AccountIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(), "utf8")) as Partial<AccountIndex>;
    return {
      version: 1,
      byEmail: parsed.byEmail ?? {},
      byProvider: parsed.byProvider ?? {},
      retired: parsed.retired ?? [],
    };
  } catch {
    return { version: 1, byEmail: {}, byProvider: {}, retired: [] };
  }
}

function writeIndex(index: AccountIndex): void {
  mkdirSync(dirname(indexFile()), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify(index, null, 2));
}

function providerKey(provider: AccountProvider, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}

/** Does an account already exist for this identity or this normalised address?
 *  Asked BEFORE a create, so a signup the per-IP cap refuses leaves no record.
 *
 *  NOTE FOR THE MERGE: this function is used by routes/auth.ts but is NOT in the
 *  plan's frozen A1 interface list — lane A needs to export it (or lane B needs
 *  a read-only lookup that answers the same question). */
export function accountExistsFor(
  provider: AccountProvider,
  providerUserId: string,
  normalizedEmail: string,
): boolean {
  const index = readIndex();
  return Boolean(index.byProvider[providerKey(provider, providerUserId)] ?? index.byEmail[normalizedEmail]);
}

export function findOrCreateAccount(profile: SignInProfile, grantMicros: number): SignInOutcome {
  const index = readIndex();
  const key = providerKey(profile.provider, profile.providerUserId);
  const existingId = index.byProvider[key] ?? index.byEmail[profile.normalizedEmail];
  const existing = existingId ? getAccount(existingId) : undefined;
  if (existing) {
    existing.lastSeenAt = Date.now();
    existing.email = profile.email;
    if (profile.name) existing.name = profile.name;
    writeAccount(existing);
    index.byProvider[key] = existing.id;
    index.byEmail[profile.normalizedEmail] = existing.id;
    writeIndex(index);
    return { account: existing, granted: false };
  }

  const now = Date.now();
  // A retired address gets an account but no second grant: deleting your data
  // must not be a way to refill the wallet.
  const retired = index.retired.includes(profile.normalizedEmail);
  const account: Account = {
    version: 1,
    id: randomBytes(16).toString("hex"),
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    normalizedEmail: profile.normalizedEmail,
    name: profile.name,
    createdAt: now,
    lastSeenAt: now,
    grantedMicros: retired ? 0 : grantMicros,
    spentMicros: 0,
    chatDay: new Date(now).toISOString().slice(0, 10),
    chatCount: 0,
  };
  writeAccount(account);
  index.byProvider[key] = account.id;
  index.byEmail[profile.normalizedEmail] = account.id;
  writeIndex(index);
  return { account, granted: !retired };
}

export function getAccount(id: string): Account | undefined {
  if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(accountFile(id), "utf8")) as Account;
  } catch {
    return undefined;
  }
}

export function writeAccount(account: Account): void {
  mkdirSync(dirname(accountFile(account.id)), { recursive: true });
  writeFileSync(accountFile(account.id), JSON.stringify(account, null, 2), { mode: 0o600 });
}

export function balanceMicros(account: Account): number {
  return Math.max(0, account.grantedMicros - account.spentMicros);
}

export function isRetired(normalizedEmail: string): boolean {
  return readIndex().retired.includes(normalizedEmail);
}

/** stub: the real store caches the index in memory, so this drops that cache.
 *  Here it only has to exist, because the stub reads the file every time. */
export function resetAccountsForTests(): void {
  if (existsSync(indexFile())) {
    /* nothing cached */
  }
}
