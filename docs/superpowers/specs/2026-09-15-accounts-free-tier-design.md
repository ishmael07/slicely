# Slicely accounts + free tier — design

**Date:** 2026-09-15
**Status:** Approved (owner's decisions of 2026-09-14, `.superpowers/sdd/2026-09-12-public-launch/accounts-decisions.md`)
**Branch:** `slicely-v3` (continues; commit prefix stays `slicely-v3:`)
**Supersedes:** the public-launch spec's "Free tier on owner's key: **None**" row and its
"Out of scope: Accounts/passwords/social login … a free tier" bullets. Everything else in
`docs/superpowers/specs/2026-09-12-public-launch-design.md` stands.

## Goal

A stranger opens `app.slicely.example`, signs in with Google or GitHub in two clicks, and gets
**50 cents of Slicely's own AI credit** — enough to find a model, slice it and send it to a
printer a couple of times over. When the credit runs out they either paste their own API key
(which unlocks every model and bills their own provider account) or join a waitlist for a paid
plan. The owner's exposure is bounded three ways: per account (the grant), per day (a global
spend cap), and per signup attempt (email normalisation, a disposable-domain list, a per-IP cap).

Nothing about the bring-your-own-key path changes. Nothing about the desktop app changes.

## Non-goals

- **Payments.** No card, no Stripe, no subscriptions. "Paid plan" is a waitlist form.
- **Passwords, magic links, email verification of our own.** Google and GitHub verify the email;
  we trust their verification flag and nothing else.
- **Refills, promo codes, referrals, top-ups.** One grant per person, ever.
- **Accounts on the desktop app.** The owner of the Mac is the only user; they already have the
  whole machine. `SLICELY_MODE=desktop` never mounts an auth route.
- **A second identity provider, org/team accounts, SSO, roles.** Two providers, one role.
- **A database.** JSON files under the existing volume, single process, same as everything else.
- **Storing provider avatars.** A monogram is drawn from the first letter of the email.
- **Sessions surviving across machines.** Still one Fly machine with one volume.

## Decisions (locked)

| Question | Decision | Why |
| --- | --- | --- |
| Sign-in | **Google OIDC + GitHub OAuth**, verified email only. No passwords, no magic links. | Two buttons cover almost everyone, cost nothing to run, and neither needs us to store a credential. |
| Free credit | **`SLICELY_FREE_CREDIT_CENTS`, default 50**, granted once per normalised email, never regranted. | Owner's call: ≈8–12 Sonnet 5 turns with caching, ≈2–3 full find→slice→send sessions. Raising it later is one Fly secret. |
| Free model | One, **server-chosen**: `claude-sonnet-5` when the owner's Anthropic key is set, else `gpt-5.6-luna`. Effort fixed to `medium`. | Haiku isn't good enough to represent the product (owner). One model means one cache namespace and one price row to reason about. |
| Model pickers on free credit | **Hidden**, replaced by one line: "Add your own key to choose models." | A picker you may not use is worse than no picker. |
| Metering unit | **Millionths of a cent (`µ¢`)**, integer arithmetic throughout. | `cost_µ¢ = tokens × centsPer1M` is exact integer maths. Integer *cents* would round every turn to zero and never charge. |
| Who is billed for tools | **Only model calls are metered.** Search, slicing, thumbnails, printer traffic are not. | The owner's sourcing keys were always env-only and always free to the visitor. |
| Owner keys in hosted mode | Reachable **only** through a metered, signed-in account. `SLICELY_ALLOW_OPERATOR_KEY` is retired for hosted mode. | Today that flag means every visitor's chat is billed to the owner with no limit. The free tier is the safe replacement, so the unsafe door closes. |
| Session ↔ account | The anonymous session cookie stays the workspace identity; signing in **binds** `accountId` to it. | Keeps one isolation model. No second key dimension in `session-context.ts`. |
| Storage | `<workdir>/accounts/` — one JSON per account, an index, an append-only usage ledger. | Matches how every other piece of state in Slicely is stored. No new dependency. |
| Paid plan | **Waitlist only**, `POST /api/waitlist` → `waitlist.ndjson`. | Nothing to build, nothing to promise. |

## Architecture overview

```
Browser ──┬── GET /auth/google/start  ─302─► accounts.google.com ─302─► /auth/google/callback
          │                                                                 │
          │                                          code+verifier+secret ──┘
          │                                          ↓ (server→server, TLS)
          │                                    id_token → email, sub
          │                                          ↓
          │                                  accounts/ (find or create)
          │                                          ↓
          └── POST /api/chat ──► funding resolver ──┬── user's own key  → not metered
                                                    └── owner's key     → metered per call
                                                           │
                                                           ├─ charge µ¢ → account file
                                                           ├─ append → usage/<day>.ndjson
                                                           └─ add → spend/<day>.json (kill switch)
```

Three new seams, and nothing else moves:

1. **`src/main/pricing.ts`** — one table, cents per 1M tokens, editable by the owner.
2. **`src/main/accounts/`** — the store, the meter, email normalisation, the abuse counters.
3. **`src/main/agent/funding.ts`** — the single function that answers "who pays for this turn,
   with which key, on which model, and what do I do with the usage numbers".

`POST /api/chat` asks the funding resolver one question before it writes a single SSE byte. The
agent loop asks it again before each provider call, and hands it the usage after each one.

---

## 1. User journeys

### 1.1 First run → sign in → chat on free credit

1. A visitor opens the app. `GET /api/config` mints the session cookie and reports
   `accountsEnabled: true`, `signinProviders: [google, github]`,
   `freeTier: { model: "claude-sonnet-5", modelLabel: "Sonnet 5", creditCents: 50 }`.
   `GET /api/me` reports `signedIn: false`.
2. The transcript empty state shows **one** card: "Sign in to start — free to try", the two
   provider buttons, and a plain link "or use your own API key".
3. They press **Continue with Google**. Top-level navigation to `/auth/google/start`. The server
   sets a short-lived encrypted cookie holding `{provider, state, verifier, nonce, returnTo}` and
   302s to Google.
4. Google returns them to `/auth/google/callback?code&state`. The server compares `state`,
   exchanges the code (with the PKCE verifier and the client secret) for an `id_token`, reads
   `sub`, `email`, `email_verified`, `name`, and **discards every token immediately**.
5. `email_verified` is true, the domain is not on the disposable list, the IP is under its daily
   signup cap, and the normalised email has never been granted credit → an account is created
   with `grantedMicros = 50_000_000`, and `session.accountId` is bound.
6. 302 back to `/` (the validated `return_to`). The header now shows a monogram pill reading
   **`$0.50`**. The composer is enabled. The model and effort pickers are gone; Settings → AI
   says "Free credit runs on Sonnet 5 at medium effort. Add your own key to choose models."
7. They type "phone stand, sturdy". The turn runs on the owner's Anthropic key against
   `claude-sonnet-5`, and each provider call inside the turn is charged. At the end of the turn a
   `credit` event updates the header pill to `$0.45`.

### 1.2 Exhausted → own key, or waitlist

1. The balance reaches zero mid-answer. The agent's next `guard()` throws, the stream emits an
   in-band error, and the transcript shows an **error card** (not a toast):
   > **You've used your free credit.**
   > Add your own API key to keep going — you're billed by Anthropic or OpenAI directly, usually
   > a few cents a session. Or join the waitlist and we'll tell you when a paid plan opens.
   > [ Add my own key ]   [ Join the waitlist ]
2. **Add my own key** opens Settings → AI with the first provider's key field focused — today's
   card, unchanged. Once a key is stored, that provider's models are unlocked, the pickers come
   back, and nothing is metered.
3. **Join the waitlist** opens the "Coming soon" sheet: the account's email prefilled, an optional
   name, one button. `POST /api/waitlist` → 204 → a thank-you state.
4. A later visit with an exhausted balance behaves the same way before the first call: the chat
   route answers `402 credit_exhausted` before any SSE header, and the composer note says
   "Free credit used up — add your own key to keep going."

### 1.3 BYO-only path (unchanged)

A visitor who never signs in can still search, paste links, upload, slice, preview and print —
exactly as today. Pressing send with no key and no account gets `401 signin_required` if accounts
are enabled, or the existing `409 no_key` if they are not. Pasting a key works from the sign-in
card's "or use your own API key" link without any account at all; that path is byte-for-byte
today's behaviour and is never metered.

### 1.4 Desktop (unchanged)

`SLICELY_MODE=desktop` mounts no `/auth` router, `GET /api/me` answers
`{ signedIn: false }` with `accountsEnabled: false` on `/api/config`, the header shows no account
pill, and `getUserApiKey()` keeps its owner-key fallback because the owner *is* the user. No
accounts directory is ever created.

### 1.5 Delete my data

"Delete my data" still destroys the session and its workspace, and now also deletes the account
record and its binding. The normalised email moves to a `retired` list, so the same person cannot
delete and re-sign-in for another 50 cents. The copy says so plainly:
"This also deletes your Slicely account. Free credit isn't granted twice, so signing in again
won't give you a new balance."

---

## 2. Data model

Everything lives under `<workdir>/accounts/`, outside every session directory — which means
`isInsideSessionWorkspace()` already refuses every agent-reachable path into it, and the file
sweeper never sees it.

```
<workdir>/accounts/
  index.json                     the two lookup maps + the retired list
  by-id/<accountId>.json         one account
  usage/<YYYY-MM-DD>.ndjson      append-only ledger, one line per provider call
  spend/<YYYY-MM-DD>.json        { "micros": N } — the global kill-switch counter
  signups/<YYYY-MM-DD>.json      { "<hashedIp>": count }
  waitlist.ndjson                append-only
```

### 2.1 `Account`

```ts
/** Money is in µ¢ — millionths of a cent. 1_000_000 µ¢ = 1¢ = $0.01.
 *  Integer throughout: `tokens × centsPer1M` is exactly the µ¢ cost. */
export interface Account {
  version: 1;
  id: string;                    // 16 random bytes, hex
  provider: "google" | "github";
  providerUserId: string;        // Google `sub`, GitHub numeric `id` — opaque, never displayed
  email: string;                 // as the provider gave it, for display
  normalizedEmail: string;       // the grant key — see §2.3
  name?: string;
  createdAt: number;
  lastSeenAt: number;
  grantedMicros: number;         // what was granted, once; never changes
  spentMicros: number;           // monotonic. balance = granted − spent, floored at 0
  chatDay: string;               // "YYYY-MM-DD" in UTC
  chatCount: number;             // turns started on this UTC day
  blocked?: true;                // set by hand by the owner; answers `email_blocked`
}
```

No IP, no access token, no refresh token, no avatar URL, no prompt text. Ever.

### 2.2 `index.json`

```ts
interface AccountIndex {
  version: 1;
  byProviderUser: Record<string, string>;  // "google:1078…" → accountId
  byEmail: Record<string, string>;         // normalizedEmail → accountId
  retired: string[];                       // normalizedEmails that had credit and deleted it
}
```

Loaded once at boot into memory, written atomically (temp sibling + `rename`) on every change —
the same pattern `userkey.ts` and `registry.ts` already use.

`byEmail` is deliberately *not* the identity: the same person signing in with Google and then
GitHub on the same verified address resolves to the **same** account (one grant), while
`byProviderUser` is what makes a repeat sign-in fast and stable if they later change their
address at the provider.

### 2.3 Email normalisation (the grant key)

```
1. trim, lowercase
2. split on the last "@"; reject if there is no local part or no dot in the domain
3. domain aliases:  googlemail.com → gmail.com
4. gmail.com only:  strip every "." from the local part; drop everything from the first "+"
5. every other domain: drop everything from the first "+" (widely honoured, harmless if not)
```

`user.name+slicely@googlemail.com` and `USERNAME@gmail.com` both normalise to
`username@gmail.com` and share one 50-cent grant.

### 2.4 The usage ledger

One line per **provider call** (not per turn — a turn is up to 12 calls):

```json
{"ts":1757923410123,"accountId":"9f2c…","model":"claude-sonnet-5","in":8670,"cacheRead":18000,"cacheWrite":6000,"out":1120,"micros":4714000}
```

Append-only, `\n`-terminated, opened with `a` so a crash truncates at most one line. It is the
owner's audit trail and the input to any future invoice; it holds no prompt, no email, no IP.

### 2.5 Session binding

`SessionRecord` gains one field:

```ts
accountId?: string;
```

Because session records live in an in-memory `Map`, the binding is **also** written to
`<session>/account.json` (`{ "version": 1, "accountId": "…" }`, mode 0600) and added to
`SESSION_PERSONAL_FILES` so "Delete my data" removes it. Two consequences the spec makes explicit:

- **A restart must not sign everyone out.** `SessionStore.lookup()` gains a rehydration step: a
  cookie whose HMAC verifies, whose id is 32 hex characters, and whose directory exists as a
  direct child of the sessions root, is *materialised* rather than replaced by a fresh session.
  The workspace, the stored BYO key and the account binding all survive a deploy. (Without this,
  every deploy would silently hand every visitor a new empty workspace — already true today, but
  accounts make it user-visible.)
- **Even if the binding is lost, credit is not.** Signing in again resolves `providerUserId` to
  the same account file, and the balance is exactly where it was. The grant is keyed on the
  email, never on the session.

---

## 3. OAuth flows

Both flows are **redirect flows**, never popups: `Cross-Origin-Opener-Policy: same-origin` (set
today by `securityHeaders()`) breaks `window.opener` messaging, and a top-level 302 needs no CSP
change at all — `form-action 'self'` only constrains form submissions and `connect-src 'self'`
only constrains `fetch`. Nothing in `CSP_STRING` moves.

### 3.1 Shared state cookie

`GET /auth/:provider/start?return_to=<path>`:

1. `provider` must be configured (client id **and** secret **and** `SLICELY_PUBLIC_URL` set), else
   404. Hosted mode only; the router is not mounted on desktop.
2. Generate `state` (32 random bytes, base64url), `verifier` (64 random bytes, base64url),
   `nonce` (16 random bytes, base64url).
3. Set `__Host-slicely_oauth` = `encryptSecret(JSON.stringify({p, state, verifier, nonce, returnTo, exp}))`
   with `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`.
   - **Encrypted, not merely signed**, because the PKCE verifier is inside it. `keyvault.ts`
     already provides AES-256-GCM under `SLICELY_MASTER_KEY`.
   - **`SameSite=Lax`, not `Strict`** — a `Strict` cookie is *not* sent on the top-level
     cross-site GET that brings the user back, so the callback would have nothing to compare.
     The same reasoning is why the session cookie is already `Lax`.
4. 302 to the provider's authorize URL.

`GET /auth/:provider/callback?code&state`:

1. Read and immediately clear the oauth cookie (`Max-Age=0`). Missing, undecryptable, or expired
   → `oauth_failed`.
2. `timingSafeEqual` the `state` bytes. Mismatch → `oauth_failed`. This is the CSRF defence for
   the callback; a GET callback cannot rely on `corsGuard`, which sees no `Origin` on a
   cross-site top-level navigation (and therefore passes, by design).
3. Exchange, read the profile, apply the abuse checks, bind the session.
4. Always answer **302** to the validated `return_to`. On success, plain. On failure,
   `return_to + "#auth_error=<code>"` — a fragment, so the code never reaches a server log or a
   `Referer`, and the client can turn it into a sentence. Codes: `oauth_failed`,
   `email_unverified`, `email_blocked`, `signup_limited`.

### 3.2 Google (OIDC, PKCE, S256)

| | |
|---|---|
| authorize | `https://accounts.google.com/o/oauth2/v2/auth` |
| token | `https://oauth2.googleapis.com/token` |
| params | `response_type=code`, `client_id`, `redirect_uri`, `scope=openid email profile`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, `prompt=select_account`, `access_type=online` |
| exchange | `POST` form-encoded: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier` |
| profile | the `id_token` payload: `sub`, `email`, `email_verified`, `name` |

**The `id_token` signature is not verified, deliberately.** OpenID Connect Core §3.1.3.7 item 6
allows exactly this for the authorization-code flow: the token arrived in the body of *our own*
server-to-server TLS request to Google's token endpoint, authenticated with our client secret and
our PKCE verifier. TLS server validation stands in for signature validation, and skipping it
removes a JWKS fetch, a cache and a key-rotation failure mode. What we **do** check, all of it:
`iss ∈ {https://accounts.google.com, accounts.google.com}`, `aud === client_id`, `exp > now`,
`nonce` equals the cookie's nonce, and `email_verified === true`.

### 3.3 GitHub (OAuth 2.0, `state` only)

| | |
|---|---|
| authorize | `https://github.com/login/oauth/authorize` |
| params | `client_id`, `redirect_uri`, `scope=read:user user:email`, `state`, `allow_signup=true` |
| exchange | `POST https://github.com/login/oauth/access_token` with `Accept: application/json` → `{ access_token }` |
| profile | `GET https://api.github.com/user` → `{ id, login, name }` |
| email | `GET https://api.github.com/user/emails` → the entry with `primary === true && verified === true` |

GitHub OAuth Apps do not offer PKCE, so the cookie's `verifier` is generated and unused for this
provider — one code path, one cookie shape, no special case. Both API calls carry
`Authorization: Bearer …`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28` and a `User-Agent: slicely/<version>`. The access token is
held in a local variable for the two calls and never written anywhere. No primary verified
address → `email_unverified`, with copy that tells the user what to fix:
"Your GitHub account has no verified primary email. Verify one at github.com/settings/emails, or
continue with Google."

### 3.4 `return_to`, and why open redirects cannot happen

```ts
export function safeReturnTo(raw: unknown): string;
```

- Not a non-empty string, or longer than 512 characters → `"/"`.
- Contains a control character (`\x00`–`\x1f`, `\x7f`) → `"/"`.
- Parsed as `new URL(raw, "http://placeholder.invalid")`; if `url.origin` is not the placeholder's
  origin → `"/"`. That single check kills `https://evil.example`, `//evil.example`,
  `/\evil.example`, `javascript:alert(1)`, `\/\/evil.example` and every backslash and
  percent-encoding variant, because the URL parser normalises them all before we look.
- The return value is rebuilt from the parsed URL as `pathname + search + hash`, so what we emit
  is never the attacker's bytes.

---

## 4. Metering

### 4.1 The price table

`src/main/pricing.ts` — **one table, integer cents per 1,000,000 tokens**, with a header comment
telling the owner they may edit it and where the numbers came from.

| model | input | cached read | cache write | output |
|---|---|---|---|---|
| `claude-sonnet-5` | 200 | 20 | 250 | 1000 |
| `claude-opus-4-8` | 500 | 50 | 625 | 2500 |
| `claude-sonnet-4-6` | 300 | 30 | 375 | 1500 |
| `claude-haiku-4-5` | 100 | 10 | 125 | 500 |
| `gpt-5.6-terra` | 200 | 20 | 250 | 1200 |
| `gpt-5.6-luna` | 20 | 2 | 25 | 120 |
| `gpt-6-astra` | 1000 | 100 | 1250 | 5000 |

Two rules the table's own tests enforce:

- **Every `MODEL_CATALOG` id has a row.** Adding a model without a price would otherwise meter it
  at zero, which is the one failure mode that costs the owner real money silently.
- **An unpriced model is never metered.** `priceFor()` throws; the funding resolver turns that
  into `503 free_tier_paused` and logs loudly. A misconfigured `SLICELY_FREE_MODEL` pauses the
  free tier instead of giving it away.

One honest imprecision, documented in the file: **OpenAI does not itemise cache writes.** Its
`usage.input_tokens` is the total and `input_tokens_details.cached_tokens` is the cached part, so
the 1.25× write premium on a first call is invisible to us and the meter under-reports it. The
bound is 25% of one prefix per cache epoch; the global daily cap contains it.

### 4.2 The cost function

```ts
export interface TurnUsage {
  inputTokens: number;        // uncached input
  cachedInputTokens: number;  // served from cache
  cacheWriteTokens: number;   // written to cache (always 0 on OpenAI — see above)
  outputTokens: number;
}

export function costMicros(model: string, u: TurnUsage): number;
//  = u.inputTokens       * price.input
//  + u.cachedInputTokens * price.cachedRead
//  + u.cacheWriteTokens  * price.cacheWrite
//  + u.outputTokens      * price.output
```

Because a price is *cents per 1M tokens* and a µ¢ is a millionth of a cent,
`tokens × centsPer1M` **is** the cost in µ¢ with no division and no float. That is the whole
reason the unit exists.

Usage comes from the providers:

- **Anthropic** — `stream.finalMessage().usage`: `input_tokens` (already excludes cached),
  `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`.
- **OpenAI** — the `response.completed` (or `response.incomplete`) event's `response.usage`:
  `input_tokens` minus `input_tokens_details.cached_tokens` for uncached, `cached_tokens` for
  cached, `output_tokens` (which already includes reasoning tokens).

`TurnResult` gains `usage?: TurnUsage`. A provider that reports nothing yields `undefined`, and a
metered call with no usage is charged **nothing and logged as an anomaly** — failing open here is
the right way round, because the alternative is charging a user for a number we invented.

### 4.3 Worked example — one "find me a phone stand" turn on `claude-sonnet-5`

A turn is one user message resolved in four provider calls: three tool rounds (search, model
details, slice) and a final answer. The cached prefix is the system prompt plus the tools block,
≈6,000 tokens after the trimming in §7. The message array is not cached and is re-billed in full
on every call.

| call | cache write | cache read | uncached input | output |
|---|---|---|---|---|
| 1 — search | 6,000 | — | 400 | 250 |
| 2 — details | — | 6,000 | 1,550 | 200 |
| 3 — slice | — | 6,000 | 2,950 | 220 |
| 4 — answer | — | 6,000 | 3,770 | 450 |
| **total** | **6,000** | **18,000** | **8,670** | **1,120** |

```
cache write   6,000 × 250  = 1,500,000 µ¢
cache read   18,000 ×  20  =   360,000 µ¢
uncached      8,670 × 200  = 1,734,000 µ¢
output        1,120 × 1000 = 1,120,000 µ¢
                             ─────────
                             4,714,000 µ¢  = 4.71¢
```

**50 cents buys ≈10.6 turns like this** — the 8–12 the owner signed off. Without prompt caching
the same turn costs `(6,000 × 4 + 8,670) × 200 + 1,120,000 = 7,654,000 µ¢ = 7.65¢`, or ≈6.5
turns. **Caching is what makes 50 cents feel like a real trial**, which is why §7 is a
first-class workstream and not a nice-to-have.

For comparison, the same turn on `gpt-5.6-luna` (if only the owner's OpenAI key is set) costs
≈0.49¢ — about 100 turns on the same 50 cents. The free tier is deliberately cheaper when the
cheaper provider is the one configured.

### 4.4 Charging

Charges happen **per provider call, immediately**, not per turn. A 12-iteration tool loop on an
empty balance would otherwise overspend twelvefold before anyone noticed.

```ts
await withAccountLock(accountId, async () => {
  account.spentMicros += micros;
  account.lastSeenAt = Date.now();
  await writeAccount(account);           // temp + rename
  await appendLedger(day, line);         // append-only
  await addDailySpend(day, micros);      // temp + rename
});
```

`withAccountLock` is a promise chain per account id — a single process with concurrent async
work still needs it, or two tabs on one account lose a charge in a read-modify-write race. A test
fires 20 concurrent 1,000 µ¢ charges and asserts `spentMicros === 20_000` exactly.

Balance is `max(0, grantedMicros − spentMicros)`. It can go slightly negative internally — the
last call of a turn is charged after it has already happened — and the floor is applied on
display and on the next `guard()`. Overshoot is bounded by one call's `max_output_tokens`
(§7.5: 4,000 output tokens ≈ 4¢ worst case, once, at the very end of a balance).

---

## 5. Abuse controls

| Control | Default | Mechanism | Wire code |
|---|---|---|---|
| One grant per person | — | `index.byEmail` + `index.retired`, keyed on the normalised email | — (silently no new grant) |
| Verified email only | — | Google `email_verified`, GitHub primary+verified | `email_unverified` |
| No disposable domains | — | a bundled list of ~1,500 domains, committed, no network, no runtime dep | `email_blocked` |
| Signups per IP per day | `SLICELY_SIGNUPS_PER_IP_PER_DAY=3` | `signups/<day>.json`, keyed on `sha256(secret ‖ ip)` | `signup_limited` |
| Global daily spend | `SLICELY_DAILY_SPEND_CAP_CENTS=500` | `spend/<day>.json` vs the cap, checked before every metered turn | `free_tier_paused` |
| Chats per account per day | `SLICELY_FREE_CHATS_PER_DAY=40` | `chatDay`/`chatCount` on the account | `rate_limited` |
| Per-session burst | unchanged | the existing `chat` tier, 6 burst / 1 per 20s | `rate_limited` |
| Per-account burst | unchanged tiers | the chat limiter's `keyFn` returns `acct:<id>` when signed in, so many tabs share one bucket | `rate_limited` |
| Manual block | — | `"blocked": true` in the account JSON, by hand | `email_blocked` |

The signup IP counter stores a **salted hash**, never the address. The privacy policy already
says server logs keep IPs for 14 days; an accounts file holding raw addresses indefinitely would
contradict it. The salt is the existing cookie-signing secret, so the hashes are useless off this
machine and rotate if it is rotated.

The disposable list is generated once by `scripts/gen-disposable-domains.mjs` from the public
`disposable-email-domains` dataset and **committed as a TypeScript array**. No runtime
dependency, no boot-time fetch, no surprise when the upstream repo moves. Tests: `mailinator.com`
and `10minutemail.com` blocked; `gmail.com`, `outlook.com`, a university domain, and a custom
company domain allowed.

---

## 6. The free-tier model policy

```
if SLICELY_FREE_MODEL is set:
    it must be in MODEL_CATALOG, have a price row, and its provider's owner key must be set
    → use it; otherwise log the misconfiguration and disable the free tier
else if ANTHROPIC_API_KEY is set → claude-sonnet-5   (added to MODEL_CATALOG by this work)
else if OPENAI_API_KEY   is set → gpt-5.6-luna
else                            → the free tier is off
```

Effort is always `"medium"`. `max_output_tokens` is `SLICELY_FREE_MAX_OUTPUT_TOKENS` (default
4,000) instead of the provider's 16,000/32,000.

`accountsEnabled` on `/api/config` is the conjunction of: hosted mode, at least one OAuth
provider fully configured (id, secret, and `SLICELY_PUBLIC_URL`), **and** a usable free model. If
any leg is missing the sign-in buttons do not render and the app is exactly today's BYO-only
product — which is precisely the fallback the owner asked for.

**The funding resolver's model wins over the session's setting.** A user who stored
`gpt-6-astra` while they had an OpenAI key, then removed it, runs on the free model rather than
on a model they can no longer pay for. `PATCH /api/settings` refuses a model change for a
credit-funded user with `403 forbidden` and the message "Add your own key to choose models." —
the same sentence the UI shows, so the two can never disagree.

---

## 7. Credit efficiency

The free tier is only credible if a turn is cheap. Six changes, each independently testable:

1. **Anthropic prompt caching.** `system` becomes a one-element block array carrying
   `cache_control: { type: "ephemeral" }`; the **last** tool in the array carries one too. The
   render order is `tools → system → messages`, so two breakpoints (of the four allowed) cover
   the entire static prefix. Expected effect: ~90% off the prefix on every call after the first,
   which is the 4.71¢-vs-7.65¢ difference in §4.3. Verified by `usage.cache_read_input_tokens`
   being non-zero on call 2 of a real smoke run — a zero there means a silent invalidator.
2. **Byte-stable prefix for OpenAI.** OpenAI's automatic caching is a pure prefix match with no
   markers, so `instructions` and the serialised `tools` array must be byte-identical across
   turns, and the `input` array must be **append-only**. Today it is not: older assistant turns'
   reasoning items are stripped as the conversation grows, which rewrites bytes in the middle of
   the prefix and throws away every cache hit after that point. The fix is to stop stripping, and
   the invariant is testable without a network call: turn *N*'s serialised `input` must *start
   with* turn *N−1*'s. A `prompt_cache_key` of `sha256(sessionId).slice(0,32)` improves routing to
   the machine that holds the entry.
3. **A smaller static prefix.** The system prompt is 13.5 KB and the tool descriptions another
   6.5 KB — ~20 KB resent on up to 12 calls per message. Target: the prompt under 7 KB and the
   descriptions under 5 KB. The floor is not zero: `claude-sonnet-5` **will not cache a prefix
   under 1,024 tokens**, so over-trimming would silently switch caching off and make things
   worse. The test asserts the estimated prefix lands in `[1024, 6000]` tokens, and a second test
   asserts a checklist of load-bearing sentences survived (scope boundary, "never start a print
   unless the user armed it", licence compliance, units in millimetres).
4. **History capping.** `capHistory()` keeps the last 12 message pairs verbatim and truncates
   the *bodies* of older `tool_result` blocks to a one-line stub. It never removes a block, so a
   `tool_use`/`tool_result` pair can never be orphaned — which both providers answer with a 400.
5. **A lower output ceiling on free credit.** Output is the most expensive token there is
   (1000 cents/1M on Sonnet 5, five times input). 4,000 instead of 16,000 caps one call's worst
   case at 4¢ and, in practice, changes nothing about the answers Slicely gives.
6. **Skip the model when the answer is deterministic.** "find me a phone stand" does not need a
   model at all — it needs the sourcing layer. A `POST /api/find` route runs the same providers
   the `find_models` tool runs, and the composer routes a bare find/search phrase to it, rendering
   cards with one honest line: "Found without using AI credit — ask a follow-up to bring Slicely
   in." The cheapest turn is the one that never happens.

And one measurement so none of this silently regresses: **a per-turn cost log** (one line per
call, no prompt text) and **a budget test** asserting that the §4.3 fixture stays under 6¢ *and*
that the same fixture without caching exceeds it — so the test fails if caching stops working,
not merely if prices change.

---

## 8. Security notes

- **Secrets never leave the server.** No response body, log line, error string, ledger entry or
  account file ever contains the owner's API keys, a user's API key, an OAuth client secret, an
  access token, an `id_token`, or the PKCE verifier. `/api/me` carries an email, a monogram, two
  integers and two pre-formatted strings.
- **Provider tokens are not stored.** Google's `access_token` is discarded unread; its `id_token`
  is parsed into four fields and dropped. GitHub's `access_token` lives in one local variable
  across two HTTPS calls and is never written to disk or logged. Nothing is refreshable, so
  nothing can be stolen later.
- **The oauth cookie is encrypted, single-use, and short-lived.** AES-256-GCM under
  `SLICELY_MASTER_KEY`, 10 minutes, cleared on the callback whatever the outcome.
- **CSRF.** The callback is defended by the state cookie compared with `timingSafeEqual` — it
  cannot rely on `corsGuard`, which by design passes a request with no `Origin`, and a
  provider-initiated top-level navigation has none. `POST /api/auth/signout` and
  `POST /api/waitlist` are defended the ordinary way: `corsGuard` plus the `SameSite=Lax` session
  cookie. `GET /auth/:provider/start` changes nothing but a cookie, so a cross-site trigger only
  ever begins a sign-in the user then has to complete at the provider.
- **No open redirect.** §3.4. The single origin comparison after URL parsing is the whole
  defence, and it is tested against nine hostile inputs.
- **Redirect URIs are fixed.** Built from `SLICELY_PUBLIC_URL`, never from the `Host` header, so a
  spoofed `Host` cannot move the callback. Both providers also pin them server-side.
- **The accounts directory is unreachable from the agent.** It sits beside `sessions/`, not
  inside one, and `isInsideSessionWorkspace()` already confines every tool path to the session
  directory. A hosted `resolvePath` cannot name it.
- **No path leaks.** Every new route answers through `sendError`, so `stripPaths` runs on the way
  out, as it does everywhere else.
- **Enumeration.** `POST /api/waitlist` answers 204 whether or not the address is new. A failed
  sign-in returns a stable code, never "no such account".
- **Blast radius of a stolen session cookie is unchanged**: one workspace, one balance, no way to
  read the account's provider identity beyond the email the user already knows.

---

## 9. The UI

Wireframe-level, in the existing visual language (`.pill`, `.icon-btn`, `.connect`, `.btn`,
`.error-card`, sheets). **No small text**: every string below renders at `var(--fs)` (14px) or,
at the quietest, `var(--fs-sm)` (13px). Quieter means dimmer, never smaller — the type scale in
`styles.css` has exactly three sizes and 13px is the floor.

### 9.1 First-run card (transcript empty state)

```
┌───────────────────────────────────────────────────────────┐
│  Sign in to start — free to try                           │  ← .connect-title
│                                                           │
│  You get 50 cents of Slicely's AI credit, enough to find   │  ← .connect-lead
│  a model, slice it and send it to a printer a couple of    │
│  times. No card, no trial timer.                          │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            Continue with Google                     │  │  ← .btn.primary, full width
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            Continue with GitHub                     │  │  ← .btn, full width
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  or use your own API key                                  │  ← .link-btn; reveals today's card
│                                                           │
│  By continuing you agree to the Terms and Privacy Policy. │  ← the existing #consent line
└───────────────────────────────────────────────────────────┘
```

The provider buttons are plain text with the `◆`-family look of the rest of the app — no
third-party logo files, no external image requests, no CSP exception. Pressing one is a top-level
navigation to `/auth/<id>/start?return_to=/`, not a `fetch`.

When accounts are disabled the card is exactly today's key card, and the sign-in block does not
render at all.

### 9.2 Header

`.title-right` gains `<button class="pill" id="accountPill">` before `#settingsBtn`:

- Signed in: a filled circle with the email's first letter, then the balance — `( J ) $0.42`.
- Signed out, accounts enabled: `Sign in`.
- Under 480px only the monogram shows (the balance span is hidden), because that row already
  hides `#slicerStatus` for space. It is a `<button class="pill">`, so the desktop title-bar drag
  region keeps working.

Clicking opens the existing `menu()` (real `role="menu"`, arrow keys, Escape, focus return):

```
  jane@example.com                (a disabled label row)
  $0.42 left of your free credit
  ───────────────────────────────
  Add your own key…               → Settings → AI, first field focused
  Paid plans — coming soon        → the waitlist sheet
  Sign out
```

### 9.3 Composer, while on free credit

The model and effort `.picker-trigger`s are hidden. The `.composer-note` line, which today says
"Connect a key to chat", says nothing while there is credit; when the balance is empty it says
"Free credit used up — add your own key to keep going." with the existing inline Connect link.

### 9.4 Credit-exhausted card (in the transcript)

```
┌───────────────────────────────────────────────────────────┐
│  You've used your free credit.                            │
│                                                           │
│  Add your own API key to keep going — you're billed by     │
│  Anthropic or OpenAI directly, usually a few cents a      │
│  session. Or join the waitlist and we'll tell you when a  │
│  paid plan opens.                                         │
│                                                           │
│  [ Add my own key ]   [ Join the waitlist ]               │
└───────────────────────────────────────────────────────────┘
```

Rendered with `errorCard()`'s shape, so it matches every other failure in the transcript. The
`free_tier_paused` variant reads: **"Free usage is busy today."** / "Slicely's shared credit for
today is used up. Add your own API key to keep going, or come back tomorrow."

### 9.5 Settings → Account (a new section, above AI)

```
  Account
  Who you are, and what's left of your free credit.

  Signed in as            jane@example.com          [ Sign out ]
  Free credit             $0.42 left of $0.50
  Chats today             6 of 40
  Running on              Sonnet 5, medium effort
  Paid plans              Coming soon               [ Join the waitlist ]
```

Settings → **AI** keeps today's rows (a key row per provider, connect/replace/disconnect) and
gains one line above them: "Free credit runs on Sonnet 5 at medium effort. Add your own key to
choose models." Settings → **Data** keeps "Delete my data" with the extra sentence from §1.5.

### 9.6 "Coming soon" sheet

A fourth sheet (`#waitlistSheet`, `SheetId` gains `"waitlist"`), reachable from the account menu,
the Settings row and the exhausted card:

```
  Paid plans — coming soon                                [×]

  We're building a paid plan with a bigger budget and every
  model. Leave your email and we'll tell you when it opens.
  We won't use it for anything else.

  Email   [ jane@example.com                    ]
  Name    [ optional                            ]

  [ Add me to the list ]
```

After 204: the form is replaced by "You're on the list. We'll email you once, when it opens."

---

## 10. Wire contract

### 10.1 New routes

| Route | Mode | Behaviour |
|---|---|---|
| `GET /auth/:provider/start?return_to=` | hosted | 302 to the provider; sets `__Host-slicely_oauth`. 404 if the provider is unknown or unconfigured. |
| `GET /auth/:provider/callback?code&state` | hosted | 302 to the validated `return_to`, or `return_to#auth_error=<code>`. Never a body. |
| `POST /api/auth/signout` | hosted | 204. Unbinds `accountId` from the session and deletes `<session>/account.json`. The workspace, chats and any BYO key stay. |
| `GET /api/me` | both | `{ signedIn: boolean, account?: AccountView }` |
| `POST /api/waitlist` | hosted | 204 (always, for a well-formed address). 400 `email_invalid`. `heavy` tier. |
| `POST /api/find` | both | `{ query: string }` → `{ models: ModelResult[] }`. The deterministic search path; never touches a model. `heavy` tier. |

Both `/auth` paths are added to `MINTING_ROUTES`, because a visitor may land on a sign-in link
before anything has minted them a session. The `/auth` router shares **the same
`sessionMiddleware` handler instance** as `/api` — a second instance would mean a second per-IP
mint budget and would halve the value of the cap.

### 10.2 `AccountView`

```ts
export interface AccountView {
  email: string;
  name?: string;
  initial: string;         // one uppercase letter, for the monogram
  balanceMicros: number;
  balanceLabel: string;    // "$0.42" — formatted once, on the server
  grantedMicros: number;
  grantedLabel: string;    // "$0.50"
  chatsToday: number;
  chatsPerDay: number;
  exhausted: boolean;
}
```

### 10.3 `/api/config` additions

```ts
interface ConfigResponse {
  /* …every field it has today, unchanged… */
  accountsEnabled: boolean;
  signinProviders: Array<{ id: "google" | "github"; label: string }>;
  freeTier: {
    model: string;          // "claude-sonnet-5"
    modelLabel: string;     // "Sonnet 5"
    effort: "medium";
    creditCents: number;    // 50
  } | null;
}
```

Per-deploy facts only, so the boot call stays the boot call. Per-account facts live on
`/api/me`, which the client calls once after boot and again whenever the balance may have moved.

### 10.4 `/api/chat` changes

The pre-flight checks run **before any SSE header**, in this order, and each answers plain JSON:

| Condition | Status | Code |
|---|---|---|
| empty message | 400 | — |
| session already streaming | 409 | `busy` |
| accounts enabled, no own key for the active provider, not signed in | 401 | `signin_required` |
| the account is blocked | 403 | `email_blocked` |
| the global daily cap is spent | 503 | `free_tier_paused` |
| the account's daily chat cap is spent | 429 | `rate_limited` (+ `Retry-After` to the next UTC midnight) |
| the balance is zero | 402 | `credit_exhausted` |
| accounts disabled (or desktop) and no key | 409 | `no_key` (today's behaviour) |

Mid-stream, a balance that runs out during a tool loop arrives as the existing in-band error
frame, `{ type: "error", message, code: "credit_exhausted" }`, followed by `done`.

One new `AgentEvent` variant, emitted at the end of every metered turn so the header pill does
not need to poll:

```ts
| { type: "credit"; balanceMicros: number; balanceLabel: string; exhausted: boolean }
```

### 10.5 New stable codes

`signin_required` · `credit_exhausted` · `free_tier_paused` · `signup_limited` ·
`email_unverified` · `email_blocked` · `oauth_failed`

All seven get a sentence in `CODE_COPY` (`src/web/api.ts`) so the client's copy and the server's
copy cannot drift. `email_invalid` is a 400 on the waitlist route only and is not a chat code.

---

## 11. Environment

New variables, all read fresh (no caching) so a Fly secret change takes effect on restart only:

| Variable | Default | What it does |
|---|---|---|
| `SLICELY_PUBLIC_URL` | — | The app's own origin, e.g. `https://app.slicely.example`. **Required for OAuth**; redirect URIs are built from it and never from the `Host` header. |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client. Both halves required, or Google is not offered. |
| `GOOGLE_CLIENT_SECRET` | — | |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App. Both halves required, or GitHub is not offered. |
| `GITHUB_CLIENT_SECRET` | — | |
| `ANTHROPIC_API_KEY` | — | **New meaning in hosted mode:** funds the free tier, spendable only by a signed-in account with credit. |
| `OPENAI_API_KEY` | — | Likewise. |
| `SLICELY_FREE_CREDIT_CENTS` | `50` | The one-time grant. |
| `SLICELY_FREE_MODEL` | — | Overrides the model choice in §6. |
| `SLICELY_FREE_MAX_OUTPUT_TOKENS` | `4000` | Per-call output ceiling on free credit. |
| `SLICELY_FREE_CHATS_PER_DAY` | `40` | Per account, per UTC day. |
| `SLICELY_SIGNUPS_PER_IP_PER_DAY` | `3` | Per hashed IP, per UTC day. |
| `SLICELY_DAILY_SPEND_CAP_CENTS` | `500` | Global kill switch across all free users. |
| `SLICELY_MAX_HISTORY_TURNS` | `12` | History cap (applies to every turn, paid or free — it is a pure win). |

**Retired:** `SLICELY_ALLOW_OPERATOR_KEY`. In hosted mode the owner's keys are now reachable only
through a metered account, which is the safe version of what that flag did. On desktop the owner
is the user, so the fallback applies unconditionally and needs no flag. The variable is removed
from `.env.example`, the README and the code, and a test asserts that a hosted server with
`ANTHROPIC_API_KEY` set and no signed-in account answers `signin_required` — never a spent key.

## 12. What the owner must configure

1. **A Google OAuth client** — console.cloud.google.com → APIs & Services → Credentials → OAuth
   client ID → *Web application*. Authorised redirect URI:
   `https://<your domain>/auth/google/callback`. Consent screen: External, scopes `openid`,
   `email`, `profile` only (no verification review needed for those three).
2. **A GitHub OAuth App** — github.com/settings/developers → New OAuth App. Authorization
   callback URL: `https://<your domain>/auth/github/callback`.
3. **Fly secrets:**
   `fly secrets set SLICELY_PUBLIC_URL=… GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ANTHROPIC_API_KEY=…`
4. **Decide the numbers.** The defaults (50¢ grant, 500¢/day cap, 3 signups/IP/day, 40 chats/day)
   are a starting point, not a recommendation. The grant and the cap together bound the daily
   worst case: at 50¢ a head the cap is reached by the eleventh brand-new user of the day.
5. **Optionally edit the price table** (`src/main/pricing.ts`) when a provider changes its rates.
   It is one table with a comment saying so, and a test fails if a catalogue model has no row.
6. **Nothing at all** if they would rather not run a free tier: leave the OAuth secrets unset and
   Slicely is exactly the BYO-only product of the public-launch spec.

## 13. Testing

- **Unit, no network, no clock dependence:** email normalisation (the gmail rules, the alias, the
  `+` tag, malformed input); the disposable list; `safeReturnTo` against nine hostile inputs;
  PKCE challenge derivation; the price table's completeness; `costMicros` against the §4.3
  fixture to the exact µ¢; `capHistory` pairing invariants; the prompt token budget and the
  load-bearing-phrase checklist; the `input`-is-append-only prefix property.
- **Concurrency:** 20 parallel charges land exactly once each.
- **Integration with a fake OAuth provider injected through `CreateAppOptions`** — no real
  network in any test: the happy path end to end (start → callback → bound session → `/api/me`
  shows 50¢); a tampered `state`; a missing cookie; an unverified email; a disposable domain; the
  fourth signup from one IP; a second sign-in that finds the existing account and grants nothing;
  the same human on Google then GitHub resolving to one account.
- **Chat gating:** each of the seven pre-flight rows answers its status and code before any SSE
  header, and a hosted server with `ANTHROPIC_API_KEY` set never spends it for a stranger.
- **Metering end to end:** a stub provider reporting a known `TurnUsage` moves the balance by
  exactly the expected µ¢, writes exactly one ledger line, and emits one `credit` event.
- **The budget test:** the §4.3 fixture is under 6¢ with caching and over it without.
- **Browser, via the `browser-automation` skill:** the sign-in card renders and its buttons
  navigate; the header pill shows a balance; the exhausted card's two buttons open the right
  places; the waitlist sheet submits and thanks; zero console errors at 400px and 1280px.
- **A real-key smoke run** (owner's keys, not CI): one real turn on `claude-sonnet-5` where
  `cache_read_input_tokens > 0` on the second call, the ledger line matches the provider's own
  reported usage, and the balance moves by the amount the dashboard later agrees with.
- **Desktop regression:** `npm start`, no `/auth` route mounted, no accounts directory created,
  `accountsEnabled: false`, chat works on the owner's key exactly as before.
