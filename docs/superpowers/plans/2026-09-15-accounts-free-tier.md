# Slicely Accounts + Free Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a stranger sign in with Google or GitHub, spend 50 cents of the owner's AI credit on one cheap model, and switch to their own key at any time — with metering, abuse limits and prompt caching tight enough that 50 cents buys a real trial.

**Architecture:** Three new seams and nothing else moves. `src/main/pricing.ts` holds one editable price table. `src/main/accounts/` holds a JSON account store, an append-only usage ledger and the abuse counters. `src/main/agent/funding.ts` answers "who pays for this turn, with which key, on which model" — `POST /api/chat` asks it once before writing an SSE byte, and the agent loop asks it again before every provider call. OAuth is two redirect flows behind an encrypted single-use state cookie; no provider token is ever stored.

**Tech Stack:** TypeScript 5.9, Node 20, Express 4, `@anthropic-ai/sdk` 0.105 (Anthropic), raw `fetch` (OpenAI, Google, GitHub), `node:test`, no bundler, **no new runtime dependencies**.

**Spec:** `docs/superpowers/specs/2026-09-15-accounts-free-tier-design.md` — read it first; this plan argues from it. The public-launch spec and plan (`2026-09-12-*`) are still in force for everything they cover.

## Global Constraints

- **Hosted-only accounts.** `SLICELY_MODE=desktop` mounts no `/auth` router, creates no `accounts/` directory, reports `accountsEnabled: false`, and keeps `getUserApiKey()`'s owner-key fallback because the owner is the user. Every task that touches `src/main` or `src/server` must leave desktop behaviour byte-identical. (Spec §1.4.)
- **No secrets to clients.** No response body, log line, error string, ledger line or account file may contain an API key (owner's or user's), an OAuth client secret, an `access_token`, an `id_token`, or a PKCE verifier. `/api/me` carries an email, a monogram letter, four integers and two pre-formatted strings. (Spec §8.)
- **Provider tokens are not stored.** Google's `access_token` is discarded unread; its `id_token` is parsed into four fields and dropped. GitHub's `access_token` lives in one local variable across two HTTPS calls. Nothing is persisted, nothing is refreshable. (Spec §3.)
- Wire errors stay `{ error: string, code?: string }`. Existing stable codes are unchanged. **New stable codes, and there are exactly seven:** `signin_required`, `credit_exhausted`, `free_tier_paused`, `signup_limited`, `email_unverified`, `email_blocked`, `oauth_failed`. Each gets a sentence in `CODE_COPY` (`src/web/api.ts`). `email_invalid` is a waitlist-only 400 and is not a chat code. (Spec §10.5.)
- **No small text.** `styles.css` has exactly three sizes — `--fs-h: 16px`, `--fs: 14px`, `--fs-sm: 13px` — and 13px is the floor. Quieter means dimmer (`--text-dim`, `--text-faint`), never smaller. No new `font-size` literal below 13px on anything that holds words. (Spec §9.)
- **Money is µ¢ — millionths of a cent. 1,000,000 µ¢ = 1¢.** Prices are integer cents per 1M tokens, so `tokens × centsPer1M` **is** the µ¢ cost: integer arithmetic end to end, no floats, no division, no rounding to zero. Env vars are in cents and are multiplied by 1e6 exactly once, at the edge. (Spec §4.1–4.2.)
- **Model ids are exactly** `claude-sonnet-5` (the Anthropic free model, added to `MODEL_CATALOG` by Task A4) and `gpt-5.6-luna` (the OpenAI free model, already in the catalogue). Never a date suffix, never a different spelling.
- **Only model calls are metered.** Search, slicing, thumbnails, printer traffic and the deterministic find path cost the visitor nothing. (Spec, Decisions table.)
- **`SLICELY_ALLOW_OPERATOR_KEY` is retired.** In hosted mode the owner's keys are reachable only through a metered, signed-in account. Task A4 removes the flag from code, `.env.example` and the README, and pins the replacement with a test. (Spec §11.)
- Free-tier defaults, verbatim: `SLICELY_FREE_CREDIT_CENTS=50`, `SLICELY_DAILY_SPEND_CAP_CENTS=500`, `SLICELY_SIGNUPS_PER_IP_PER_DAY=3`, `SLICELY_FREE_CHATS_PER_DAY=40`, `SLICELY_FREE_MAX_OUTPUT_TOKENS=4000`, `SLICELY_MAX_HISTORY_TURNS=12`, free effort fixed to `"medium"`.
- Commit after every task, in house style: `slicely-v3: <what changed, in plain words>` plus the attribution trailer given in the session. Branch stays `slicely-v3`.
- Every task: `npm run typecheck` and `npm run test:only` green before commit (run `npm run build` first when a test file was added — tests run from `dist/`). The baseline is 620 tests / 618 pass / 2 pre-existing PrusaSlicer-not-found failures in `planner-colour.test.ts`; those two stay failing and are not this plan's problem.
- No new runtime dependencies. The disposable-domain list is a committed TypeScript array, not a package.
- Scope boundary unchanged: find → slice → print. No CAD, no geometry generation.

## File map (what exists after the plan)

```
src/main/
  pricing.ts                    NEW  PRICE_TABLE (cents per 1M), priceFor, costMicros, formatMoney
  pricing.test.ts               NEW
  accounts/
    store.ts                    NEW  Account, AccountIndex, find/create/read/write, withAccountLock
    store.test.ts               NEW
    email.ts                    NEW  normalizeEmail, isDisposableDomain
    email.test.ts               NEW
    disposable-domains.ts       NEW  the bundled list (generated once, committed)
    meter.ts                    NEW  chargeAccount, dailySpendMicros, freeTierPaused, chat/day counter
    meter.test.ts               NEW
    signups.ts                  NEW  per-IP signup cap on hashed IPs
    signups.test.ts             NEW
    waitlist.ts                 NEW  append + dedupe on normalised email
    paths.ts                    NEW  accountsRoot() and the six file paths under it
  agent/
    funding.ts                  NEW  TurnFunding, resolveTurnFunding, freeTierInfo
    funding.test.ts             NEW
    history.ts                  NEW  capHistory
    history.test.ts             NEW
    prompt.ts                   NEW  SYSTEM_PROMPT, moved out of agent.ts and trimmed
    prompt.test.ts              NEW  token budget + load-bearing phrases
    agent.ts                    MOD  funding per turn, guard()/onUsage() per call, capHistory
    provider.ts                 MOD  TurnUsage; TurnResult.usage; StreamRequest.cacheKey
    provider-anthropic.ts       MOD  cache_control on system + last tool; usage from finalMessage()
    provider-openai.ts          MOD  usage from response.completed; prompt_cache_key; append-only input
    tools.ts, tools-v2.ts       MOD  trimmed descriptions
  settings.ts                   MOD  + claude-sonnet-5 catalogue entry
  userkey.ts                    MOD  operator fallback desktop-only; SLICELY_ALLOW_OPERATOR_KEY gone
  config.ts                     MOD  + publicUrl, freeCreditCents and friends
src/server/
  oauth/state.ts                NEW  startOauth, readOauthState, clearOauthState, safeReturnTo, pkce
  oauth/state.test.ts           NEW
  oauth/index.ts                NEW  OauthProvider, configuredProviders, HttpFn injection
  oauth/google.ts               NEW
  oauth/github.ts               NEW
  oauth/providers.test.ts       NEW
  routes/auth.ts                NEW  /auth/:p/start, /auth/:p/callback, POST /api/auth/signout, GET /api/me
  routes/auth.test.ts           NEW
  routes/waitlist.ts            NEW  POST /api/waitlist
  routes/waitlist.test.ts       NEW
  routes/find.ts                NEW  POST /api/find — the deterministic search path
  routes/find.test.ts           NEW
  routes/config.ts              MOD  accountsEnabled, signinProviders, freeTier
  routes/chat.ts                MOD  funding pre-flight, per-account limiter key, credit event
  routes/settings.ts            MOD  free-tier model policy
  session.ts                    MOD  accountId, disk binding, rehydration, MINTING_ROUTES
  index.ts                      MOD  one shared sessionMiddleware for /api and /auth; new mounts
  accounts-e2e.test.ts          NEW  end-to-end with a fake OAuth provider
src/shared/types.ts             MOD  AccountView, MeResponse, SigninProvider, FreeTierInfo, "credit" event
src/web/
  account.ts                    NEW  header pill + menu, sign-in block, credit cards, waitlist sheet
  onboarding.ts                 MOD  sign-in first, key card behind a link
  settings.ts                   MOD  Account section; pickers hidden on free credit
  chat.ts                       MOD  credit event, new codes, composer note
  api.ts                        MOD  CODE_COPY additions, me()
  app.ts                        MOD  boot order, waitlist sheet trigger
  ui.ts                         MOD  SheetId gains "waitlist"
  index.html                    MOD  #accountPill, #waitlistSheet
  styles.css                    MOD  .signin-*, .account-*, .credit-*
scripts/
  gen-disposable-domains.mjs    NEW  regenerates the committed list
  count-prompt-tokens.mjs       NEW  `npm run tokens` — the real token count, owner's key
docs/DEPLOY.md README.md .env.example   MOD
```

## Task dependency graph

```
                      P1 (pricing)            ← lands on slicely-v3 FIRST, alone
                          │
        ┌─────────────────┼──────────────────┬──────────────────┐
        ▼                 ▼                  ▼                  ▼
  A1→A2→A3→A4→A5→A6→A7   B1→B2→B3→B4→B5   C1→C2→C3→C4→C5→C6   D1→D2→D3→D4→D5→D6→D7
  (accounts/core)        (accounts/oauth)  (accounts/web)      (accounts/efficiency)
        │                 │                  │                  │
        └─────────────────┴──────────────────┴──────────────────┘
                          ▼
                        E1 → E2 → E3
```

- **P1 is a hard prerequisite** and lands on `slicely-v3` before any worktree is cut: lane A meters
  with it and lane D's budget test asserts against it.
- **Four lanes then run in parallel, in four worktrees** (`superpowers:using-git-worktrees`):
  - **A — `accounts/core`**: `src/main/accounts/`, `src/main/agent/funding.ts`, `src/main/userkey.ts`,
    `src/main/settings.ts`, `src/server/session.ts`, `routes/chat.ts`, `routes/settings.ts`,
    `routes/config.ts`. Sequential within the lane.
  - **B — `accounts/oauth`**: `src/server/oauth/`, `routes/auth.ts`, `routes/waitlist.ts`,
    `src/server/index.ts` mounts. Depends on **A1 and A2's published interfaces only** — B4 calls
    `findOrCreateAccount`, `normalizeEmail`, `isDisposableDomain` and `bindAccountToSession`, all
    of whose signatures are frozen in this document. B writes its tests against a local stub of
    those four until the lanes merge, then deletes the stub.
  - **C — `accounts/web`**: `src/web/**`. Depends on **the wire contract only** (spec §10, restated
    in C1). It can be built and verified against a tiny dev shim; the shim is never committed.
  - **D — `accounts/efficiency`**: `src/main/agent/provider*.ts`, `agent.ts`, `prompt.ts`,
    `history.ts`, `tools*.ts`, `routes/find.ts`. Touches no accounts file. Depends on P1.
- **A6 and D1 both edit `routes/chat.ts` / `agent.ts`.** A6 adds the pre-flight gate and the
  `credit` event; D1 adds `usage` to `TurnResult` and threads `onUsage`. The merge order is
  **D before A6** — cut lane A's worktree from the commit that has D1, or rebase A6 onto it.
  That is the only ordering constraint between lanes and it is called out again in A6.
- **E1–E3 are last**, on the merged branch.

Merge back with `superpowers:finishing-a-development-branch` in the order **D → A → B → C**, running
`npm run typecheck && npm run test:only` after each merge, not only at the end.

---

## Task P1: One price table, in cents per million tokens

**Files:**
- Create: `src/main/pricing.ts`, `src/main/pricing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Cents per 1,000,000 tokens. Integers, so `tokens × rate` is the cost in µ¢
   *  (millionths of a cent) with no division and no float. */
  export interface ModelPrice {
    input: number;
    cachedRead: number;
    cacheWrite: number;
    output: number;
  }
  export const PRICE_TABLE: Readonly<Record<string, ModelPrice>>;
  export class UnpricedModelError extends Error {}
  export function priceFor(model: string): ModelPrice;          // throws UnpricedModelError
  export function isPriced(model: string): boolean;
  export interface TurnUsage {
    inputTokens: number;        // uncached input
    cachedInputTokens: number;  // served from cache
    cacheWriteTokens: number;   // written to cache (always 0 on OpenAI — see the file header)
    outputTokens: number;
  }
  export function costMicros(model: string, usage: TurnUsage): number;
  export function formatMoney(micros: number): string;          // 5_000_000 → "$0.05"; 0 → "$0.00"
  export const MICROS_PER_CENT = 1_000_000;
  export function centsToMicros(cents: number): number;
  ```
  `TurnUsage` lives here, not in `provider.ts`, so the meter and the providers share one shape
  without `provider.ts` importing the price table.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/pricing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG } from "./settings";
import {
  PRICE_TABLE, priceFor, isPriced, costMicros, formatMoney,
  centsToMicros, MICROS_PER_CENT, UnpricedModelError, type TurnUsage,
} from "./pricing";

test("every model a user can pick has a price — an unpriced model would meter at zero", () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(isPriced(m.id), `${m.id} has no row in PRICE_TABLE`);
  }
  assert.ok(isPriced("claude-sonnet-5"), "the free-tier Anthropic model must be priced");
  assert.ok(isPriced("gpt-5.6-luna"), "the free-tier OpenAI model must be priced");
});

test("an unpriced model is refused, never silently free", () => {
  assert.equal(isPriced("claude-imaginary-9"), false);
  assert.throws(() => priceFor("claude-imaginary-9"), UnpricedModelError);
});

test("Sonnet 5 costs what Anthropic charges, expressed as cents per million", () => {
  assert.deepEqual(PRICE_TABLE["claude-sonnet-5"], {
    input: 200, cachedRead: 20, cacheWrite: 250, output: 1000,
  });
  assert.deepEqual(PRICE_TABLE["gpt-5.6-luna"], {
    input: 20, cachedRead: 2, cacheWrite: 25, output: 120,
  });
});

test("the worked example from the spec costs exactly 4,714,000 µ¢", () => {
  // Spec §4.3: one "find me a phone stand" turn, four provider calls.
  const usage: TurnUsage = {
    inputTokens: 8_670,
    cachedInputTokens: 18_000,
    cacheWriteTokens: 6_000,
    outputTokens: 1_120,
  };
  assert.equal(costMicros("claude-sonnet-5", usage), 4_714_000);
  // 4.714¢ — so a 50¢ grant is ten and a bit turns like this.
  assert.equal(Math.floor(centsToMicros(50) / costMicros("claude-sonnet-5", usage)), 10);
});

test("the same turn with no caching costs 7,654,000 µ¢ — caching is what buys the trial", () => {
  const uncached: TurnUsage = {
    inputTokens: 6_000 * 4 + 8_670,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_120,
  };
  assert.equal(costMicros("claude-sonnet-5", uncached), 7_654_000);
});

test("money reads like money, and integer maths has no rounding surprises", () => {
  assert.equal(MICROS_PER_CENT, 1_000_000);
  assert.equal(centsToMicros(50), 50_000_000);
  assert.equal(formatMoney(50_000_000), "$0.50");
  assert.equal(formatMoney(42_400_000), "$0.42");   // floors, never rounds up
  assert.equal(formatMoney(999_999), "$0.00");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(-5), "$0.00");           // a small overshoot shows as empty, not negative
});

test("a zero usage costs zero, and every component is charged at its own rate", () => {
  const zero: TurnUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  assert.equal(costMicros("claude-sonnet-5", zero), 0);
  assert.equal(costMicros("claude-sonnet-5", { ...zero, inputTokens: 1_000_000 }), 200_000_000);
  assert.equal(costMicros("claude-sonnet-5", { ...zero, cachedInputTokens: 1_000_000 }), 20_000_000);
  assert.equal(costMicros("claude-sonnet-5", { ...zero, cacheWriteTokens: 1_000_000 }), 250_000_000);
  assert.equal(costMicros("claude-sonnet-5", { ...zero, outputTokens: 1_000_000 }), 1_000_000_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/main/pricing.test.js`
Expected: FAIL — `Cannot find module './pricing'`.

- [ ] **Step 3: Implement `src/main/pricing.ts`**

The table, verbatim (spec §4.1):

```ts
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  "claude-sonnet-5":   { input: 200,  cachedRead: 20,  cacheWrite: 250,  output: 1000 },
  "claude-opus-4-8":   { input: 500,  cachedRead: 50,  cacheWrite: 625,  output: 2500 },
  "claude-sonnet-4-6": { input: 300,  cachedRead: 30,  cacheWrite: 375,  output: 1500 },
  "claude-haiku-4-5":  { input: 100,  cachedRead: 10,  cacheWrite: 125,  output: 500  },
  // ── OpenAI ────────────────────────────────────────────────────────────────
  "gpt-5.6-terra":     { input: 200,  cachedRead: 20,  cacheWrite: 250,  output: 1200 },
  "gpt-5.6-luna":      { input: 20,   cachedRead: 2,   cacheWrite: 25,   output: 120  },
  "gpt-6-astra":       { input: 1000, cachedRead: 100, cacheWrite: 1250, output: 5000 },
};
```

Header comment must say, in plain words: these are list prices in **cents per million tokens**;
the owner may edit this table when a provider changes its rates and nothing else needs to change;
a model with no row is never metered (`priceFor` throws, the free tier pauses, and the
completeness test above fails) rather than being given away free; and **OpenAI does not itemise
cache writes** — its `usage.input_tokens` is the total with `input_tokens_details.cached_tokens`
broken out, so the 1.25× write premium on a cold prefix is invisible to us and the meter
under-reports it by at most 25% of one prefix per cache epoch, which the global daily cap bounds.

`formatMoney(micros)` = `"$" + (Math.max(0, micros) / 100_000_000).toFixed(2)` — but computed by
integer division to avoid float drift: `const cents = Math.floor(Math.max(0, micros) / MICROS_PER_CENT); return \`$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}\`;`

- [ ] **Step 4: Run tests**

Run: `npm run build && npm run test:only`
Expected: the 8 new tests pass; the baseline is otherwise unchanged. The completeness test will
fail on `claude-sonnet-5` **only if** Task A4 has not yet added it to the catalogue — that is
fine and expected here, because the table has the row and the catalogue check iterates the
catalogue. Confirm the assertion that reads `isPriced("claude-sonnet-5")` passes.

- [ ] **Step 5: Commit**

```bash
git add src/main/pricing.ts src/main/pricing.test.ts
git commit -m "slicely-v3: one table says what a thousand tokens costs"
```

---

# Lane A — Accounts, metering and the gate

Worktree `accounts/core`. Sequential: every task builds on the one before it.

## Task A1: The account store — one JSON per person, one index, no lost writes

**Files:**
- Create: `src/main/accounts/paths.ts`, `src/main/accounts/store.ts`, `src/main/accounts/store.test.ts`
- Modify: `src/main/config.ts` (add the free-tier numbers)

**Interfaces:**
- Consumes: `centsToMicros` (P1), `getConfig()` (existing).
- Produces:
  ```ts
  // paths.ts
  export function accountsRoot(): string;            // join(getConfig().workdir, "accounts")
  export function accountFile(id: string): string;    // <root>/by-id/<id>.json
  export function indexFile(): string;                // <root>/index.json
  export function usageFile(day: string): string;     // <root>/usage/<day>.ndjson
  export function spendFile(day: string): string;     // <root>/spend/<day>.json
  export function signupsFile(day: string): string;   // <root>/signups/<day>.json
  export function waitlistFile(): string;             // <root>/waitlist.ndjson
  export function utcDay(now = Date.now()): string;   // "YYYY-MM-DD"

  // store.ts
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
    /** True only the very first time a normalised email is seen. Drives the IP counter. */
    granted: boolean;
  }
  export function findOrCreateAccount(profile: SignInProfile, grantMicros: number): SignInOutcome;
  export function getAccount(id: string): Account | undefined;
  export function writeAccount(account: Account): void;        // atomic: temp sibling + rename
  export function balanceMicros(account: Account): number;     // max(0, granted − spent)
  export function deleteAccount(id: string): void;             // also retires the normalised email
  export function isRetired(normalizedEmail: string): boolean;
  export function withAccountLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  export function resetAccountsForTests(): void;               // drops the in-memory index cache
  ```
  `config.ts` gains, all read through the existing `envInt`/`envStr` helpers:
  ```ts
  freeCreditCents: number;        // SLICELY_FREE_CREDIT_CENTS, default 50
  freeModel: string;              // SLICELY_FREE_MODEL, default ""
  freeMaxOutputTokens: number;    // SLICELY_FREE_MAX_OUTPUT_TOKENS, default 4000
  freeChatsPerDay: number;        // SLICELY_FREE_CHATS_PER_DAY, default 40
  signupsPerIpPerDay: number;     // SLICELY_SIGNUPS_PER_IP_PER_DAY, default 3
  dailySpendCapCents: number;     // SLICELY_DAILY_SPEND_CAP_CENTS, default 500
  maxHistoryTurns: number;        // SLICELY_MAX_HISTORY_TURNS, default 12
  publicUrl: string;              // SLICELY_PUBLIC_URL, default ""
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/accounts/store.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { centsToMicros } from "../pricing";
import {
  findOrCreateAccount, getAccount, writeAccount, balanceMicros,
  deleteAccount, isRetired, withAccountLock, resetAccountsForTests,
  type SignInProfile,
} from "./store";
import { accountFile, indexFile, utcDay } from "./paths";

function freshWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "slicely-accounts-"));
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  resetAccountsForTests();
  return dir;
}

const GRANT = centsToMicros(50);

function profile(over: Partial<SignInProfile> = {}): SignInProfile {
  return {
    provider: "google",
    providerUserId: "107812345",
    email: "Jane.Doe@gmail.com",
    normalizedEmail: "janedoe@gmail.com",
    name: "Jane Doe",
    ...over,
  };
}

test("a first sign-in creates an account with the grant, and says it granted", () => {
  const dir = freshWorkdir();
  try {
    const { account, granted } = findOrCreateAccount(profile(), GRANT);
    assert.equal(granted, true);
    assert.equal(account.grantedMicros, GRANT);
    assert.equal(account.spentMicros, 0);
    assert.equal(balanceMicros(account), GRANT);
    assert.equal(account.email, "Jane.Doe@gmail.com", "the display email is kept verbatim");
    assert.equal(account.normalizedEmail, "janedoe@gmail.com");
    assert.equal(account.chatDay, utcDay());
    assert.equal(account.chatCount, 0);
    assert.ok(/^[0-9a-f]{32}$/.test(account.id), "ids are 16 random bytes in hex");
    assert.ok(existsSync(accountFile(account.id)));
    assert.ok(existsSync(indexFile()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("signing in again finds the same account and grants nothing more", () => {
  const dir = freshWorkdir();
  try {
    const first = findOrCreateAccount(profile(), GRANT);
    first.account.spentMicros = 30_000_000;
    writeAccount(first.account);

    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.granted, false);
    assert.equal(again.account.id, first.account.id);
    assert.equal(again.account.grantedMicros, GRANT, "the grant is not topped up");
    assert.equal(again.account.spentMicros, 30_000_000, "spend survives a re-sign-in");
    assert.equal(balanceMicros(again.account), 20_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same human on a second provider is the same account — one grant per person", () => {
  const dir = freshWorkdir();
  try {
    const viaGoogle = findOrCreateAccount(profile(), GRANT);
    const viaGithub = findOrCreateAccount(
      profile({ provider: "github", providerUserId: "99", email: "janedoe@gmail.com" }),
      GRANT,
    );
    assert.equal(viaGithub.granted, false);
    assert.equal(viaGithub.account.id, viaGoogle.account.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh process re-reads the index off disk", () => {
  const dir = freshWorkdir();
  try {
    const first = findOrCreateAccount(profile(), GRANT);
    resetAccountsForTests();                 // as if the server restarted
    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.account.id, first.account.id);
    assert.equal(again.granted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleting an account retires the email, so credit is never granted twice", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    deleteAccount(account.id);
    assert.equal(getAccount(account.id), undefined);
    assert.equal(existsSync(accountFile(account.id)), false);
    assert.equal(isRetired("janedoe@gmail.com"), true);

    const back = findOrCreateAccount(profile(), GRANT);
    assert.notEqual(back.account.id, account.id, "a new record …");
    assert.equal(back.granted, false, "… but no new credit");
    assert.equal(back.account.grantedMicros, 0);
    assert.equal(balanceMicros(back.account), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an account file holds no secret and no IP", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    const raw = readFileSync(accountFile(account.id), "utf8");
    for (const forbidden of ["access_token", "id_token", "sk-", "Bearer", "127.0.0.1", "verifier"]) {
      assert.ok(!raw.includes(forbidden), `${forbidden} must never reach an account file`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent charges under the lock land exactly once each", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withAccountLock(account.id, async () => {
          const live = getAccount(account.id)!;
          live.spentMicros += 1_000;
          await new Promise((r) => setTimeout(r, 1));   // force interleaving
          writeAccount(live);
        }),
      ),
    );
    resetAccountsForTests();
    assert.equal(getAccount(account.id)!.spentMicros, 20_000, "no lost update");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing).

- [ ] **Step 3: Implement**

`paths.ts`: plain `join`s off `accountsRoot()`, each directory `mkdirSync(..., { recursive: true })`
on first use. `utcDay(now)` = `new Date(now).toISOString().slice(0, 10)`.

`store.ts`:
- Module state: `let index: AccountIndex | undefined` and `const accounts = new Map<string, Account>()`
  (a read-through cache), plus `const locks = new Map<string, Promise<unknown>>()`.
- `loadIndex()` reads `indexFile()` or returns `{ version: 1, byProviderUser: {}, byEmail: {}, retired: [] }`;
  a malformed file is replaced, not thrown on (a hand-edited index must not brick sign-in).
- `writeAtomic(path, text)`: write `path + ".tmp-" + randomBytes(6).toString("hex")` with mode
  `0o600`, then `renameSync`; `rmSync` the temp on failure. Same shape as `userkey.ts`.
- `findOrCreateAccount`: look up `byProviderUser["<provider>:<id>"]`, then `byEmail[normalized]`.
  On a hit, refresh `email`/`name`/`lastSeenAt`, add the `byProviderUser` entry if this is a new
  provider for the same person, write, return `{ account, granted: false }`. On a miss, create with
  `grantedMicros = isRetired(normalized) ? 0 : grantMicros` and
  `granted = grantedMicros > 0`.
- `withAccountLock(id, fn)`: chain onto `locks.get(id) ?? Promise.resolve()`, always clearing the
  entry in a `finally` when it is still the tail. Errors must not poison the chain.
- `deleteAccount`: remove both index entries, push the normalised email onto `retired` (deduped),
  write the index, `rmSync` the account file, drop the cache entry.

`config.ts`: add the eight fields listed above to `SlicelyConfig` and `getConfig()`, each with a
one-line comment saying what it bounds. Do **not** read any provider key here — `config.ts`'s
header comment promises it holds no AI credential and that stays true.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/accounts src/main/config.ts
git commit -m "slicely-v3: an account is one small file, and a grant happens once"
```

## Task A2: One email is one person

**Files:**
- Create: `src/main/accounts/email.ts`, `src/main/accounts/email.test.ts`,
  `src/main/accounts/disposable-domains.ts`, `scripts/gen-disposable-domains.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface NormalizedEmail { email: string; normalized: string; domain: string }
  export class EmailRejected extends Error { constructor(readonly code: "email_invalid" | "email_blocked") }
  export function normalizeEmail(raw: unknown): NormalizedEmail;   // throws EmailRejected("email_invalid")
  export function isDisposableDomain(domain: string): boolean;
  export const DISPOSABLE_DOMAINS: ReadonlySet<string>;            // from disposable-domains.ts
  ```

**Why no dependency:** the list is generated once by `scripts/gen-disposable-domains.mjs` from the
public `disposable-email-domains` dataset and committed as a TypeScript array. No package, no
boot-time fetch, no breakage when the upstream repo moves. Regenerating it is a deliberate act.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/accounts/email.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, isDisposableDomain, EmailRejected, DISPOSABLE_DOMAINS } from "./email";

test("gmail dots and plus-tags are the same mailbox, and googlemail is gmail", () => {
  const cases = [
    ["Jane.Doe@gmail.com", "janedoe@gmail.com"],
    ["j.a.n.e.d.o.e@GMAIL.COM", "janedoe@gmail.com"],
    ["janedoe+slicely@gmail.com", "janedoe@gmail.com"],
    ["jane.doe+a+b@googlemail.com", "janedoe@gmail.com"],
    ["  janedoe@gmail.com  ", "janedoe@gmail.com"],
  ] as const;
  for (const [raw, want] of cases) {
    assert.equal(normalizeEmail(raw).normalized, want, raw);
  }
});

test("outside gmail a dot is significant, but a plus-tag still is not", () => {
  assert.equal(normalizeEmail("jane.doe@example.com").normalized, "jane.doe@example.com");
  assert.equal(normalizeEmail("jane.doe+slicely@example.com").normalized, "jane.doe@example.com");
  assert.equal(normalizeEmail("Jane@Example.COM").normalized, "jane@example.com");
});

test("the display email is preserved even while the key is normalised", () => {
  const n = normalizeEmail("Jane.Doe+shop@Gmail.com");
  assert.equal(n.email, "Jane.Doe+shop@Gmail.com");
  assert.equal(n.normalized, "janedoe@gmail.com");
  assert.equal(n.domain, "gmail.com");
});

test("nonsense is refused with email_invalid, never normalised into something plausible", () => {
  for (const bad of ["", "   ", "jane", "jane@", "@example.com", "jane@localhost",
                     "jane@@example.com", "jane doe@example.com", null, undefined, 42,
                     "+tag@gmail.com", "a".repeat(250) + "@example.com"]) {
    assert.throws(() => normalizeEmail(bad as unknown),
      (e: unknown) => e instanceof EmailRejected && e.code === "email_invalid",
      JSON.stringify(bad));
  }
});

test("throwaway domains are refused and real ones are not", () => {
  assert.ok(DISPOSABLE_DOMAINS.size > 1000, "the bundled list should be substantial");
  for (const d of ["mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com"]) {
    assert.equal(isDisposableDomain(d), true, d);
  }
  for (const d of ["gmail.com", "googlemail.com", "outlook.com", "protonmail.com",
                   "icloud.com", "cam.ac.uk", "slicely.example"]) {
    assert.equal(isDisposableDomain(d), false, d);
  }
  assert.equal(isDisposableDomain("MAILINATOR.COM"), true, "case must not be a bypass");
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`normalizeEmail`: trim; reject non-string, empty, over 254 characters; `lastIndexOf("@")` must be
> 0 and not the last character; exactly one `@`; the domain must contain a dot and match
`/^[a-z0-9.-]+$/` after lowercasing; the local part must be non-empty **after** tag stripping
(hence `+tag@gmail.com` is invalid, not ""). Alias `googlemail.com → gmail.com` before the gmail
dot rule so `jane.doe@googlemail.com` folds correctly.

`scripts/gen-disposable-domains.mjs`: fetches the upstream list, lowercases, sorts, dedupes, drops
anything that is not a plain domain, and writes `disposable-domains.ts` as
`export const DISPOSABLE_DOMAIN_LIST: readonly string[] = [ … ];` with a header comment naming the
source, the date and the command that regenerates it. Run it once; commit the output. If the fetch
fails, the script exits non-zero and changes nothing — the committed list is the source of truth.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/accounts/email.ts src/main/accounts/email.test.ts \
        src/main/accounts/disposable-domains.ts scripts/gen-disposable-domains.mjs
git commit -m "slicely-v3: one mailbox is one person, and throwaway addresses are not invited"
```

## Task A3: The meter — charge a call, count a day, and pause when the day is spent

**Files:**
- Create: `src/main/accounts/meter.ts`, `src/main/accounts/meter.test.ts`,
  `src/main/accounts/signups.ts`, `src/main/accounts/signups.test.ts`

**Interfaces:**
- Consumes: `costMicros`, `TurnUsage`, `centsToMicros` (P1); `Account`, `withAccountLock`,
  `getAccount`, `writeAccount`, `balanceMicros` (A1).
- Produces:
  ```ts
  // meter.ts
  export interface ChargeResult { balanceMicros: number; chargedMicros: number; exhausted: boolean }
  export async function chargeAccount(accountId: string, model: string, usage: TurnUsage): Promise<ChargeResult>;
  export function dailySpendMicros(day?: string): number;
  export function freeTierPaused(day?: string): boolean;          // dailySpend >= cap
  export interface ChatAllowance { allowed: boolean; used: number; limit: number }
  export async function countChatTurn(accountId: string): Promise<ChatAllowance>;  // increments
  export function chatAllowance(account: Account): ChatAllowance;                  // read-only
  export function resetMeterForTests(): void;

  // signups.ts
  export function hashIp(ip: string): string;                     // sha256(cookieSecret ‖ ip), 32 hex
  export interface SignupAllowance { allowed: boolean; used: number; limit: number }
  export function countSignup(ip: string): SignupAllowance;       // increments; refuses over the cap
  export function signupAllowance(ip: string): SignupAllowance;   // read-only
  export function resetSignupsForTests(): void;
  ```
  `hashIp` takes its salt from the existing cookie-signing secret via a new
  `export function cookieSecretBytes(): Buffer` on `src/server/session.ts`… **no.** That would make
  `src/main` depend on `src/server`. Instead `signups.ts` reads or creates its own 32-byte salt at
  `<accountsRoot>/.signup-salt` (mode `0600`), exactly the way `loadOrCreateSecret` does for
  cookies. Same property (useless off this machine), no layering violation.

- [ ] **Step 1: Write the failing tests**

`meter.test.ts`, using the same `freshWorkdir()` helper as A1 (copy it — a shared test helper file
would be a new module in the dist tree for no gain):

1. `chargeAccount` with the spec §4.3 usage on `claude-sonnet-5` moves `spentMicros` by exactly
   `4_714_000`, returns `balanceMicros === 45_286_000` and `exhausted === false`, appends **exactly
   one** line to `usage/<today>.ndjson`, and raises `spend/<today>.json`'s `micros` by the same
   4,714,000.
2. The ledger line parses as JSON with exactly the keys `ts, accountId, model, in, cacheRead,
   cacheWrite, out, micros` and **no** `email`, `ip` or `prompt`, and `micros` equals
   `costMicros(...)`.
3. Eleven charges of 4,714,000 µ¢ drive the balance to 0 (not negative) and the eleventh returns
   `exhausted === true`.
4. `chargeAccount` on an unpriced model throws `UnpricedModelError`, writes **nothing**, and leaves
   `spentMicros` at 0.
5. `freeTierPaused()` is `false` at 0 spend; after `SLICELY_DAILY_SPEND_CAP_CENTS=1` (1¢ =
   1,000,000 µ¢) and one 4,714,000 µ¢ charge it is `true`; with the day rolled forward one UTC day
   it is `false` again (pass the `day` argument rather than mocking the clock).
6. `countChatTurn` returns `{ allowed: true, used: 1, limit: 40 }` first time; after 40 calls the
   41st returns `{ allowed: false, used: 40, limit: 40 }` and does **not** increment past 40; an
   account whose `chatDay` is yesterday resets to `used: 1` on the next call.
7. Twenty concurrent `chargeAccount` calls of a 1,000 µ¢ usage leave `spentMicros === 20_000` and
   twenty ledger lines.

`signups.test.ts`:

1. `hashIp("1.2.3.4")` is 32 lowercase hex characters, is stable across calls, differs from
   `hashIp("1.2.3.5")`, and **does not contain the address** as a substring.
2. `countSignup` returns `used` 1, 2, 3 for the first three calls with `allowed: true`; the fourth
   returns `{ allowed: false, used: 3, limit: 3 }`.
3. `signups/<day>.json` contains no dotted-quad and no colon-separated IPv6 literal (regex assert).
4. A different IP has its own counter.
5. After `resetSignupsForTests()` and a fresh read, the counts come back off disk.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`chargeAccount` body, in order, all inside `withAccountLock(accountId, …)`:
`const price = priceFor(model)` **first** (so an unpriced model throws before anything is written);
`const micros = costMicros(model, usage)`; read the live account (404 → throw
`WireError`-free `Error("no such account")`, which `toWire` turns into a generic 500 — a charge
against a vanished account is a bug, not a user-facing condition); `spentMicros += micros`;
`lastSeenAt = Date.now()`; `writeAccount`; `appendFileSync(usageFile(day), line + "\n")`;
`addDailySpend(day, micros)` (read-modify-write `spend/<day>.json` atomically, inside the same
lock). Return `{ balanceMicros: balanceMicros(account), chargedMicros: micros, exhausted: balanceMicros(account) <= 0 }`.

`addDailySpend` is shared mutable state across accounts, so it needs its own lock keyed on the day
string — reuse `withAccountLock(\`spend:${day}\`, …)`; the lock map is keyed on arbitrary strings
and the prefix keeps the namespaces apart.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/accounts/meter.ts src/main/accounts/meter.test.ts \
        src/main/accounts/signups.ts src/main/accounts/signups.test.ts
git commit -m "slicely-v3: every model call is counted, and the day has a ceiling"
```

## Task A4: Who pays for this turn

**Files:**
- Create: `src/main/agent/funding.ts`, `src/main/agent/funding.test.ts`
- Modify: `src/main/settings.ts` (the `claude-sonnet-5` entry), `src/main/userkey.ts` (retire the
  operator flag), `.env.example` (retire it there too — the README pass is E1)

**Interfaces:**
- Consumes: `priceFor`, `costMicros`, `TurnUsage`, `centsToMicros` (P1); `Account`,
  `balanceMicros` (A1); `chargeAccount`, `freeTierPaused`, `countChatTurn` (A3);
  `getUserApiKey`, `hasAnyUserApiKey` (existing); `providerForModel`, `getProvider` (existing);
  `getConfig`, `isHosted`, `isDesktop` (existing); `WireError` (existing, `src/server/errors.ts`).
- Produces:
  ```ts
  export interface FreeTierInfo {
    model: string;            // "claude-sonnet-5" | "gpt-5.6-luna" | SLICELY_FREE_MODEL
    modelLabel: string;       // from MODEL_CATALOG
    effort: "medium";
    creditCents: number;
    maxOutputTokens: number;
  }
  /** The free tier as configured, or undefined when it is off (no owner key, no
   *  priced model, or desktop mode). Read fresh — env changes on restart only. */
  export function freeTierInfo(): FreeTierInfo | undefined;
  /** True when the sign-in buttons should render: hosted, a free tier exists, and
   *  at least one OAuth provider is fully configured. `oauthConfigured` is injected
   *  so src/main never imports src/server. */
  export function accountsEnabled(oauthConfigured: boolean): boolean;

  export type FundingSource = "user" | "free";
  export interface TurnFunding {
    source: FundingSource;
    apiKey: string;
    model: string;
    effort: EffortLevel;
    maxOutputTokens: number;
    /** Throws WireError(402, …, "credit_exhausted") when the balance ran out.
     *  A no-op for source "user". Called before every provider call. */
    guard(): void;
    /** Charges one provider call and updates the cached balance. No-op for "user". */
    onUsage(usage: TurnUsage): Promise<void>;
    /** The balance after the last charge, for the `credit` SSE event. undefined for "user". */
    balance(): { balanceMicros: number; balanceLabel: string; exhausted: boolean } | undefined;
  }
  export interface FundingContext { accountId?: string; oauthConfigured: boolean }
  /** The single policy function. Throws WireError for every refusal in spec §10.4. */
  export function resolveTurnFunding(ctx: FundingContext): TurnFunding;
  ```
  `MODEL_CATALOG` gains, as the **first** Anthropic entry after Opus (so the free model is visible
  in the picker to key-holders too):
  ```ts
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Sonnet 5",
    blurb: "Balanced and cheap — the model free credit runs on",
    supportsEffort: true,
    supportsXHigh: true,
    supportsMax: true,
    supportsAdaptiveThinking: true,
  },
  ```
  `userkey.ts`: `operatorKeyAllowed()` becomes `return isDesktop();` — the whole body. Delete the
  `SLICELY_ALLOW_OPERATOR_KEY` read and update the doc comment to say the hosted path is now a
  metered account (pointing at `funding.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/agent/funding.test.ts — shape; fill in the freshWorkdir/account helpers as in A1.
// 1. A user with their own Anthropic key and model claude-opus-4-8:
//    resolveTurnFunding({ oauthConfigured: true }) → source "user", apiKey the user's,
//    model "claude-opus-4-8", maxOutputTokens 16000 (the provider's), guard() does not throw,
//    onUsage() charges nothing (no ledger file is created at all), balance() is undefined.
// 2. Hosted, ANTHROPIC_API_KEY set, OAuth configured, NO accountId:
//    throws WireError with status 401 and code "signin_required".
// 3. Hosted, ANTHROPIC_API_KEY set, SLICELY_ALLOW_OPERATOR_KEY=1, no accountId:
//    STILL throws 401 signin_required — the retired flag buys nothing.
//    And getUserApiKey("anthropic") returns undefined in hosted mode with that flag set.
// 4. Hosted, desktop=false, no OAuth configured, no user key:
//    throws NoApiKeyError (code "no_key") — today's behaviour, unchanged.
// 5. Signed in with 50¢: source "free", apiKey === process.env.ANTHROPIC_API_KEY,
//    model "claude-sonnet-5", effort "medium", maxOutputTokens 4000.
// 6. Signed in with 0¢: throws 402 "credit_exhausted".
// 7. Account blocked: throws 403 "email_blocked".
// 8. freeTierPaused (cap 1¢, already spent): throws 503 "free_tier_paused".
// 9. Chat cap spent (chatCount 40): throws 429 "rate_limited", message names 40.
// 10. Only OPENAI_API_KEY set → freeTierInfo().model === "gpt-5.6-luna".
//     Both set → "claude-sonnet-5". Neither set → freeTierInfo() undefined and
//     accountsEnabled(true) === false.
// 11. SLICELY_FREE_MODEL="gpt-5.6-luna" with only ANTHROPIC_API_KEY set → freeTierInfo()
//     is undefined (its provider has no owner key) and the misconfiguration is logged once.
// 12. SLICELY_FREE_MODEL="claude-imaginary-9" → freeTierInfo() undefined (unpriced).
// 13. isDesktop() → accountsEnabled(true) === false and freeTierInfo() undefined.
// 14. Metering through the seam: a free funding whose onUsage() is called with the spec §4.3
//     usage leaves the account's spentMicros at 4_714_000, and balance() reports
//     { balanceMicros: 45_286_000, balanceLabel: "$0.45", exhausted: false }.
// 15. guard() after the balance hits zero throws 402 "credit_exhausted" with the mid-turn
//     wording ("part-way through"), distinct from the pre-flight sentence.
// 16. The user-key path wins even when an account has credit: a signed-in user who has pasted
//     their own key gets source "user" and nothing is metered.
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`resolveTurnFunding` order — this is the spec's §10.4 table and the order is load-bearing:

```
const active = providerForModel(getSettings().model);
const own = getUserApiKey(active.id);
if (own) return userFunding(own, getSettings(), active);

const free = freeTierInfo();
if (!free || !accountsEnabled(ctx.oauthConfigured)) {
  throw new NoApiKeyError(`Connect your ${active.label} API key in Settings to chat.`);
}
if (!ctx.accountId) throw new WireError(401,
  "Sign in to start — you get free credit to try Slicely.", "signin_required");
const account = getAccount(ctx.accountId);
if (!account)      throw new WireError(401, "Sign in again to keep going.", "signin_required");
if (account.blocked) throw new WireError(403,
  "This account can't use Slicely. Get in touch if that's wrong.", "email_blocked");
if (freeTierPaused()) throw new WireError(503,
  "Free usage is busy today — add your own key or try tomorrow.", "free_tier_paused");
const chats = chatAllowance(account);
if (!chats.allowed) throw new WireError(429,
  `You've used your ${chats.limit} free chats for today. Add your own key to keep going.`,
  "rate_limited");
if (balanceMicros(account) <= 0) throw new WireError(402,
  "You've used your free credit. Add your own API key to keep going.", "credit_exhausted");
return freeFunding(account, free);
```

`freeFunding` keeps a local `let balance = balanceMicros(account)`; `guard()` throws
`WireError(402, "Your free credit ran out part-way through that answer. Add your own API key to carry on.", "credit_exhausted")`
when `balance <= 0`; `onUsage(u)` awaits `chargeAccount(account.id, free.model, u)` and assigns
`balance` from the result; `balance()` returns `{ balanceMicros: Math.max(0, balance), balanceLabel: formatMoney(balance), exhausted: balance <= 0 }`.

`freeTierInfo()`: apply spec §6 exactly. The owner key is read here and **only** here in
`src/main` outside `userkey.ts`'s desktop fallback: `process.env.ANTHROPIC_API_KEY?.trim()`.
Log a single-line warning (not per request — guard with a module flag) when
`SLICELY_FREE_MODEL` is set but unusable, naming which of the three reasons applies.

- [ ] **Step 4: Run tests, expect PASS.** Also confirm `src/main/pricing.test.ts`'s catalogue
  completeness test now covers `claude-sonnet-5` through `MODEL_CATALOG`, and that
  `src/main/userkey.test.ts` still passes after the operator-gate change (update the one test that
  sets `SLICELY_ALLOW_OPERATOR_KEY=1` and expects a hosted fallback: it must now expect
  `undefined`, with a comment pointing at this task).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/funding.ts src/main/agent/funding.test.ts \
        src/main/settings.ts src/main/userkey.ts src/main/userkey.test.ts .env.example
git commit -m "slicely-v3: one function decides who pays for a turn, and strangers can't spend the owner's key"
```

## Task A5: A session remembers who signed in — across a deploy

**Files:**
- Modify: `src/server/session.ts`, `src/server/session.test.ts`
- Create: `src/server/account-binding.test.ts`

**Interfaces:**
- Produces, from `session.ts`:
  ```ts
  export interface SessionRecord { /* …as today… */ accountId?: string }
  export function bindAccountToSession(session: SessionRecord, accountId: string): void;
  export function unbindAccountFromSession(session: SessionRecord): void;
  export function readSessionAccountId(dir: string): string | undefined;
  ```
  `<session>/account.json` = `{ "version": 1, "accountId": "…" }`, mode `0600`, written
  atomically. Added to `PERSONAL_FILES` (so "Delete my data" removes it) — the exported
  `SESSION_PERSONAL_FILES` / `SESSION_KEPT_FILES` census test will fail until it is classified,
  which is exactly why that test exists.
  `MINTING_ROUTES` gains the two auth paths. Because they are parameterised, `mayMintSession`
  gains one regex beside the set:
  ```ts
  const MINTING_PATTERNS = [/^GET \/auth\/[a-z]+\/(start|callback)$/];
  ```
  `SessionStore.lookup()` gains rehydration: when the HMAC verifies and `this.sessions` has no
  record, and `isDesktop()` is false, and the id matches `/^[0-9a-f]{32}$/`, and
  `join(this.root, id)` exists and is a directory, then `materialize(id, join(this.root, id))` and
  read `account.json` into `record.accountId`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/account-binding.test.ts
// 1. bindAccountToSession writes <dir>/account.json 0600 with exactly {version,accountId};
//    readSessionAccountId(dir) round-trips it; unbind deletes the file and clears the field.
// 2. REHYDRATION: build store A over tmpRoot, GET /api/config to mint a cookie, bind an
//    account, write a marker file into the session dir. Build a SECOND SessionStore over the
//    same sessionsRoot and secretDir (as a restart would). Drive a request with the same
//    cookie. Assert: the session id is the same, store.count() === 1, req.session.accountId
//    is the bound id, and the marker file is still there — i.e. nobody lost their workspace,
//    their stored key or their credit to a deploy.
// 3. A cookie whose HMAC does not verify still mints a NEW session (rehydration must not
//    weaken the signature check).
// 4. A verified cookie for an id whose directory no longer exists mints a new session and
//    does not create a directory named after the old id.
// 5. An id that is not 32 hex characters is never rehydrated (guards against a signed id
//    containing "..", even though sign() could never produce one).
// 6. Desktop mode: rehydration is skipped (desktopSession() already answers every request).
// 7. MINTING: GET /auth/google/start and GET /auth/google/callback with no cookie reach the
//    handler (404 from the unmounted router in this test app, NOT 401 no_session);
//    GET /auth/google/bogus with no cookie is still 401 no_session.
// 8. DELETE /api/session removes account.json along with everything else, and the exported
//    SESSION_PERSONAL_FILES contains "account.json".
```

- [ ] **Step 2: Run, expect FAIL** (no `accountId`, no rehydration, 401 on `/auth/...`).

- [ ] **Step 3: Implement.** Keep `lookup()`'s existing `lastActiveAt` touch. The rehydration
  branch must be the *only* new behaviour — do not change `sign`/`verify`, the cookie name, or the
  mint budget. Add a comment saying why rehydration is safe (the HMAC is still the sole proof of
  ownership; the directory check is a containment guard, not an authorisation one).

- [ ] **Step 4: Run tests, expect PASS** — including the existing `session.test.ts` suite.

- [ ] **Step 5: Commit**

```bash
git add src/server/session.ts src/server/session.test.ts src/server/account-binding.test.ts
git commit -m "slicely-v3: signing in sticks to your workspace, and a restart doesn't sign you out"
```

## Task A6: The chat route asks who pays before it says a word

**Files:**
- Modify: `src/server/routes/chat.ts`, `src/main/agent/agent.ts`, `src/shared/types.ts`,
  `src/server/routes/chat.test.ts`
- Create: `src/server/routes/chat-credit.test.ts`

**Depends on D1** (`TurnResult.usage` and the `onUsage` thread through `agent.ts`). Cut this
worktree from a commit that contains D1, or rebase.

**Interfaces:**
- Consumes: `resolveTurnFunding`, `TurnFunding` (A4); `countChatTurn` (A3); `TurnUsage` (P1).
- Produces:
  ```ts
  // shared/types.ts — one new AgentEvent variant
  | { type: "credit"; balanceMicros: number; balanceLabel: string; exhausted: boolean }

  // agent/agent.ts
  export interface AgentOptions {
    resolveProvider?: (model: string) => Provider;   // existing, tests only
    /** Injected per turn by the chat route. Tests pass a stub. */
    resolveFunding?: (ctx: FundingContext) => TurnFunding;
  }
  ```
  `SlicelyAgent.send()` changes shape inside, not outside:
  - the constructor's "has a key?" check becomes `resolveTurnFunding(ctx)` in a try/catch that
    rethrows — so `new SlicelyAgent()` still throws the right typed error for the pre-flight;
  - per turn: `const funding = this.resolveFunding({ accountId: this.accountId, oauthConfigured })`
    once, and `provider = resolveProvider(funding.model)`;
  - the `StreamRequest` takes `apiKey/model/effort/maxOutputTokens` **from `funding`**, never from
    `getSettings()` — a stale session setting can no longer point a free user at a model they
    cannot pay for;
  - before each of the ≤12 iterations: `funding.guard()`;
  - after each: `if (result.usage) await funding.onUsage(result.usage)`;
  - after the loop, in the `finally` before `emit({type:"done"})`:
    `const b = funding.balance(); if (b) emit({ type: "credit", ...b })`.
- `routes/chat.ts`:
  - the pre-flight becomes `try { resolveTurnFunding({ accountId: req.session?.accountId, oauthConfigured }) } catch (err) { sendError(res, err); return; }` — replacing today's
    `getUserApiKey` check, still **before** `res.writeHead`;
  - then `const allowance = await countChatTurn(accountId)` for a free turn only, refusing 429 if
    the increment was refused (the read-only check in `resolveTurnFunding` is the fast path; this
    is the one that actually counts, so two tabs cannot both slip past 40);
  - the `chat` limiter gains a key function so many tabs on one account share one bucket:
    ```ts
    keyFn: (req) => (req.session?.accountId ? `acct:${req.session.accountId}` : undefined)
    ```
    (returning `undefined` falls through to the existing session/IP default).

- [ ] **Step 1: Write the failing tests** — `chat-credit.test.ts`, `createApp` + `fetch`, a stub
  agent factory, and a fake account written straight to the store:

```
// 1. Each of the seven pre-flight rows answers the right status + code BEFORE any SSE byte:
//    - accounts on, no key, not signed in            → 401 { code: "signin_required" }
//    - blocked account                                → 403 { code: "email_blocked" }
//    - daily cap spent                                → 503 { code: "free_tier_paused" }
//    - chat cap spent                                 → 429 { code: "rate_limited" } + Retry-After
//    - zero balance                                   → 402 { code: "credit_exhausted" }
//    - accounts off, no key                           → 409 { code: "no_key" }
//    - signed in with credit                          → 200 text/event-stream
//    For each refusal assert `content-type` is application/json, NOT text/event-stream.
// 2. A metered turn: a stub provider reporting the §4.3 usage → the account's spentMicros is
//    4_714_000, usage/<day>.ndjson has exactly one line, and the SSE stream contains
//    { type: "credit", balanceMicros: 45_286_000, balanceLabel: "$0.45", exhausted: false }
//    exactly once, before `done`.
// 3. A BYO-key turn on the same signed-in session emits NO credit event and writes NO ledger
//    line — a user paying their own bill is never metered.
// 4. Mid-turn exhaustion: a stub provider whose usage empties the balance on iteration 1 and
//    still asks for a tool → the stream carries { type: "error", code: "credit_exhausted" }
//    then `done`, and the balance is 0, not negative beyond one call.
// 5. Forty turns are allowed and the forty-first is refused, even across two different
//    session cookies bound to the SAME account (this is what the keyFn and countChatTurn are
//    for — assert both cookies see the 429).
// 6. A hosted server with ANTHROPIC_API_KEY set and nobody signed in never reaches the
//    provider: the stub factory records zero calls.
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep the existing comment explaining why the refusal must precede
  `writeHead` and extend it to name the new codes. `oauthConfigured` is threaded in from
  `createApp` via a new `CreateAppOptions` field (`oauth?: OauthConfig`) so a test can turn
  accounts on and off without touching env; it defaults to reading the env.
- [ ] **Step 4: Run tests, expect PASS** — including the existing `chat.test.ts`,
  `chat-cancel.test.ts` and `chat-paths.test.ts` untouched.
- [ ] **Step 5: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat-credit.test.ts \
        src/main/agent/agent.ts src/shared/types.ts
git commit -m "slicely-v3: a chat turn knows whose credit it is spending, and stops when it's gone"
```

## Task A7: Config tells the client the rules, and a free user can't pick a model

**Files:**
- Modify: `src/server/routes/config.ts`, `src/server/routes/settings.ts`, `src/shared/types.ts`
- Create: `src/server/routes/config-accounts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/types.ts
  export interface SigninProvider { id: "google" | "github"; label: string }
  export interface FreeTierView { model: string; modelLabel: string; effort: "medium"; creditCents: number }
  export interface AccountView {
    email: string; name?: string; initial: string;
    balanceMicros: number; balanceLabel: string;
    grantedMicros: number; grantedLabel: string;
    chatsToday: number; chatsPerDay: number; exhausted: boolean;
  }
  export interface MeResponse { signedIn: boolean; account?: AccountView }
  ```
  `ConfigResponse` gains `accountsEnabled: boolean`, `signinProviders: SigninProvider[]`,
  `freeTier: FreeTierView | null`. Every existing field keeps its shape and position.
  `createConfigRouter(opts?: { oauth?: OauthConfig })` — the one new option, so a test can render
  both states.
  `PATCH /api/settings`: when `resolveTurnFunding` would return `source: "free"` (i.e. the caller
  has no key for the requested model's provider **and** is running on credit), a `model` change is
  refused `403 { error: "Add your own key to choose models.", code: "forbidden" }` — the exact
  sentence the UI shows, so the two cannot drift. `effort` changes are refused the same way.

- [ ] **Step 1: Write the failing tests**

```
// config-accounts.test.ts
// 1. OAuth configured + ANTHROPIC_API_KEY → accountsEnabled true, signinProviders
//    [{id:"google",label:"Google"},{id:"github",label:"GitHub"}] in that order,
//    freeTier { model: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "medium",
//    creditCents: 50 }.
// 2. No OAuth secrets → accountsEnabled false, signinProviders [], freeTier null,
//    and every field that exists today is byte-identical to the no-accounts response.
// 3. Only GOOGLE_* set → signinProviders is [google] only.
// 4. OAuth set but no owner key → accountsEnabled false (nothing to fund), freeTier null.
// 5. Desktop mode → accountsEnabled false, signinProviders [], freeTier null.
// 6. The response body contains no "sk-", no client secret, and no "ANTHROPIC_API_KEY".
// 7. GET /api/me signed out → { signedIn: false } and no `account` key at all.
// 8. GET /api/me signed in → initial "J" for jane@example.com, balanceLabel "$0.50",
//    grantedLabel "$0.50", chatsToday 0, chatsPerDay 40, exhausted false.
//    (GET /api/me lands in Task B4; assert it here only if B has merged — otherwise mark
//    these two assertions with the B4 dependency and move them into auth.test.ts.)
// 9. PATCH /api/settings {model:"gpt-6-astra"} as a free user → 403 code "forbidden",
//    message exactly "Add your own key to choose models.", and GET /api/settings still
//    reports the free model.
// 10. The same PATCH from a user with an OpenAI key → 200, as today.
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `signinProviders` order is fixed (`google`, then `github`) so the UI
  never reorders between renders. `initial` is `email.trim()[0].toUpperCase()`, falling back to
  `"?"` for an email that somehow starts with a non-letter.
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes/config.ts src/server/routes/settings.ts \
        src/server/routes/config-accounts.test.ts src/shared/types.ts
git commit -m "slicely-v3: the API says whether sign-in exists and what free credit runs on"
```

---

# Lane B — Sign in with Google or GitHub

Worktree `accounts/oauth`. Depends on A1's `findOrCreateAccount`, A2's `normalizeEmail` /
`isDisposableDomain`, A3's `countSignup`, and A5's `bindAccountToSession` — all frozen above.
Until lane A merges, stub those five in `src/server/oauth/__stub.ts` and delete it in B5.

## Task B1: The state cookie, PKCE, and a `return_to` that cannot leave the site

**Files:**
- Create: `src/server/oauth/state.ts`, `src/server/oauth/state.test.ts`

**Interfaces:**
- Consumes: `encryptSecret` / `decryptSecret` (`src/main/keyvault.ts`).
- Produces:
  ```ts
  export const OAUTH_COOKIE = "__Host-slicely_oauth";
  export const OAUTH_TTL_MS = 10 * 60_000;
  export interface OauthState {
    provider: string;
    state: string;      // 32 random bytes, base64url
    verifier: string;   // 64 random bytes, base64url — PKCE, unused by GitHub
    nonce: string;      // 16 random bytes, base64url
    returnTo: string;   // already passed through safeReturnTo
    exp: number;
  }
  export function pkceChallenge(verifier: string): string;   // base64url(sha256(verifier)), no padding
  export function startOauthState(res: Response, provider: string, returnTo: unknown): OauthState;
  export function readOauthState(req: Request): OauthState | undefined;
  export function clearOauthState(res: Response): void;
  export function safeReturnTo(raw: unknown): string;
  export function statesMatch(a: string, b: unknown): boolean;   // timingSafeEqual, length-safe
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/oauth/state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { resetKeyVaultForTests } from "../../main/keyvault";
import { pkceChallenge, safeReturnTo, statesMatch, OAUTH_COOKIE } from "./state";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

test("the PKCE challenge is base64url of the SHA-256 of the verifier, unpadded", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const want = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceChallenge(verifier), want);
  assert.ok(!pkceChallenge(verifier).includes("="));
  assert.ok(!/[+/]/.test(pkceChallenge(verifier)));
});

test("return_to can only ever be a path on this site", () => {
  const hostile = [
    "https://evil.example/steal",
    "//evil.example",
    "\\\\evil.example",
    "/\\evil.example",
    "http:/\\/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "%2f%2fevil.example",
    "/\t/evil.example",
  ];
  for (const raw of hostile) {
    assert.equal(safeReturnTo(raw), "/", raw);
  }
  assert.equal(safeReturnTo("/"), "/");
  assert.equal(safeReturnTo("/app?q=phone+stand#top"), "/app?q=phone+stand#top");
  assert.equal(safeReturnTo(undefined), "/");
  assert.equal(safeReturnTo(""), "/");
  assert.equal(safeReturnTo("/" + "a".repeat(600)), "/");
});

test("states are compared in constant time and a wrong length is simply false", () => {
  const a = randomBytes(32).toString("base64url");
  assert.equal(statesMatch(a, a), true);
  assert.equal(statesMatch(a, a.slice(0, -1)), false);
  assert.equal(statesMatch(a, undefined), false);
  assert.equal(statesMatch(a, 42), false);
  assert.equal(statesMatch(a, randomBytes(32).toString("base64url")), false);
});
```

Plus three tests driving a tiny Express app (`createServer` + `fetch`, the house pattern) so the
cookie is exercised end to end:

```
// 4. startOauthState sets exactly one Set-Cookie named __Host-slicely_oauth carrying
//    Path=/, HttpOnly, Secure, SameSite=Lax, Max-Age=600 — and the cookie VALUE contains
//    neither the raw state nor the raw verifier (it is encrypted, because the verifier is
//    a secret). Assert by checking the returned state.state is NOT a substring of the header.
// 5. readOauthState round-trips the object through a real request; a tampered cookie value,
//    a cookie encrypted under a different master key, and an expired `exp` all return
//    undefined rather than throwing.
// 6. clearOauthState emits Max-Age=0 for the same name with the same attributes.
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `safeReturnTo` is the whole open-redirect defence and is four lines:
reject non-string / >512 / control characters, then
`const u = new URL(raw, "http://placeholder.invalid"); if (u.origin !== "http://placeholder.invalid") return "/"; return u.pathname + u.search + u.hash;`
— the URL parser normalises every backslash, percent-encoding and scheme trick before the origin
comparison, which is why one comparison suffices. Document that in a comment; it is the kind of
line a future reader "simplifies" into a bug.

The cookie is **encrypted**, not signed, because the PKCE verifier lives inside it, and
**`SameSite=Lax`**, not `Strict`, because a `Strict` cookie is not sent on the top-level
cross-site GET that brings the user back from the provider. Both facts get a comment.

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/oauth/state.ts src/server/oauth/state.test.ts
git commit -m "slicely-v3: a sign-in carries a sealed, single-use note and can only come home"
```

## Task B2: Continue with Google

**Files:**
- Create: `src/server/oauth/index.ts`, `src/server/oauth/google.ts`, `src/server/oauth/providers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // oauth/index.ts
  export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;
  export interface OauthConfig {
    /** Injected in tests. Production passes nothing and the env is read. */
    providers?: OauthProvider[];
    http?: HttpFn;
  }
  export class OauthError extends Error {
    constructor(readonly code: "oauth_failed" | "email_unverified", message: string);
  }
  export interface OauthProvider {
    readonly id: "google" | "github";
    readonly label: string;                 // "Google" | "GitHub"
    /** True when the client id, the secret and SLICELY_PUBLIC_URL are all set. */
    configured(): boolean;
    /** The full authorize URL to 302 to. */
    authorizeUrl(state: OauthState): string;
    /** Exchange + profile read. MUST NOT persist or log any token. */
    profile(code: string, state: OauthState, http: HttpFn): Promise<RawProfile>;
  }
  export interface RawProfile {
    providerUserId: string;
    email: string;
    emailVerified: boolean;
    name?: string;
  }
  export function redirectUri(providerId: string): string;   // `${publicUrl}/auth/${id}/callback`
  export function configuredProviders(cfg?: OauthConfig): OauthProvider[];
  ```

- [ ] **Step 1: Write the failing tests** (`providers.test.ts`, Google half — the GitHub half
  lands in B3 in the same file):

```
// 1. configured(): false with no env; false with an id but no secret; false with both but no
//    SLICELY_PUBLIC_URL; true with all three.
// 2. authorizeUrl(state) — parse it and assert, field by field:
//      origin + pathname === "https://accounts.google.com/o/oauth2/v2/auth"
//      response_type=code, client_id=<env>, scope="openid email profile",
//      redirect_uri="https://app.test/auth/google/callback",
//      state=<state.state>, nonce=<state.nonce>,
//      code_challenge=pkceChallenge(state.verifier), code_challenge_method="S256",
//      prompt="select_account", access_type="online"
//    and that the URL contains neither the client SECRET nor the verifier.
// 3. profile() with an injected http that asserts the token request:
//      POST https://oauth2.googleapis.com/token
//      content-type application/x-www-form-urlencoded
//      body has grant_type=authorization_code, code, redirect_uri, client_id,
//      client_secret, code_verifier — and nothing else
//    responding { id_token: <a JWT we build with a plain base64url payload> }
//    → { providerUserId: "sub-123", email: "Jane@Gmail.com", emailVerified: true,
//        name: "Jane" }.
// 4. Claim checks, each its own case, each throwing OauthError("oauth_failed"):
//      wrong iss; wrong aud; exp in the past; nonce not equal to state.nonce;
//      a payload that is not JSON; a token with two segments instead of three.
// 5. email_verified false (and email_verified "false" as a string) → OauthError
//    with code "email_unverified".
// 6. A 400 from the token endpoint → OauthError("oauth_failed"), and the thrown message
//    does NOT contain the client secret or the raw upstream body.
// 7. No token is retained: after profile() resolves, a spy on the injected http records
//    exactly one call, and nothing was written under the workdir (readdirSync is unchanged).
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** The `id_token` **signature is deliberately not verified** — the token
came back in the body of our own server-to-server TLS request to Google's token endpoint,
authenticated with our client secret and our PKCE verifier, which OIDC Core §3.1.3.7 item 6
explicitly allows to stand in for signature validation. Write that reasoning into the file as a
comment, together with the five claims that **are** checked (`iss` in the two accepted spellings,
`aud`, `exp`, `nonce`, `email_verified`), so nobody later reads the missing JWKS fetch as an
oversight.

`decodeJwtPayload` is ten lines and takes no dependency: split on `.`, require three parts,
`Buffer.from(parts[1], "base64url")`, `JSON.parse`, and treat every failure as `oauth_failed`.

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/oauth/index.ts src/server/oauth/google.ts src/server/oauth/providers.test.ts
git commit -m "slicely-v3: continue with Google, and keep nothing but the verified address"
```

## Task B3: Continue with GitHub

**Files:**
- Create: `src/server/oauth/github.ts`
- Modify: `src/server/oauth/providers.test.ts`, `src/server/oauth/index.ts` (register it)

**Interfaces:** the same `OauthProvider`. GitHub OAuth Apps do not support PKCE, so
`authorizeUrl` sends `state` but no `code_challenge`, and `state.verifier` is simply unused —
one cookie shape, no special case, and a comment saying so.

- [ ] **Step 1: Write the failing tests** (added to `providers.test.ts`):

```
// 1. configured() gates on GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET + SLICELY_PUBLIC_URL.
// 2. authorizeUrl: origin+path "https://github.com/login/oauth/authorize";
//    client_id, redirect_uri "https://app.test/auth/github/callback",
//    scope "read:user user:email", state, allow_signup "true";
//    and NO code_challenge parameter at all.
// 3. profile() drives exactly three calls, in order, with an injected http:
//    a) POST https://github.com/login/oauth/access_token, Accept: application/json,
//       form body with client_id, client_secret, code, redirect_uri → {access_token:"gho_x"}
//    b) GET https://api.github.com/user with Authorization "Bearer gho_x",
//       Accept "application/vnd.github+json", X-GitHub-Api-Version "2022-11-28",
//       and a User-Agent that starts "slicely/" → {id: 4242, login:"jane", name:"Jane Doe"}
//    c) GET https://api.github.com/user/emails with the same headers →
//       [ {email:"alt@x.com",primary:false,verified:true},
//         {email:"jane@example.com",primary:true,verified:true} ]
//    → { providerUserId: "4242", email: "jane@example.com", emailVerified: true,
//        name: "Jane Doe" }.
// 4. The primary address is chosen even when a verified non-primary comes first in the array.
// 5. primary but NOT verified → OauthError("email_unverified") whose message tells the user
//    where to fix it (contains "github.com/settings/emails").
// 6. An empty emails array, and a 403 from /user/emails, both → OauthError("email_unverified")
//    and "oauth_failed" respectively.
// 7. A token response of { error: "bad_verification_code" } (GitHub answers 200 with an
//    error body) → OauthError("oauth_failed").
// 8. The access token appears in no thrown message and in no file under the workdir.
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `providerUserId` is `String(user.id)` — the numeric id, never the
  login, because a login can be changed and then belong to someone else. Note that in a comment.
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/oauth/github.ts src/server/oauth/index.ts src/server/oauth/providers.test.ts
git commit -m "slicely-v3: continue with GitHub, using the address GitHub has verified"
```

## Task B4: The two routes, `/api/me`, and signing out

**Files:**
- Create: `src/server/routes/auth.ts`, `src/server/routes/auth.test.ts`
- Modify: `src/server/index.ts` (mount `/auth` behind the **same** session middleware instance),
  `src/server/errors.ts` (extend the stable-codes doc comment)

**Interfaces:**
- Consumes: B1's state helpers, B2/B3's providers, A1's `findOrCreateAccount`, A2's
  `normalizeEmail` / `isDisposableDomain`, A3's `countSignup`, A5's `bindAccountToSession` /
  `unbindAccountFromSession`, A7's `AccountView`.
- Produces:
  ```ts
  export function createAuthRouter(cfg?: OauthConfig): Router;
  //  GET  /:provider/start     (mounted at /auth)
  //  GET  /:provider/callback  (mounted at /auth)
  export function createMeRouter(cfg?: OauthConfig): Router;
  //  GET  /me                  (mounted at /api)
  //  POST /auth/signout        (mounted at /api → POST /api/auth/signout)
  ```
  `createApp` changes, minimally:
  ```ts
  const sessionMw = sessionMiddleware(store, { mintPerHour: opts.limits?.mintPerHour });
  const api  = express.Router();  api.use(noStore());  api.use(sessionMw);  api.use(tier(LIMITS.api, …));
  const auth = express.Router();  auth.use(noStore()); auth.use(sessionMw); auth.use(tier(LIMITS.api, …));
  if (isHosted()) { auth.use(createAuthRouter(opts.oauth)); app.use("/auth", auth); }
  api.use(createMeRouter(opts.oauth));
  ```
  **One `sessionMiddleware` instance shared by both routers** — two instances would mean two
  per-IP mint budgets and would halve the cap's value. Say so in a comment.

- [ ] **Step 1: Write the failing tests** (`auth.test.ts`, with a **fake provider** injected
  through `createApp({ oauth: { providers: [fake], http: fakeHttp } })` so no test touches the
  network):

```
// The fake: id "google", label "Google", configured() → true,
//   authorizeUrl(s) → `https://idp.test/authorize?state=${s.state}`,
//   profile(code) → the RawProfile a table row asks for (or throws the OauthError it asks for).
//
//  1. GET /auth/google/start with no cookie → 302; Location is the fake's URL carrying the
//     state; TWO Set-Cookie headers (the minted session and __Host-slicely_oauth); and the
//     oauth cookie value contains neither the state nor a verifier in the clear.
//  2. GET /auth/google/start?return_to=https://evil.example → the callback later lands on "/".
//  3. GET /auth/bogus/start → 404. GET /auth/github/start with GitHub unconfigured → 404.
//  4. Desktop mode: GET /auth/google/start → 404 (the router is not mounted at all).
//  5. HAPPY PATH: start, then callback with the returned state and both cookies →
//     302 to "/", the oauth cookie cleared (Max-Age=0), and GET /api/me with the session
//     cookie → { signedIn: true, account: { email, initial: "J", balanceLabel: "$0.50",
//     grantedLabel: "$0.50", chatsToday: 0, chatsPerDay: 40, exhausted: false } }.
//  6. Tampered state → 302 to "/#auth_error=oauth_failed", nothing bound, /api/me signed out.
//  7. Missing oauth cookie → same.
//  8. Expired oauth cookie (exp in the past) → same.
//  9. emailVerified false → "/#auth_error=email_unverified", no account created
//     (the accounts directory has no by-id entry).
// 10. A disposable domain → "/#auth_error=email_blocked", no account created.
// 11. The fourth signup from one IP → "/#auth_error=signup_limited", no account created,
//     and the third one DID succeed.
// 12. A SECOND sign-in by the same profile → 302 to "/", granted nothing: balanceLabel is
//     whatever it was, and signups/<day>.json did NOT increment (only grants count).
// 13. A blocked account signing in → binds fine (so /api/me can explain), and POST /api/chat
//     is the thing that answers 403 email_blocked. Assert /api/me shows the account.
// 14. POST /api/auth/signout → 204; /api/me → { signedIn: false }; <session>/account.json
//     is gone; the BYO key and chats.json are still there.
// 15. POST /api/auth/signout with a cross-site Origin → 403 cross_origin (corsGuard, unchanged).
// 16. No response body anywhere in this file contains "client_secret", "gho_", "sk-",
//     "id_token" or "verifier" (one loop over every captured body).
// 17. The callback response body is EMPTY (302, no HTML) — nothing to XSS, nothing to cache.
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** The callback handler is one linear function and every exit is a 302:

```
const st = readOauthState(req); clearOauthState(res);
try {
  if (!st || st.provider !== req.params.provider) throw new OauthError("oauth_failed", …);
  if (!statesMatch(st.state, req.query.state))    throw new OauthError("oauth_failed", …);
  const raw = await provider.profile(String(req.query.code ?? ""), st, http);
  if (!raw.emailVerified) throw new OauthError("email_unverified", …);
  const n = normalizeEmail(raw.email);                       // EmailRejected → email_invalid
  if (isDisposableDomain(n.domain)) throw new EmailRejected("email_blocked");
  const first = !accountExistsFor(provider.id, raw.providerUserId, n.normalized);
  if (first && !countSignup(clientIp(req)).allowed) throw new WireError(429, …, "signup_limited");
  const { account } = findOrCreateAccount({…}, centsToMicros(getConfig().freeCreditCents));
  bindAccountToSession(req.session!, account.id);
  res.redirect(302, st.returnTo);
} catch (err) {
  logInternal(err);                                     // server-side only, never the URL
  res.redirect(302, `${st?.returnTo ?? "/"}#auth_error=${codeFor(err)}`);
}
```

`codeFor` maps `OauthError.code`, `EmailRejected.code` (`email_invalid` → `email_blocked`, since a
provider-supplied address we cannot parse is not the user's problem to fix by retyping) and
`WireError.code`, defaulting to `oauth_failed`. The counter is consumed **only for a genuinely new
account**, checked before the create so a refused signup leaves no record.

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes/auth.ts src/server/routes/auth.test.ts \
        src/server/index.ts src/server/errors.ts
git commit -m "slicely-v3: two buttons, one sealed round trip, and an account with fifty cents on it"
```

## Task B5: The waitlist

**Files:**
- Create: `src/main/accounts/waitlist.ts`, `src/server/routes/waitlist.ts`,
  `src/server/routes/waitlist.test.ts`
- Modify: `src/server/index.ts` (mount, `heavy` tier)
- Delete: `src/server/oauth/__stub.ts` (lane A has merged by now; if it has not, leave the stub
  and note it in the task report)

**Interfaces:**
```ts
// main/accounts/waitlist.ts
export interface WaitlistEntry { ts: number; email: string; name?: string; accountId?: string }
export function addToWaitlist(entry: WaitlistEntry): { added: boolean };  // dedupes on normalised email
export function resetWaitlistForTests(): void;
// server/routes/waitlist.ts
export function createWaitlistRouter(opts?: RouteLimitOptions): Router;   // POST /waitlist
```

- [ ] **Step 1: Write the failing tests**

```
// 1. POST /api/waitlist {email:"Jane.Doe+x@gmail.com", name:"Jane"} → 204, and
//    accounts/waitlist.ndjson has exactly one line whose JSON has ts, email (verbatim),
//    name, and no ip.
// 2. The same address again (and its normalised twin "janedoe@gmail.com") → 204 and still
//    exactly one line. 204 either way: a different status would let anyone enumerate the list.
// 3. A signed-in caller's line carries accountId; an anonymous caller's does not.
// 4. Nonsense ("jane", "", a 300-character local part, a non-string) → 400 with
//    { code: "email_invalid" } and no line written.
// 5. A 51st request from one session is refused by the heavy tier with 429 rate_limited.
// 6. name longer than 100 characters is truncated, not refused; a name containing a newline
//    is rejected (one entry per line is the file format).
// 7. Desktop mode → 404 (not mounted).
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Append-only, `\n`-terminated, `JSON.stringify` so a newline in any
  field is escaped anyway — and reject one in `name` regardless, because the file is meant to be
  readable with `wc -l`. Dedupe from an in-memory `Set` built by reading the file once at boot.
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/main/accounts/waitlist.ts src/server/routes/waitlist.ts \
        src/server/routes/waitlist.test.ts src/server/index.ts
git commit -m "slicely-v3: leave your email and we'll tell you when a paid plan opens"
```

---

# Lane C — The screens

Worktree `accounts/web`. Depends on the wire contract only (spec §10, restated in C1). Verify each
task with the `browser-automation` skill against `npm run serve`; a dev shim for unmerged endpoints
is fine locally and is **never committed**.

## Task C1: The client speaks the new contract

**Files:**
- Modify: `src/web/api.ts`, `src/web/onboarding.ts` (the `AppConfig` mirror only)
- Create: `src/web/account-copy.test.ts` — a plain `node:test` file (no DOM) asserting the copy
  table, because a sentence that disagrees with the server's sentence is a real bug

**Interfaces:**
```ts
// api.ts
export interface MeResponse { signedIn: boolean; account?: AccountView }
export async function me(): Promise<MeResponse>;          // GET /api/me, through ready()
export function onAccountChange(fn: (me: MeResponse) => void): void;
export function setAccount(next: MeResponse): void;       // one store, so pill and sheet agree
export function account(): MeResponse;
```
`CODE_COPY` gains all seven codes, with these exact sentences:
```
signin_required  "Sign in to start — you get free credit to try Slicely."
credit_exhausted "You've used your free credit. Add your own API key to keep going."
free_tier_paused "Free usage is busy today. Add your own API key to keep going, or come back tomorrow."
signup_limited   "Too many new accounts from your network today. Try again tomorrow, or use your own API key."
email_unverified "That account has no verified email address. Verify one with your provider, or try the other button."
email_blocked    "That email address can't be used here. Try another, or use your own API key."
oauth_failed     "That sign-in didn't complete. Try again."
```
`AppConfig` mirrors the three new `ConfigResponse` fields, with the `ASSUMED` fallback setting
`accountsEnabled: false` — when config is unreachable the safe guess is today's BYO-only product.

- [ ] **Step 1: Write the failing test** — `account-copy.test.ts`: every one of the seven codes
  returns a non-empty sentence from `codeMessage()`; none is longer than 160 characters; none
  contains "µ¢", a path, or the word "error"; and `codeMessage("credit_exhausted")` is byte-equal
  to the string the server sends (imported from a small shared constant so the two cannot drift —
  put the seven sentences in `src/shared/types.ts` as `export const ACCOUNT_CODE_COPY` and have
  both sides read it).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `me()` awaits `ready()` first, like every other call, and tolerates a
  404 (a server without the route yet) by returning `{ signedIn: false }`.
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: the client knows the words for every new answer`

## Task C2: Sign in to start

**Files:**
- Modify: `src/web/onboarding.ts`, `src/web/styles.css`
- Create: `src/web/account.ts` (the sign-in block lives here; the pill follows in C3)

**Interfaces:**
```ts
// account.ts
export function buildSigninBlock(onUseOwnKey: () => void): HTMLElement | undefined;
//  undefined when !config().accountsEnabled — the caller then renders today's key card alone
export function signinHref(provider: SigninProvider["id"]): string;
//  `/auth/${provider}/start?return_to=${encodeURIComponent(location.pathname + location.search)}`
export function readAuthErrorFromHash(): string | undefined;   // and clears it from the URL
```
`buildConnectCard()` in `onboarding.ts` becomes: sign-in block first when accounts are enabled,
then a `.link-btn` reading "or use your own API key" that reveals today's provider card in place.
When accounts are disabled the function is byte-for-byte what it is today.

Markup, per spec §9.1 — `.connect` / `.connect-title` / `.connect-lead`, then
`.signin-buttons > a.btn.primary` + `a.btn`, then the link, then the existing `#consent` line. The
provider buttons are **anchors, not fetches**: a top-level navigation is what the OAuth flow needs
and what the CSP allows. No third-party logo files, no external image requests.

- [ ] **Step 1: Implement**, then **Step 2: verify with `browser-automation`**: accounts on → the
  sign-in card renders with two buttons whose `href`s are `/auth/google/start?return_to=%2F` and
  the GitHub equivalent; the link reveals the key form; zero console errors; renders at 400px and
  1280px with no horizontal scroll; every rendered `font-size` computed on a text node is ≥ 13px
  (assert via `getComputedStyle` in the page). Accounts off → the card is identical to today's
  (screenshot-compare against a baseline capture taken before the change).
- [ ] **Step 3: Commit** — `slicely-v3: the first thing a visitor sees is two buttons and fifty cents`

## Task C3: The balance in the header

**Files:** `src/web/account.ts`, `src/web/index.html`, `src/web/app.ts`, `src/web/styles.css`

**Interfaces:**
```ts
export function initAccount(deps: { openAiSettings(): void; openWaitlist(): void }): {
  refresh(): Promise<void>;
};
export function renderAccountPill(): void;
```
`index.html` gains, inside `.title-right` immediately before `#settingsBtn`:
```html
<button class="pill" id="accountPill" aria-haspopup="menu" aria-expanded="false" hidden>
  <span class="mono" id="accountInitial">?</span>
  <span id="accountBalance">Sign in</span>
</button>
```
It is a `<button class="pill">` so the desktop title-bar's `no-drag` rule already covers it.
Under 480px `#accountBalance` is hidden (that breakpoint already hides `#slicerStatus` for space)
and the monogram alone remains. The menu uses the existing `menu()` from `ui.ts`, so roles, arrow
keys, Escape and focus return come for free. Items per spec §9.2.

- [ ] **Step 1: Implement.** `app.ts` boot order: after `await loadConfig()`, `await refresh()` on
  the account API, then `renderAccountPill()`; subscribe `onAccountChange(renderAccountPill)`.
- [ ] **Step 2: Verify with `browser-automation`**: signed out + accounts on → the pill reads
  "Sign in"; signed in → monogram + "$0.50"; Tab reaches the pill, Enter opens the menu, ArrowDown
  moves, Escape closes and focus returns to the pill (assert `document.activeElement.id`); at
  400px the balance span is not rendered and the header does not wrap to two lines; desktop mode →
  the pill stays `hidden`.
- [ ] **Step 3: Commit** — `slicely-v3: what's left of your credit, in the corner, always`

## Task C4: Credit states in the transcript

**Files:** `src/web/chat.ts`, `src/web/account.ts`, `src/web/styles.css`

**Behaviour:**
- `handleAgentEvent` learns `{ type: "credit" }` → `setAccount(...)` → the pill repaints. No fetch.
- The error path learns the new codes. `credit_exhausted` and `free_tier_paused` render the
  **two-button card** of spec §9.4 via `errorCard()`'s shape — "Add my own key" calls
  `deps.onConnect()` (which already opens Settings → AI focused), "Join the waitlist" calls
  `deps.openWaitlist()`. `signin_required` renders a card whose single button is "Sign in" and
  navigates to `signinHref("google")`… **no**: it must not pick a provider for the user. It renders
  the sign-in block from C2 inline instead, so both buttons are offered.
- `updateSendEnabled()`'s `canChat()` becomes "has a key **or** is signed in with credit". The
  `.composer-note` says "Free credit used up — add your own key to keep going." when signed in and
  exhausted, and keeps today's "Connect a key to chat" otherwise.
- On boot, `readAuthErrorFromHash()` → if present, one `toast(codeMessage(code), "error")` and the
  fragment is stripped from the URL with `history.replaceState`, so a reload does not repeat it.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify with `browser-automation`** against a stubbed SSE stream: a `credit` frame
  moves the header from "$0.50" to "$0.45"; a `credit_exhausted` error frame renders the card with
  both buttons and each button opens the right surface; `/#auth_error=email_unverified` on load
  shows the toast once and leaves a clean URL; zero console errors.
- [ ] **Step 3: Commit** — `slicely-v3: the transcript says when the credit runs out, and what to do`

## Task C5: Settings → Account

**Files:** `src/web/settings.ts`, `src/web/onboarding.ts`, `src/web/index.html`, `src/web/styles.css`

**Behaviour:** a new `<section class="group" id="accountGroup">` **above** `#aiGroup`, rendered by
`renderAccount()` from the `account()` store, with the five rows of spec §9.5. Settings → AI gains
one line above its provider rows: "Free credit runs on Sonnet 5 at medium effort. Add your own key
to choose models." — sourced from `config().freeTier` so it names whatever model is actually
configured, and hidden entirely when `freeTier` is null. The composer's model and effort
`.picker-trigger`s and the sheet's `#ssModel` / `#ssEffortRow` are hidden when the user has no key
of their own and is running on credit. Settings → Data's "Delete my data" body gains the sentence
from spec §1.5.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify with `browser-automation`**: signed in on credit → the Account section shows
  the email, "$0.42 left of $0.50", "6 of 40", "Sonnet 5, medium effort"; the model picker is
  absent from both the composer and the sheet; after connecting a key the pickers return and the
  Account section stays; signed out with accounts on → the section is hidden; desktop → hidden.
- [ ] **Step 3: Commit** — `slicely-v3: Settings shows who you are and what's left`

## Task C6: The "coming soon" sheet

**Files:** `src/web/ui.ts` (`SheetId` gains `"waitlist"`), `src/web/index.html`,
`src/web/account.ts`, `src/web/styles.css`, `src/web/app.ts`

**Interfaces:** `export type SheetId = "settings" | "chats" | "jobs" | "waitlist";` plus
`#waitlistSheet` with `role="dialog" aria-modal="true" aria-labelledby`, the two fields and one
button of spec §9.6. `openWaitlist()` prefills the email from `account()`, opens the sheet and
focuses the first empty field. Submit → `postJson("/api/waitlist", {email, name})` → replace the
form with "You're on the list. We'll email you once, when it opens."; a 400 paints the field-level
message from `codeMessage("email_invalid")`.

- [ ] **Step 1: Implement.** The sheet is registered in `app.ts`'s `SHEET_TRIGGERS` so
  `aria-expanded` bookkeeping, the scrim and the focus trap all come from the existing machinery.
- [ ] **Step 2: Verify with `browser-automation`**: the sheet opens from the account menu, from the
  Settings row and from the exhausted card; the email is prefilled when signed in; submitting
  shows the thank-you; Escape closes and returns focus to the trigger; Tab is trapped inside;
  renders at 400px.
- [ ] **Step 3: Commit** — `slicely-v3: a waitlist for the paid plan, in one small sheet`

---

# Lane D — Credit efficiency

Worktree `accounts/efficiency`. Depends on P1 only. This lane is what makes 50 cents worth
offering: with caching a turn costs 4.71¢, without it 7.65¢ (spec §4.3).

## Task D1: Both providers report what they used

**Files:**
- Modify: `src/main/agent/provider.ts`, `provider-anthropic.ts`, `provider-openai.ts`,
  `provider-anthropic.test.ts`, `provider-openai.test.ts`, `src/main/agent/agent.ts`

**Interfaces:**
```ts
// provider.ts — TurnUsage is imported from ../pricing, not redefined
import type { TurnUsage } from "../pricing";
export interface TurnResult {
  assistant: NeutralBlock[];
  toolCalls: ToolCall[];
  /** undefined when the provider reported nothing. A metered call with no usage is
   *  charged NOTHING and logged as an anomaly — never charged a guessed number. */
  usage?: TurnUsage;
}
export interface StreamRequest {
  /* …as today… */
  /** Stable per session, for OpenAI's prompt_cache_key routing. Never the session id itself. */
  cacheKey?: string;
}
```
Anthropic, in `fromAnthropicMessage(final)`:
```ts
usage: final.usage ? {
  inputTokens: final.usage.input_tokens ?? 0,              // already EXCLUDES cached
  cachedInputTokens: final.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
  outputTokens: final.usage.output_tokens ?? 0,
} : undefined
```
OpenAI, in `readTurn`, a new branch on `response.completed` **and** `response.incomplete` (the
latter because a `max_output_tokens` stop is a real, billable turn that today `break`s out):
```ts
const u = (event.response as { usage?: … })?.usage;
usage = u ? {
  inputTokens: Math.max(0, (u.input_tokens ?? 0) - (u.input_tokens_details?.cached_tokens ?? 0)),
  cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
  cacheWriteTokens: 0,        // OpenAI does not itemise writes — see pricing.ts's header
  outputTokens: u.output_tokens ?? 0,
} : undefined;
```
`agent.ts` gains nothing but the pass-through: `const result = await provider.stream(...)` already
holds it, and A6 is what consumes it.

- [ ] **Step 1: Write the failing tests**

```
// provider-anthropic.test.ts
// 1. fromAnthropicMessage on a Message whose usage is
//    { input_tokens: 400, cache_read_input_tokens: 6000,
//      cache_creation_input_tokens: 0, output_tokens: 250 }
//    → usage deep-equals { inputTokens: 400, cachedInputTokens: 6000,
//      cacheWriteTokens: 0, outputTokens: 250 }.
// 2. A Message with no usage at all → usage === undefined (not a zeroed object: the
//    difference is "nothing reported" vs "nothing used", and only one is chargeable).
//
// provider-openai.test.ts
// 3. readTurn over frames ending in a response.completed whose response.usage is
//    { input_tokens: 6400, input_tokens_details: { cached_tokens: 6000 },
//      output_tokens: 250 }
//    → { inputTokens: 400, cachedInputTokens: 6000, cacheWriteTokens: 0, outputTokens: 250 }.
// 4. response.incomplete with reason max_output_tokens STILL yields usage (today it breaks
//    out before anything is read) and still returns the partial assistant blocks.
// 5. cached_tokens greater than input_tokens (a shape we should never see) clamps
//    inputTokens to 0 rather than going negative.
// 6. A stream with no completed frame → usage undefined, and the turn still returns its
//    blocks (a usage read must never be able to fail a turn).
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: a provider says how many tokens that cost`

## Task D2: Anthropic caches the system prompt and the tools

**Files:** `src/main/agent/provider-anthropic.ts`, `provider-anthropic.test.ts`

**Interfaces:** no signature change. Inside `stream()`:
- `system` becomes `[{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]`.
- `toAnthropicTools` puts `cache_control: { type: "ephemeral" }` on the **last** tool only.

The render order is `tools → system → messages`, so those two breakpoints (of the four allowed)
cover the whole static prefix and nothing volatile sits inside it. Expect ~90% off the prefix on
every call after the first — the 4.71¢-vs-7.65¢ difference.

- [ ] **Step 1: Write the failing tests** (`buildAnthropicParams` is extracted from `stream()` as
  an exported pure function so the request can be asserted without a network call):

```
// 1. params.system is an ARRAY of one text block carrying cache_control ephemeral, and
//    params.system[0].text === req.system byte-for-byte.
// 2. Exactly ONE tool carries cache_control, and it is the LAST element of params.tools.
// 3. The total number of cache_control markers in the whole request is exactly 2
//    (the four-breakpoint ceiling is not a place to be sloppy).
// 4. Tool order is deterministic: two calls with the same ToolSpec[] produce
//    JSON.stringify-identical params.tools.
// 5. No message block carries cache_control — the volatile part must stay out of the prefix.
// 6. The prefix is byte-stable across turns: build params twice with DIFFERENT messages and
//    assert JSON.stringify(params.tools) and params.system[0].text are identical.
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: Anthropic bills the prompt and tools once, not twelve times`

## Task D3: OpenAI's prefix stops moving

**Files:** `src/main/agent/provider-openai.ts`, `provider-openai.test.ts`

OpenAI's automatic caching is a pure prefix match with no markers, so two things must hold and
today the second does not: `instructions` and the serialised `tools` must be byte-identical across
turns, and the `input` array must be **append-only**. `reasoningTurnIndex()` currently strips older
assistant turns' reasoning items as the conversation grows, which rewrites bytes in the middle of
the prefix and throws away every hit after that point.

**Interfaces:** `buildResponsesBody(req)` gains
`prompt_cache_key: req.cacheKey` (omitted when absent), and the reasoning-stripping is removed so
`toOpenAiInput` is a pure append. `agent.ts` passes
`cacheKey: sha256(currentSessionId()).digest("hex").slice(0, 32)` — a hash, not the id.

- [ ] **Step 1: Write the failing tests**

```
// 1. APPEND-ONLY, the invariant that matters and needs no network:
//    build input for a 3-message history, then for that history plus two more messages;
//    assert JSON.stringify(inputLong).startsWith(JSON.stringify(inputShort).slice(0, -1))
//    — i.e. the short serialisation is a prefix of the long one modulo the closing bracket.
//    Use a history that CONTAINS reasoning blocks in an older turn: that is the case that
//    fails today.
// 2. instructions and JSON.stringify(tools) are identical across two builds with different
//    messages, and neither contains a date, a uuid, a session id or a counter
//    (regex: /\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/).
// 3. prompt_cache_key is present when cacheKey is given, absent when it is not, is 32 hex
//    characters, and is NOT the session id (build with cacheKey derived from "abc" and assert
//    the body does not contain "abc").
// 4. store:false, include:["reasoning.encrypted_content"], stream:true and
//    stream_options.include_obfuscation:false are all still there (regression guard —
//    store:false is a privacy requirement, not a tuning knob).
// 5. Every reasoning item from every assistant turn is present in input, in order.
```

- [ ] **Step 2: Run, expect FAIL** (test 1 and 3).
- [ ] **Step 3: Implement.** Write a comment recording the trade-off: keeping every turn's
  `encrypted_content` grows the request, but a mutating prefix costs a full-price re-read of the
  entire conversation on every call, which is far worse. If a real smoke run (E2) shows OpenAI
  rejecting replayed older reasoning, the fallback is to restore stripping and accept the miss —
  note that in the comment so the next reader knows it was considered.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: the OpenAI request stops rewriting its own history`

## Task D4: A smaller thing to send — the prompt and the tool descriptions

**Files:**
- Create: `src/main/agent/prompt.ts`, `src/main/agent/prompt.test.ts`,
  `scripts/count-prompt-tokens.mjs`
- Modify: `src/main/agent/agent.ts` (import `SYSTEM_PROMPT` instead of defining it),
  `src/main/agent/tools.ts`, `src/main/agent/tools-v2.ts`, `package.json` (`"tokens"` script)

Today: a 13,511-byte system prompt and ~6,500 bytes of tool descriptions — ~20 KB resent on up to
12 calls per message. Target: the prompt under 7,000 bytes and the descriptions under 5,000.

**The floor is not zero.** `claude-sonnet-5` will not cache a prefix under **1,024 tokens**; trim
past that and caching silently switches off and the free tier gets *more* expensive. The test
therefore asserts a window, not a maximum.

**Interfaces:**
```ts
// prompt.ts
export const SYSTEM_PROMPT: string;
/** Deliberately crude: bytes/4. Exact counts need the API; this is a guard rail that runs
 *  offline in CI. `npm run tokens` prints the real figure using the owner's key. */
export function estimateTokens(text: string): number;
export function staticPrefixTokens(tools: ToolSpec[]): number;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/agent/prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./tools";
import { SYSTEM_PROMPT, estimateTokens, staticPrefixTokens } from "./prompt";

const CACHE_FLOOR = 1024;   // claude-sonnet-5 will not cache a shorter prefix
const CEILING     = 6000;   // our budget — see the spec's worked example

test("the static prefix is small enough to be cheap and big enough to be cacheable", () => {
  const n = staticPrefixTokens(TOOLS);
  assert.ok(n >= CACHE_FLOOR, `prefix is ${n} tokens — under ${CACHE_FLOOR} it will not cache at all`);
  assert.ok(n <= CEILING, `prefix is ${n} tokens — over budget, every call pays for it`);
});

test("the system prompt fits in 7 KB and the tool descriptions in 5 KB", () => {
  assert.ok(Buffer.byteLength(SYSTEM_PROMPT) <= 7_000, `prompt is ${Buffer.byteLength(SYSTEM_PROMPT)} bytes`);
  const descriptions = TOOLS.map((t) => t.description).join("");
  assert.ok(Buffer.byteLength(descriptions) <= 5_000, `descriptions are ${Buffer.byteLength(descriptions)} bytes`);
});

test("trimming did not throw away anything the product depends on", () => {
  // Each entry is a behaviour the prompt is the ONLY place that states. If a line here has
  // to change, that is a product decision, not a tidy-up.
  const required: Array<[string, RegExp]> = [
    ["find, slice, print — and not CAD",        /\bno CAD\b|do not (model|design)|never (model|design)/i],
    ["prints are never started unsupervised",   /arm(ed)?|never start(s)? a print|only .* asked/i],
    ["model licences must be respected",        /licen[cs]e/i],
    ["millimetres",                             /\bmm\b|millimet/i],
    ["ask before destructive printer actions",  /confirm|ask (first|before)/i],
  ];
  for (const [why, re] of required) {
    assert.ok(re.test(SYSTEM_PROMPT), `the prompt no longer says: ${why}`);
  }
});

test("nothing volatile is in the prompt, or caching never hits", () => {
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT), "no date");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(SYSTEM_PROMPT), "no uuid");
  assert.ok(!/\/Users\/|\/home\/|\/data\//.test(SYSTEM_PROMPT), "no absolute path");
});

test("every tool still has a description, and none is a one-word stub", () => {
  for (const t of TOOLS) {
    assert.ok(t.description.trim().length >= 20, `${t.name} lost its description`);
  }
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing, then the two size assertions).

- [ ] **Step 3: Implement.** Move the prompt verbatim into `prompt.ts` first and commit nothing —
  then trim in one pass. The trimming rules, in priority order: delete anything the model can see
  from the tool schemas (parameter lists, enumerations of values, re-statements of a tool's
  purpose); collapse worked examples to one line each; delete every "you are a helpful…"
  pleasantry and every instruction that only restates a default; keep every *rule* and every
  *refusal*. Tool descriptions: one sentence saying what the tool does and one clause saying when
  to reach for it; move parameter prose into the schema's own `description` fields where it
  belongs (those are counted too, so genuinely delete rather than move where you can).

`scripts/count-prompt-tokens.mjs`: `messages.countTokens` with the owner's key, printing the real
prefix token count and comparing it with `estimateTokens`, so the crude estimator can be
re-calibrated if it drifts more than 15%. Wire it as `"tokens": "node scripts/count-prompt-tokens.mjs"`.

- [ ] **Step 4: Run the FULL suite, expect PASS.** The prompt is behavioural, so also run the
  agent-loop and tool tests specifically and read the diff once more with the question "would a
  new user get a worse answer because of this line I deleted?".
- [ ] **Step 5: Commit** — `slicely-v3: say the same thing in half the words, every single turn`

## Task D5: A conversation that stops growing forever

**Files:**
- Create: `src/main/agent/history.ts`, `src/main/agent/history.test.ts`
- Modify: `src/main/agent/agent.ts`

**Interfaces:**
```ts
export interface CapOptions {
  maxTurns?: number;          // default getConfig().maxHistoryTurns (12)
  keepBodies?: number;        // default 2 — how many recent tool rounds keep full results
  maxResultChars?: number;    // default 2000 — per tool_result, for the rounds that are kept
}
/** Returns a NEW array. Never removes a block, so a tool_use/tool_result pair can never be
 *  orphaned — both providers answer an orphan with a 400. Old results are truncated, not
 *  dropped. */
export function capHistory(messages: NeutralMessage[], opts?: CapOptions): NeutralMessage[];
export const TRUNCATED_NOTE = "… (earlier result trimmed to save credit)";
```

- [ ] **Step 1: Write the failing tests**

```
// 1. A 40-message history with maxTurns 12 comes back with ≤ 24 messages, the LAST ones,
//    and the first surviving message has role "user" (a history that starts with an
//    assistant turn is a 400).
// 2. PAIRING: for every tool_use id in the result there is a tool_result with the same id,
//    and vice versa. Run this over a history built with 3 parallel tool calls per round.
// 3. Old tool_result bodies are truncated to ≤ maxResultChars and end with TRUNCATED_NOTE;
//    the tool_result BLOCK is still present with the same id.
// 4. The newest `keepBodies` rounds keep their bodies byte-for-byte.
// 5. A reasoning block is never truncated or reordered (its bytes are what make the next
//    turn legal).
// 6. capHistory is idempotent: capHistory(capHistory(h)) deep-equals capHistory(h) — the
//    truncation note must not be re-truncated into nonsense.
// 7. An empty history, and a history of one user message, come back unchanged.
// 8. The input array is not mutated (assert a deep clone of the input still matches).
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** Apply it in `agent.ts` where the
  `StreamRequest` is built — `messages: capHistory(this.history)` — so `this.history` itself stays
  complete for `exportHistory()` and the user's transcript is never lost. That distinction is the
  whole point and needs a comment.
- [ ] **Step 4: PASS.** **Step 5: Commit** — `slicely-v3: an old tool result doesn't get re-billed forever`

## Task D6: A cost line per call, and a budget that fails the build

**Files:**
- Create: `src/main/agent/cost-log.ts`, `src/main/agent/cost-budget.test.ts`
- Modify: `src/main/agent/agent.ts`

**Interfaces:**
```ts
export interface CostLine {
  model: string; usage: TurnUsage; micros: number; source: "user" | "free"; iteration: number;
}
/** One line to stderr. NEVER the prompt, the reply, the key, the email or the account id. */
export function logTurnCost(line: CostLine): void;
export const TURN_BUDGET_MICROS = 6_000_000;   // 6¢ — the ceiling for the spec's fixture
```
Format: `[cost] model=claude-sonnet-5 src=free it=2 in=1550 cacheRead=6000 cacheWrite=0 out=200 micros=524000`
— greppable, one line, no PII. Called from `agent.ts` after every provider call, whatever the
funding source, because the paid path's cost is exactly as interesting to the owner.

- [ ] **Step 1: Write the failing tests**

```
// cost-budget.test.ts
// 1. BUDGET: the spec §4.3 fixture (6,000-token prefix, four calls, 8,670 uncached input,
//    1,120 output) costs 4_714_000 µ¢ WITH caching, which is under TURN_BUDGET_MICROS.
// 2. THE SAME FIXTURE WITHOUT CACHING costs 7_654_000 µ¢, which is OVER the budget. This is
//    the assertion that matters: it fails if caching stops working, not merely if a price
//    changes, so it is a regression test for D2 and D3 and not just arithmetic.
// 3. Fifty cents buys at least 8 and at most 12 turns at the cached cost (the range the
//    owner signed off — if a price change moves it outside, someone must look).
// 4. logTurnCost writes exactly one line containing "micros=" and containing none of:
//    an sk- prefix, "@", "prompt", "Bearer", a 32-hex id. Capture by monkey-patching
//    process.stderr.write for the duration of the test.
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: every turn says what it cost, and a test says what it may cost`

## Task D7: Finding a model without spending credit

**Files:**
- Create: `src/server/routes/find.ts`, `src/server/routes/find.test.ts`
- Modify: `src/server/index.ts` (mount on the `heavy` tier), `src/web/chat.ts`, `src/web/api.ts`

The cheapest turn is the one that never happens. "find me a phone stand" needs the sourcing layer,
not a model.

**Interfaces:**
```ts
// routes/find.ts
export function createFindRouter(opts?: RouteLimitOptions): Router;   // POST /find
//  { query: string } → { models: ModelResult[], query: string }
//  400 when query is missing, empty, or over 200 characters.
//  Runs the SAME provider fan-out the find_models tool runs, through the existing facade —
//  no new sourcing code, no duplicated ranking.
// web/chat.ts
export function deterministicFind(text: string): string | undefined;
//  "find me a phone stand"  → "phone stand"
//  "search for a vase"      → "vase"
//  "find a phone stand and slice it for PETG" → undefined  (there is more to do than find)
//  "what should I print?"   → undefined
```

- [ ] **Step 1: Write the failing tests**

```
// find.test.ts (createApp + fetch, sourcing stubbed through the facade override)
// 1. POST /api/find {query:"phone stand"} → 200 with models[]; the stub sourcing was called
//    once with "phone stand"; NO account was charged (no accounts/usage file exists) and no
//    provider key was read (a spy on the provider factory records zero calls).
// 2. It works with NO key and NO account at all — this path is free to everyone, signed in
//    or not, which is the whole point.
// 3. Missing/empty/201-character query → 400.
// 4. The 11th request in a burst is refused by the heavy tier with rate_limited.
//
// A plain unit test for deterministicFind, with the eight phrasings above plus:
//    "find" alone → undefined (nothing to search for)
//    "FIND ME A VASE" → "vase" (case-insensitive)
//    "find me a phone stand." → "phone stand" (trailing punctuation trimmed)
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The client rule is conservative on purpose: a bare find/search phrase
  and nothing else. Anything with a second clause goes to the model, because guessing wrong and
  silently doing less is worse than spending a few cents. The rendered cards carry one line:
  "Found without using AI credit — ask a follow-up to bring Slicely in."
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Verify with `browser-automation`**: typing "find me a phone stand" renders cards
  and the network panel shows `POST /api/find` and **no** `POST /api/chat`; typing "find me a
  phone stand and slice it" shows `POST /api/chat`.
- [ ] **Step 6: Commit** — `slicely-v3: a plain search doesn't need to wake the model up`

---

# Lane E — Documentation, verification, merge

On the merged branch, after D → A → B → C.

## Task E1: The docs and the environment tell the truth

**Files:** `.env.example`, `README.md`, `docs/DEPLOY.md`, `src/server/LICENSING.md` (one line)

- [ ] **Step 1:** `.env.example` gains an "accounts and free credit" block covering
  `SLICELY_PUBLIC_URL`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`,
  `SLICELY_FREE_CREDIT_CENTS`, `SLICELY_FREE_MODEL`, `SLICELY_FREE_MAX_OUTPUT_TOKENS`,
  `SLICELY_FREE_CHATS_PER_DAY`, `SLICELY_SIGNUPS_PER_IP_PER_DAY`,
  `SLICELY_DAILY_SPEND_CAP_CENTS`, `SLICELY_MAX_HISTORY_TURNS` — each with one sentence saying
  what it bounds and what happens if it is unset. **Rewrite the `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` block**: in hosted mode these fund the free tier and are spendable only by a
  signed-in account with credit; on desktop they are the owner's own key. **Delete
  `SLICELY_ALLOW_OPERATOR_KEY` entirely** and say in one line why it is gone.
- [ ] **Step 2:** `README.md` — the config table gains every new variable; a new "Free credit"
  section explains the grant, the model, the caps and how to turn the whole thing off (leave the
  OAuth secrets unset); the "Bring your own key" section gains a sentence saying a key always wins
  over free credit and is never metered.
- [ ] **Step 3:** `docs/DEPLOY.md` — a numbered "Set up sign-in" section with the exact Google
  Cloud Console and GitHub Developer Settings steps, the two redirect URIs written out, the
  `fly secrets set` line, and a "What to check after deploy" addition: `/api/config` shows
  `accountsEnabled: true`, a real sign-in reaches the app with a `$0.50` pill, and
  `accounts/usage/<today>.ndjson` gains a line after one turn.
- [ ] **Step 4:** `grep -rhoE 'process\.env\.[A-Z_]+' src | sort -u` against the README table —
  reconcile, and confirm `SLICELY_ALLOW_OPERATOR_KEY` appears nowhere in `src/`, `README.md`,
  `.env.example` or `docs/`.
- [ ] **Step 5: Commit** — `slicely-v3: the docs explain free credit, and stop mentioning a flag that's gone`

## Task E2: Verification

**Files:** Create `src/server/accounts-e2e.test.ts`

- [ ] **Step 1: The end-to-end test, with a fake OAuth provider and a stub model provider.**
  One file, one narrative, no network:
  ```
  boot: createApp({ sessionStore, oauth: { providers: [fake] }, chatAgentFactory: stubAgent })
   1. GET /api/config → accountsEnabled true, freeTier.model "claude-sonnet-5", creditCents 50
   2. GET /api/me → { signedIn: false }
   3. POST /api/chat → 401 signin_required, content-type application/json
   4. GET /auth/google/start → 302 + two cookies
   5. GET /auth/google/callback → 302 "/" ; GET /api/me → balanceLabel "$0.50"
   6. POST /api/chat → 200 SSE; the stub reports the spec §4.3 usage; the stream ends with a
      `credit` frame reading "$0.45"; usage/<today>.ndjson has one line; spend/<today>.json
      reads 4_714_000
   7. Nine more turns → the eleventh POST /api/chat → 402 credit_exhausted
   8. PUT /api/key with a stub-validated key → 200; POST /api/chat → 200 and NO credit frame,
      no new ledger line: a paying user is never metered
   9. DELETE /api/key → POST /api/chat → 402 credit_exhausted again (back to the empty balance,
      not 401 — the account is still bound)
  10. POST /api/waitlist → 204, one line in waitlist.ndjson
  11. POST /api/auth/signout → 204; GET /api/me signed out; POST /api/chat → 401 signin_required
  12. Sign in again → the SAME account, still $0.00: a grant happens once
  13. DELETE /api/session → sign in again → a new record, still $0.00 (the email is retired)
  14. Over the whole run, no response body matched /sk-|client_secret|id_token|Bearer |verifier/
  ```
- [ ] **Step 2: The suite.** `npm run typecheck && npm run build && npm run test:only` — record the
  totals; the only failures allowed are the two pre-existing `planner-colour.test.ts` ones.
  `npm audit --omit=dev` → no high or critical (we added no dependency, so this should be
  unchanged).
- [ ] **Step 3: Browser, hosted, with the `browser-automation` skill**, `SLICELY_MASTER_KEY` and a
  fake-OAuth-enabled build: sign-in card → (stubbed) sign-in → header pill `$0.50` → a search that
  renders cards with **no** `/api/chat` call → a chat turn → the pill drops → exhaust the credit →
  the two-button card → waitlist sheet submits → Settings → Account reads correctly → connect a
  key → the model picker reappears → "Delete my data" → reload → signed out. Zero console errors.
  Screenshots at 400px and 1280px into the scratchpad. Assert no rendered text node computes to a
  `font-size` under 13px.
- [ ] **Step 4: Desktop regression.** `npm start`: the app loads, `/api/config` shows
  `mode: "desktop"` and `accountsEnabled: false`, no account pill, `GET /auth/google/start` is
  404, no `accounts/` directory exists under the userData path, and a chat turn works on the
  owner's key exactly as before.
- [ ] **Step 5: The real-key smoke plan** (owner runs this; it spends real money, so it is not in
  CI). Write it into `docs/DEPLOY.md` as a checklist so it is repeatable:
  1. `fly secrets set` the OAuth pair, `SLICELY_PUBLIC_URL` and `ANTHROPIC_API_KEY`; deploy.
  2. Sign in with a real Google account on a device that has never signed in. Expect a `$0.50`
     pill within two seconds of the redirect.
  3. Send **one** real turn: "find me a phone stand and slice it for PETG".
  4. `fly ssh console -C "tail -3 /data/accounts/usage/$(date -u +%F).ndjson"` — read the lines.
     **The check that matters: on the second and later lines, `cacheRead` must be non-zero.** A
     zero there means prompt caching is not hitting and every estimate in the spec is wrong.
  5. Compare the summed `micros` with the pill's movement, and with Anthropic's own console usage
     for the same minute. Three numbers, all agreeing to within the rounding the spec documents.
  6. Note the actual cost of that one turn in the task report. If it is above 6¢, the budget test's
     fixture is optimistic and the constant — or the trimming — needs revisiting before launch.
  7. Set `SLICELY_DAILY_SPEND_CAP_CENTS=1`, redeploy, try a turn: expect the "Free usage is busy
     today" card. Set it back.
- [ ] **Step 6: Commit** — `slicely-v3: an end-to-end proof that fifty cents behaves itself`

## Task E3: Merge

- [ ] Use `superpowers:finishing-a-development-branch`. Merge the four worktrees back in the order
  **D → A → B → C**, running `npm run typecheck && npm run test:only` after each — not only at the
  end. The one cross-lane conflict to expect is `agent.ts` and `routes/chat.ts` (D1/D5/D6 vs A6);
  resolve in favour of keeping both the usage thread and the funding gate, and re-run
  `chat-credit.test.ts` and `cost-budget.test.ts` together.
- [ ] `slicely-v3` → `main`. Keep the story; do not squash. Tag `v0.3.0`.
- [ ] **Owner follow-ups (not code):** create the two OAuth apps; set the five new Fly secrets;
  decide whether 50¢ / 500¢ / 3 / 40 are the right numbers after a week of real traffic; run the
  real-key smoke plan above; add a line to `site/privacy.html` covering what an account stores
  (email, normalised email, provider user id, balance, per-day chat count, hashed signup IP) and
  what it does not (no tokens, no raw IP, no prompt text) — the privacy page is a template and
  this is a factual addition its lawyer review should see.

---

## Self-review (done while writing)

- **Spec coverage.** §1 journeys → C2/C4/C5/C6 + E2's narrative; §2 data model → A1/A5; §2.3 email
  → A2; §2.4 ledger → A3; §3 OAuth → B1/B2/B3/B4; §3.4 `return_to` → B1; §4.1 prices → P1; §4.2
  usage → D1; §4.3 worked example → P1 and D6 (the same numbers asserted twice, deliberately, from
  both ends); §4.4 charging → A3; §5 abuse → A2/A3/B4; §6 free model → A4; §7.1 → D2; §7.2 → D3;
  §7.3 → D4; §7.4 → D5; §7.5 → A4 (`freeMaxOutputTokens`); §7.6 → D7; the cost log and budget →
  D6; §8 security → asserted inside B1/B2/B3/B4/A1 rather than in one place, so each claim is
  tested where it is made; §9 UI → C2–C6; §10 wire → A6/A7/B4/B5; §11 env → A1/A4/E1; §12 owner
  setup → E1/E3; §13 testing → every task plus E2.
- **Type consistency.** `TurnUsage` is declared once, in `pricing.ts` (P1), and imported by
  `provider.ts` (D1), `funding.ts` (A4) and `meter.ts` (A3) — it is never redeclared.
  `FundingContext` / `TurnFunding` (A4) are what `agent.ts` and `routes/chat.ts` consume in A6.
  `AccountView` (A7) is what `/api/me` returns in B4 and what `account()` stores in C1.
  `OauthConfig` (B2) is the `CreateAppOptions` field A6, A7 and B4 all take.
  `bindAccountToSession` / `unbindAccountFromSession` (A5) are exactly the names B4 calls.
  `findOrCreateAccount(profile, grantMicros)` (A1) is exactly the signature B4 calls.
  `centsToMicros` is the only place an env var in cents becomes µ¢.
- **Ordering hazards, all called out in the tasks that own them:** D1 before A6 (`agent.ts`);
  P1 before everything; A2 before B4 (email rules); A5 before B4 (`bindAccountToSession` and the
  minting routes); A4's catalogue entry before P1's completeness test can pass through
  `MODEL_CATALOG`; C1's shared `ACCOUNT_CODE_COPY` constant before C4 renders any of it.
- **Placeholders:** none. Every code step carries the code or the exact assertions with exact
  expected values. The only figures not derived in this document are the provider list prices,
  which are the owner's to edit in one table, and the two `{{…}}`-style legal placeholders that
  belong to the earlier plan.
