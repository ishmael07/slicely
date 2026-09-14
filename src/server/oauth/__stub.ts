// stub until accounts/core merges
//
// Lane A (Task A1) adds `publicUrl` and `freeCreditCents` to `SlicelyConfig`,
// read through config.ts's existing `envStr`/`envInt` helpers. Lane B needs both
// before that lands, and adding the fields here rather than editing config.ts
// keeps the two worktrees from colliding on the same lines.
//
// AT MERGE: delete this file and replace its two call sites with
// `getConfig().publicUrl` and `getConfig().freeCreditCents`. Nothing else in
// lane B reads config.
export function publicUrl(): string {
  const raw = process.env.SLICELY_PUBLIC_URL;
  return raw && raw.trim().length > 0 ? raw.trim() : "";
}

export function freeCreditCents(): number {
  const n = Number.parseInt((process.env.SLICELY_FREE_CREDIT_CENTS ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 50;
}
