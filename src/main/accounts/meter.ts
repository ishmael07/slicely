// stub until accounts/core merges
//
// Task A3 owns this file — the charge path, the daily spend cap and the ledger.
// Lane B calls exactly one thing from it: the read-only chat allowance that
// `/api/me` reports. Everything else A3 exports is deliberately absent here so
// nothing in lane B can accidentally depend on a stub of it.
import type { Account } from "./store";
import { utcDay } from "./paths";

export interface ChatAllowance {
  allowed: boolean;
  used: number;
  limit: number;
}

function limit(): number {
  const n = Number.parseInt((process.env.SLICELY_FREE_CHATS_PER_DAY ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 40;
}

/** Today's chat count for `account`, without touching it. An account whose
 *  `chatDay` is not today has used none of today. */
export function chatAllowance(account: Account): ChatAllowance {
  const used = account.chatDay === utcDay() ? account.chatCount : 0;
  return { allowed: used < limit(), used, limit: limit() };
}
