// ─────────────────────────────────────────────────────────────────────────────
// The account store — one small JSON file per person, one index, no lost writes.
//
// An account is the only durable record Slicely keeps about a human, and it is
// deliberately tiny: who they are at their provider, the email to show them,
// what was granted, what has been spent, and today's chat count. No IP, no
// access token, no refresh token, no avatar URL, no prompt text. A test reads
// the file back and asserts exactly that, because the cheapest way to keep a
// promise about what we store is to store almost nothing.
//
// TWO LOOKUPS, ONE IDENTITY. `byProviderUser` ("google:1078…") is the fast,
// stable path for a repeat sign-in — it survives the person changing their
// address at the provider. `byEmail` (the NORMALISED address, see email.ts) is
// what makes one human one account: signing in with Google and later with
// GitHub on the same verified address resolves to the same file, and therefore
// to one grant rather than two.
//
// THE GRANT HAPPENS ONCE. `grantedMicros` is written at creation and never
// changed. Deleting an account does not clear the debt: the normalised email
// goes onto `retired`, so signing up again gets a working account with a zero
// balance rather than another 50 cents. Without that, "delete my data" would be
// a coupon generator.
//
// ATOMIC WRITES, EVERYWHERE. A temp sibling then `rename`, mode 0600 — the same
// shape as userkey.ts and printers/registry.ts. A plain write truncates first,
// so a crash mid-write would leave a zero-length account file, which reads as a
// person who never existed and whose spend is forgotten.
//
// AND A LOCK. One process serving two tabs still races: read balance, add cost,
// write — twice concurrently — loses one charge. `withAccountLock` is a promise
// chain per key, so every read-modify-write against one account (or one day's
// spend total) is serialised. It is keyed on an arbitrary string so meter.ts can
// take `spend:<day>` out of the same map without a second lock table.
// ─────────────────────────────────────────────────────────────────────────────
import {
  chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { accountFile, byIdDir, indexFile, utcDay } from "./paths";

export type AccountProvider = "google" | "github";

/**
 * One person's account.
 *
 * Money is in µ¢ — millionths of a cent, 1,000,000 µ¢ = 1¢ (see pricing.ts).
 * Integers throughout, so nothing rounds to zero and nothing drifts.
 */
export interface Account {
  version: 1;
  /** 16 random bytes, hex. Never derived from the email or the provider id. */
  id: string;
  provider: AccountProvider;
  /** Google's `sub`, GitHub's numeric `id`. Opaque; never displayed. */
  providerUserId: string;
  /** As the provider gave it, for display. */
  email: string;
  /** The grant key — see email.ts's `normalizeEmail`. */
  normalizedEmail: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
  /** What was granted, once, at creation. Never changes. */
  grantedMicros: number;
  /** Monotonic. The balance is `granted − spent`, floored at 0. */
  spentMicros: number;
  /** "YYYY-MM-DD" in UTC — which day `chatCount` counts. */
  chatDay: string;
  chatCount: number;
  /** Set by hand by the owner. Answers `email_blocked`. */
  blocked?: true;
}

/** The lookup maps plus the retired list. Rewritten whole on every change — it
 *  is a few hundred bytes per account and a single file cannot half-update. */
export interface AccountIndex {
  version: 1;
  /** "<provider>:<providerUserId>" → accountId */
  byProviderUser: Record<string, string>;
  /** normalizedEmail → accountId */
  byEmail: Record<string, string>;
  /** normalizedEmails that once held credit and were deleted. */
  retired: string[];
}

/** What a completed OAuth flow knows about the person, before any account
 *  exists. Produced by the provider modules (src/server/oauth/), which have
 *  already verified the address. */
export interface SignInProfile {
  provider: AccountProvider;
  providerUserId: string
  email: string;
  normalizedEmail: string;
  name?: string;
}

export interface SignInOutcome {
  account: Account;
  /** True only the very first time a normalised email is seen. Drives the IP counter. */
  granted: boolean;
}

/** The index, read once and then held. `undefined` means "not read yet". */
let index: AccountIndex | undefined;

/** Read-through cache of account files, keyed by id. Entries are the LIVE
 *  objects callers mutate under the lock, so a charge and a chat count in the
 *  same turn see each other. */
const accounts = new Map<string, Account>();

/** One promise chain per lock key — see `withAccountLock`. */
const locks = new Map<string, Promise<unknown>>();

function emptyIndex(): AccountIndex {
  return { version: 1, byProviderUser: {}, byEmail: {}, retired: [] };
}

/**
 * The index, off disk on first use.
 *
 * A MALFORMED OR MISSING FILE IS REBUILT, NOT THROWN ON. The index is a derived
 * cache of what the `by-id/` files already say, so a hand-edited or half-written
 * one must not brick sign-in for everybody — and it must not double-grant
 * either. `findOrCreateAccount` writes the ACCOUNT FILE FIRST and the index
 * second precisely so this rebuild is possible: a crash between the two leaves
 * the account file as the only record, and reading `by-id/` back finds it again
 * rather than handing the same person a second fifty cents.
 *
 * WHAT A REBUILD CANNOT RECOVER IS `retired`, which is the one thing in here that
 * is NOT derived — a deleted account leaves no file to read it off. Losing
 * `index.json` therefore reopens the delete-and-resignup path for anyone who had
 * already deleted. That is why the index is written atomically like everything
 * else, and why this is a repair rather than a design.
 */
function loadIndex(): AccountIndex {
  if (index) return index;
  try {
    const parsed = JSON.parse(readFileSync(indexFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Partial<AccountIndex>;
      index = {
        version: 1,
        byProviderUser: isRecord(raw.byProviderUser) ? raw.byProviderUser : {},
        byEmail: isRecord(raw.byEmail) ? raw.byEmail : {},
        retired: Array.isArray(raw.retired) ? raw.retired.filter((e) => typeof e === "string") : [],
      };
      return index;
    }
  } catch {
    /* no file, or unreadable — rebuild from the account files below */
  }
  index = rebuildIndex();
  return index;
}

/** The two lookup maps, read back out of `by-id/`. `retired` cannot be rebuilt —
 *  see `loadIndex`. */
function rebuildIndex(): AccountIndex {
  const next = emptyIndex();
  let names: string[];
  try {
    names = readdirSync(byIdDir());
  } catch {
    return next;   // nothing has ever been written here
  }
  for (const name of names) {
    const match = /^([0-9a-f]{32})\.json$/.exec(name);
    const account = match ? getAccount(match[1]) : undefined;
    if (!account) continue;
    next.byProviderUser[`${account.provider}:${account.providerUserId}`] = account.id;
    next.byEmail[account.normalizedEmail] = account.id;
  }
  return next;
}

function isRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

function writeIndex(next: AccountIndex): void {
  index = next;
  writeAtomic(indexFile(), JSON.stringify(next, null, 2));
}

/**
 * Replace a file atomically: write a temp sibling at 0600, then `rename`.
 *
 * `rename` within a directory is atomic, so a reader sees either the old file
 * or the new one — never a truncated account whose spend has been forgotten.
 * The temp is removed if the rename fails, so a failed write never leaves a
 * readable copy of the record beside it.
 *
 * Exported because meter.ts's daily spend total and signups.ts's hashed-IP
 * counter need exactly this and nothing more — one writer for everything under
 * `accounts/` means one place to get the permissions and the rename right.
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    // writeFileSync's `mode` only applies when it CREATES the file.
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The account with this id, off disk on first ask. The returned object is the
 *  cached, live one: mutate it under `withAccountLock` and `writeAccount` it. */
export function getAccount(id: string): Account | undefined {
  const hit = accounts.get(id);
  if (hit) return hit;
  if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
  const path = accountFile(id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Account;
    if (!parsed || typeof parsed !== "object" || parsed.id !== id) return undefined;
    accounts.set(id, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

/** Persist one account. Atomic; also refreshes the read-through cache, so the
 *  next reader cannot see a staler object than the one just written. */
export function writeAccount(account: Account): void {
  accounts.set(account.id, account);
  writeAtomic(accountFile(account.id), JSON.stringify(account, null, 2));
}

/**
 * One µ¢ field off disk as a number we may safely do arithmetic with, or
 * `undefined` when the stored value is not one.
 *
 * `NaN` is the value this exists for. JSON has no `NaN`, so a charge that once
 * went wrong is written as `null` — and `null` is not a number, `NaN` is not
 * `> 0`, and `NaN - x` is `NaN`. Every comparison an account's caps depend on
 * would quietly answer "there is credit left".
 */
function storedMicros(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Corruptions already reported — one log line per broken account, not one per
 *  request. */
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[accounts] ${message}`);
}

/** What was granted. An unusable stored value reads as NOTHING granted, which is
 *  the fail-closed direction: the account has no credit rather than infinite. */
export function safeGrantedMicros(account: Account): number {
  const granted = storedMicros(account.grantedMicros);
  if (granted === undefined) {
    warnOnce(`account ${account.id} has an unusable grantedMicros — treating it as 0.`);
    return 0;
  }
  return granted;
}

/**
 * What has been spent, FAILING CLOSED: an unusable total reads as the whole
 * grant spent, so the account is exhausted rather than unlimited.
 *
 * Exported because meter.ts must not add a charge to a number it cannot trust —
 * it writes this value back plus the charge, which also repairs the file.
 */
export function safeSpentMicros(account: Account): number {
  const spent = storedMicros(account.spentMicros);
  if (spent === undefined) {
    warnOnce(`account ${account.id} has an unusable spentMicros — treating its credit as spent.`);
    return safeGrantedMicros(account);
  }
  return spent;
}

/** What is left to spend: `granted − spent`, floored at zero. The floor is real
 *  — a call is charged after it happened, so `spentMicros` can overshoot
 *  `grantedMicros` by one call PER CONCURRENT TURN (see agent/funding.ts's
 *  `freeFunding`), not by one call.
 *
 *  Both sides go through the sanitisers above, so a corrupt account file answers
 *  "no credit" rather than "NaN", which is what every caller compares `<= 0`. */
export function balanceMicros(account: Account): number {
  return Math.max(0, safeGrantedMicros(account) - safeSpentMicros(account));
}

/** True when this normalised email has already had a grant and given it back.
 *  Asked before every new account is created. */
export function isRetired(normalizedEmail: string): boolean {
  return loadIndex().retired.includes(normalizedEmail);
}

/**
 * True when this normalised email already has a live account.
 *
 * Asked by the sign-in route BEFORE `findOrCreateAccount`, so the per-IP signup
 * cap is charged only for a genuinely new person: a returning visitor signing in
 * from the same office NAT as three new ones must not be turned away as the
 * fourth signup of the day. Read-only and synchronous — it creates nothing and
 * changes nothing.
 *
 * A RETIRED email answers `false`, because there is no account: signing up again
 * does create a record (`isRetired` is what makes sure it comes with no money),
 * and that record is exactly the thing the cap counts.
 */
export function accountExistsFor(normalizedEmail: string): boolean {
  const id = loadIndex().byEmail[normalizedEmail];
  return id !== undefined && getAccount(id) !== undefined;
}

/**
 * Find the account this sign-in belongs to, or create one with the grant.
 *
 * The two lookups are tried in order — provider identity first (stable and
 * exact), then the normalised email (which is what makes two providers one
 * person). A hit refreshes what the provider just told us, adds the new
 * provider identity if this is a second way in, and grants nothing.
 */
export function findOrCreateAccount(profile: SignInProfile, grantMicros: number): SignInOutcome {
  const idx = loadIndex();
  const providerKey = `${profile.provider}:${profile.providerUserId}`;
  const existingId = idx.byProviderUser[providerKey] ?? idx.byEmail[profile.normalizedEmail];
  const existing = existingId ? getAccount(existingId) : undefined;

  if (existing) {
    // The provider is the authority on the display email and the name; both can
    // change between sign-ins and neither is an identity.
    existing.email = profile.email;
    if (profile.name) existing.name = profile.name;
    existing.lastSeenAt = Date.now();
    writeAccount(existing);
    // A second way into the same person — record it so next time is one lookup.
    if (idx.byProviderUser[providerKey] !== existing.id) {
      writeIndex({
        ...idx,
        byProviderUser: { ...idx.byProviderUser, [providerKey]: existing.id },
        byEmail: { ...idx.byEmail, [profile.normalizedEmail]: existing.id },
      });
    }
    return { account: existing, granted: false };
  }

  // A retired email gets a working account with nothing in it. Deleting an
  // account must not be a way to ask for the grant again.
  const grantedMicros = isRetired(profile.normalizedEmail) ? 0 : grantMicros;
  const now = Date.now();
  const account: Account = {
    version: 1,
    id: randomBytes(16).toString("hex"),
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    normalizedEmail: profile.normalizedEmail,
    ...(profile.name ? { name: profile.name } : {}),
    createdAt: now,
    lastSeenAt: now,
    grantedMicros,
    spentMicros: 0,
    chatDay: utcDay(now),
    chatCount: 0,
  };
  // THE ACCOUNT FILE FIRST, THE INDEX SECOND, and that order is the whole of the
  // crash story. A crash in between leaves an account file no index points at,
  // which `loadIndex`'s rebuild finds again — so the same person is not granted
  // twice. The other order would leave an index entry naming a file that does not
  // exist, which `getAccount` reads as "no account", which grants again.
  writeAccount(account);
  writeIndex({
    ...idx,
    byProviderUser: { ...idx.byProviderUser, [providerKey]: account.id },
    byEmail: { ...idx.byEmail, [profile.normalizedEmail]: account.id },
  });
  return { account, granted: grantedMicros > 0 };
}

/**
 * Remove an account and retire its email — what "delete my data" does to the
 * person's record (spec §1.5).
 *
 * Both index entries go, every normalised email that pointed at this id joins
 * `retired` (deduped), the file is deleted and the cache entry dropped. The
 * retirement is the point: the ledger lines stay (they are the owner's audit
 * trail and name no person), but the 50 cents is spent whether or not the record
 * survives.
 *
 * RETIRED FROM THE REVERSE INDEX, NOT ONLY FROM THE ACCOUNT FILE. The file may be
 * unreadable — that is one of the reasons somebody would be deleting it — and
 * retiring nothing in that case turns "delete my data" back into the coupon
 * generator `retired` exists to prevent. The index knows which addresses resolved
 * to this id, which is exactly the set that must not be granted again.
 */
export function deleteAccount(id: string): void {
  const account = getAccount(id);
  const idx = loadIndex();
  const byProviderUser = { ...idx.byProviderUser };
  const byEmail = { ...idx.byEmail };
  const retired = new Set(idx.retired);
  for (const [key, value] of Object.entries(byProviderUser)) {
    if (value === id) delete byProviderUser[key];
  }
  for (const [key, value] of Object.entries(byEmail)) {
    if (value !== id) continue;
    delete byEmail[key];
    retired.add(key);
  }
  if (account) retired.add(account.normalizedEmail);
  writeIndex({ version: 1, byProviderUser, byEmail, retired: [...retired] });
  accounts.delete(id);
  rmSync(accountFile(id), { force: true });
}

/**
 * Run `fn` with nothing else running under the same key.
 *
 * A promise chain, not a mutex library: each caller waits on the current tail
 * and becomes the new tail. The `finally` clears the map entry only when it is
 * still the tail, so the map does not grow per account forever and a late
 * arrival never chains onto a dead promise.
 *
 * A REJECTION MUST NOT POISON THE CHAIN — the tail is stored already-caught, so
 * one failed charge cannot make every later charge for that account reject.
 */
export function withAccountLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  void tail.finally(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

/** Tests only: drop the in-memory index and account caches, as if the server
 *  had just started. The files on disk are the truth. */
export function resetAccountsForTests(): void {
  index = undefined;
  accounts.clear();
  locks.clear();
  warned.clear();
}
