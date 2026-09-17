// ─────────────────────────────────────────────────────────────────────────────
// What the owner may do to an account from the admin page, and nothing else.
//
// Four verbs, each under the account's lock so a charge landing at the same
// moment cannot be lost: block / unblock, add credit, zero the balance, delete.
// Built on the store's own primitives (getAccount, writeAccount,
// withAccountLock, deleteAccount) so the record format and its invariants —
// `spentMicros` monotonic, balance = granted − spent floored at 0 — stay the
// store's business. Money is µ¢ integers, as everywhere in this directory.
// ─────────────────────────────────────────────────────────────────────────────
import {
  deleteAccount,
  getAccount,
  safeGrantedMicros,
  safeSpentMicros,
  withAccountLock,
  writeAccount,
  type Account,
} from "./store";

/** The most one top-up may add: $50, in µ¢. A typo of "5000" cents stays a
 *  typo rather than a gift. */
export const MAX_TOPUP_MICROS = 50 * 100 * 1_000_000;

export class AdminActionError extends Error {
  constructor(
    readonly code: "not_found" | "bad_amount",
    message: string,
  ) {
    super(message);
  }
}

function mustGet(id: string): Account {
  const account = getAccount(id);
  if (!account) throw new AdminActionError("not_found", "No such account.");
  return account;
}

/** Block (a blocked account may still sign in, but every chat turn answers 409 `account_blocked`) or unblock. */
export function setBlocked(id: string, blocked: boolean): Promise<Account> {
  return withAccountLock(id, async () => {
    const account = mustGet(id);
    if (blocked) account.blocked = true;
    else delete account.blocked;
    writeAccount(account);
    return account;
  });
}

/** Raise the grant by `micros` — a top-up, never a refund of what was spent. */
export function addCredit(id: string, micros: number): Promise<Account> {
  if (!Number.isInteger(micros) || micros <= 0 || micros > MAX_TOPUP_MICROS) {
    return Promise.reject(new AdminActionError("bad_amount", "Top-ups are between 1 µ¢ and $50."));
  }
  return withAccountLock(id, async () => {
    const account = mustGet(id);
    account.grantedMicros = safeGrantedMicros(account) + micros;
    writeAccount(account);
    return account;
  });
}

/** Leave nothing to spend: spent catches up with granted. Reversible only by
 *  a top-up, which is the point. */
export function zeroBalance(id: string): Promise<Account> {
  return withAccountLock(id, async () => {
    const account = mustGet(id);
    account.spentMicros = Math.max(safeSpentMicros(account), safeGrantedMicros(account));
    writeAccount(account);
    return account;
  });
}

/** Delete the record; the store retires the e-mail so the credit cannot be
 *  claimed again by signing up afresh. A session still bound to the id simply
 *  finds no account on its next request and reads as signed out. */
export function removeAccount(id: string): Promise<void> {
  return withAccountLock(id, async () => {
    mustGet(id);
    deleteAccount(id);
  });
}
