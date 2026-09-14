# Slicely Public Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slicely safe, legal, and polished enough to release to the public as a hosted web app plus a downloadable macOS app, with users bringing their own Anthropic API key.

**Architecture:** One Express server (`src/server`) serves one browser UI (`src/web`) in two modes: `hosted` (Fly.io, multi-user, cloud printers only) and `desktop` (Electron starts it on loopback and loads the same UI). Every per-visitor thing — workspace, settings, chats, printers, the user's encrypted Anthropic key — hangs off the session; nothing is process-global anymore. Security fixes land test-first.

**Tech Stack:** TypeScript 5.9, Node 20, Express 4, `@anthropic-ai/sdk` 0.105, Electron 42, electron-builder 26, `node:test`, no bundler (browser ESM), no new runtime deps except `multer@2`.

**Spec:** `docs/superpowers/specs/2026-09-12-public-launch-design.md` — read it first; this plan argues from it.

## Global Constraints

- BYO Anthropic key only. Never read `ANTHROPIC_API_KEY` in the server. Never propose or accept `sk-ant-oat` tokens, `claude setup-token` output, or any claude.ai login. (Spec §Decisions.)
- The user's key: encrypted at rest (AES-256-GCM), never logged, never in any HTTP response body, never in an error string. The client only ever sees `{ hasKey, keyHint }`. (Spec §1.)
- Owner's sourcing keys (`THINGIVERSE_APP_TOKEN`, `GITHUB_TOKEN`, `MYMINIFACTORY_API_KEY`, `SMITHSONIAN_API_KEY`) stay env-only. (Spec §Goal.)
- Absolute filesystem paths never reach a client. (Spec §Error handling.) One deliberate exception: in desktop mode the model's own `text`/`thinking` frames and the persisted reply are not scrubbed — the reader owns the machine and those are their own paths; hosted mode scrubs everything.
- Wire errors are `{ error: string, code?: string }`. Stable codes: `no_key`, `key_rejected`, `key_invalid_format`, `rate_limited`, `no_session`, `slicer_busy`, `not_in_workspace`, `forbidden`, `forbidden_in_hosted_mode`, `cross_origin`, `billing`, `busy`, `not_found`, `too_large`, `zip_too_many_entries`, `zip_entry_too_large`, `slice_failed`, `slice_timeout`, `host_blocked`. (Spec §Error handling.)
  - `no_session` (401): the request carried no session cookie and is not one of the two calls allowed to create a workspace (`GET /api/config`, `POST /api/session`). A client boots by awaiting `GET /api/config` once and then issues everything else; a fan-out of cookieless calls used to mint one workspace per request (see the K1 verification's D-2).
- `SLICELY_MODE` ∈ `hosted` | `desktop`. `npm run serve` and Docker default to `hosted`. Electron sets `desktop`. `SLICELY_MULTI_USER` is retired. (Spec §3.)
- Session cookie is `__Host-slicely_sid` in hosted mode (`Secure; HttpOnly; SameSite=Lax; Path=/`), `slicely_sid` on loopback desktop (no `Secure` — `__Host-` requires it). (Spec §3.)
- Rate-limit tiers per session: `api` 60 burst / 5 per s; `chat` 6 burst / 0.05 per s; `heavy` 10 burst / 0.1 per s; per-IP session mint 20 per hour. (Spec §2.)
- PrusaSlicer concurrency `SLICELY_MAX_SLICES` default 2; per-slice timeout 10 min. (Spec §2.)
- Brand mark is the `◆` glyph everywhere (site favicon, app icon, header). (Spec §6.)
- Commit after every task with a message in the repo's house style: `slicely-v3: <what changed, in plain words>` + the attribution trailer given in the session.
- Every task: `npm run typecheck` and `npm run test:only` green before commit (run `npm run build` first when a test file was added, since tests run from `dist/`).
- No new runtime dependencies without a line in the task saying why. Allowed: `multer@^2` (Task C3).
- Scope boundary: find → slice → print. No CAD, no geometry generation.
- Legal text is a **template**; every legal file starts with an HTML comment / heading note "Template — not legal advice. Have a lawyer review before launch." Placeholders are `{{ENTITY}}`, `{{CONTACT_EMAIL}}`, `{{JURISDICTION}}`, `{{EFFECTIVE_DATE}}`.

## File map (what exists after the plan)

```
src/main/
  mode.ts                 NEW  getMode(): "hosted"|"desktop"; isHosted(); isDesktop()
  keyvault.ts             NEW  encryptSecret/decryptSecret (AES-256-GCM), loadMasterKey()
  userkey.ts              NEW  per-session user Anthropic key: get/set/clear/hint
  semaphore.ts            NEW  Semaphore for PrusaSlicer concurrency
  config.ts               MOD  drop anthropicApiKey; add masterKey, mode-aware workdir defaults
  agent/agent.ts          MOD  key from userkey; NoApiKeyError; mapped Anthropic errors
  agent/tools.ts          MOD  resolvePath confined to session
  printers/registry.ts    MOD  per-session stores, encrypted secrets, disposeSessionPrinters
  printers/util.ts        MOD  guardedPrinterFetch (SSRF)
  printers/drivers/file.ts MOD outputDir/jobName validation, desktop-only
  sourcing/net.ts         MOD  manual redirects, all-records DNS, ranges, ports
  prusaslicer.ts          MOD  semaphore + timeout around every spawn
  main.ts                 MOD  Electron: start loopback server, load web client, sandbox
  preload.ts              MOD  trimmed to native-only surface (tokens, not paths)
src/server/
  security.ts             MOD  tiered rateLimiter keyed on verified session; HSTS; CSP additions
  session.ts              MOD  __Host- cookie; mint limiter; desktop single-session; dispose hooks
  errors.ts               NEW  WireError, sendError(), stripPaths()
  static.ts               NEW  allow-listed static serving (no .map/.ts)
  index.ts                MOD  startServer(opts) returns {server,store,port}; mode wiring; /terms /privacy
  routes/config.ts        NEW  GET /api/config
  routes/key.ts           NEW  PUT/DELETE /api/key
  routes/session.ts       NEW  DELETE /api/session
  routes/local.ts         NEW  POST /api/attach-local (desktop only)
  routes/printers.ts      MOD  session registry, POST discover, validation
  routes/chats.ts         MOD  GET read-only; POST /chats/:id/activate
  routes/upload.ts        MOD  diskStorage, per-request cap
  routes/*.ts             MOD  sendError() everywhere
src/web/
  app.ts                  MOD  boot + wiring only (~300 lines)
  api.ts cards.ts chat.ts jobs.ts printers.ts settings.ts ui.ts markdown.ts  NEW (split)
  onboarding.ts           NEW  key card, first-run steps, consent banner
  index.html styles.css   MOD
src/renderer/             DELETED
site/
  index.html styles.css main.js config.js favicon.svg og.png robots.txt sitemap.xml
  terms.html privacy.html fonts/
build/                    NEW  icon.icns icon.png entitlements.mac.plist
Dockerfile fly.toml .dockerignore docs/DEPLOY.md .env.example scripts/gen-master-key.mjs scripts/make-icon.sh
```

## Task dependency graph

```
A1 A2 ──► B1 B2 B3 B4 ──► C1 C2 C3 C4 ──► D1 … D9 ──► E1 E2 E3 ──► K
                │                                       ▲
                └──► F1 … F6 (web client; needs B3/B4 contracts only) ─┘
G1 G2 G3 H1 (site + legal) — independent, any time
I1 I2 (mac packaging) — after E
J1 J2 J3 (docker/fly/docs) — after D8 (mode flag)
```

Workstreams B–D must run **sequentially in one worker** (they share `src/server` and `src/main`). F, G/H, I can run in parallel with them in separate worktrees, merging back before E.

---

## Workstream A — Hygiene and secrets

### Task A1: Get the session secret and runtime files out of the tree

**Files:**
- Modify: `.gitignore`
- Delete from index: `.session-secret`
- Delete: `.printers.json.36487.*.tmp` (4 files)

**Interfaces:** none.

- [ ] **Step 1: Confirm the secret never left this machine**

Run: `cd /Users/IT/slicely && git branch -r --contains a95d42b`
Expected: empty output (the commit that added `.session-secret` is on no remote branch). If it is NOT empty, stop and tell the owner — history rewriting on a public remote is their call.

- [ ] **Step 2: Untrack, rotate, ignore**

```bash
git rm --cached .session-secret
rm -f .session-secret .printers.json.*.tmp
printf '\n# Secrets & per-machine state (never commit)\n.session-secret\nmaster.key\nprinter-secrets.json\nsecrets.json\n' >> .gitignore
```

- [ ] **Step 3: Verify**

Run: `git status --short && git check-ignore -v .session-secret master.key`
Expected: `.session-secret` shows as `D` in the index; check-ignore prints a matching `.gitignore` line for both names.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "slicely-v3: stop tracking the cookie-signing secret, and ignore every secret file by name"
```

### Task A2: Move the default workdir off the repo

The repo root doubles as `~/Slicely` on a case-insensitive filesystem, which is how a secret ended up tracked.

**Files:**
- Modify: `src/main/config.ts`
- Test: `src/main/config.test.ts` (create)

**Interfaces:**
- Produces: `getConfig().workdir` default = `join(homedir(), "Slicely-data")` when `SLICELY_MODE` is unset or `hosted`; `SLICELY_WORKDIR` still overrides. (Electron will pass `app.getPath("userData")` via `SLICELY_WORKDIR` in Task E1.) `resetConfigForTests()` clears the cache.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigForTests } from "./config";

test("the default workdir is not the repo (or ~/Slicely, which is the repo on a case-insensitive disk)", () => {
  const saved = process.env.SLICELY_WORKDIR;
  delete process.env.SLICELY_WORKDIR;
  resetConfigForTests();
  const cfg = getConfig();
  assert.equal(cfg.workdir, join(homedir(), "Slicely-data"));
  assert.notEqual(cfg.workdir, join(homedir(), "Slicely"));
  if (saved !== undefined) process.env.SLICELY_WORKDIR = saved;
  resetConfigForTests();
});

test("SLICELY_WORKDIR still wins", () => {
  process.env.SLICELY_WORKDIR = "/tmp/slicely-test-workdir";
  resetConfigForTests();
  assert.equal(getConfig().workdir, "/tmp/slicely-test-workdir");
  delete process.env.SLICELY_WORKDIR;
  resetConfigForTests();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/main/config.test.js`
Expected: FAIL — `resetConfigForTests` is not exported / workdir equals `~/Slicely`.

- [ ] **Step 3: Implement**

In `src/main/config.ts`: change the default to `join(homedir(), "Slicely-data")`; add

```ts
/** Tests only: forget the cached config so env changes are re-read. */
export function resetConfigForTests(): void {
  cached = null;
}
```

Also remove `anthropicApiKey` from `SlicelyConfig` and `configState()` **is deferred to Task B3** — do not touch it here.

- [ ] **Step 4: Run tests**

Run: `npm run build && npm run test:only`
Expected: all pass (374 + 2).

- [ ] **Step 5: Update README's `SLICELY_WORKDIR` row** to say default `~/Slicely-data`, and commit.

```bash
git add src/main/config.ts src/main/config.test.ts README.md
git commit -m "slicely-v3: keep runtime data out of the repo by default"
```

---

## Workstream B — Mode, key vault, user key, config endpoint

### Task B1: `mode.ts` — one switch for hosted vs desktop

**Files:**
- Create: `src/main/mode.ts`, `src/main/mode.test.ts`
- Modify: `src/server/security.ts` (`isMultiUser` delegates to mode)

**Interfaces:**
- Produces:
  ```ts
  export type SlicelyMode = "hosted" | "desktop";
  export function getMode(): SlicelyMode;   // SLICELY_MODE, default "hosted"
  export function isHosted(): boolean;
  export function isDesktop(): boolean;
  ```
  `isMultiUser()` in `security.ts` becomes `return isHosted();` (keep the name; every caller keeps working).

- [ ] **Step 1: Failing test**

```ts
// src/main/mode.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMode, isHosted, isDesktop } from "./mode";

test("unset SLICELY_MODE means hosted — the safe default is the one nobody has to set", () => {
  delete process.env.SLICELY_MODE;
  assert.equal(getMode(), "hosted");
  assert.equal(isHosted(), true);
  assert.equal(isDesktop(), false);
});

test("desktop is opt-in and anything else is rejected loudly", () => {
  process.env.SLICELY_MODE = "desktop";
  assert.equal(getMode(), "desktop");
  process.env.SLICELY_MODE = "banana";
  assert.throws(() => getMode(), /SLICELY_MODE/);
  delete process.env.SLICELY_MODE;
});
```

- [ ] **Step 2: Run, expect FAIL (module missing).**

- [ ] **Step 3: Implement `src/main/mode.ts`** exactly per the interface (read env on every call — no cache — so tests and Electron's early `process.env.SLICELY_MODE = "desktop"` both work). In `security.ts` replace the body of `isMultiUser` with `return isHosted();` and update its doc comment to mention `SLICELY_MODE`. Update `src/server/security.test.ts` to set `SLICELY_MODE` instead of `SLICELY_MULTI_USER`.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit** — `slicely-v3: one explicit mode switch, hosted by default`

### Task B2: `keyvault.ts` — encrypt secrets at rest

**Files:**
- Create: `src/main/keyvault.ts`, `src/main/keyvault.test.ts`, `scripts/gen-master-key.mjs`
- Modify: `src/main/config.ts` (expose `masterKeyEnv`)

**Interfaces:**
- Produces:
  ```ts
  export function loadMasterKey(): Buffer;             // 32 bytes. hosted: SLICELY_MASTER_KEY (base64) required, throws if missing/wrong length. desktop: read or create <workdir>/master.key (0600).
  export function encryptSecret(plain: string, key = loadMasterKey()): string; // "v1:<iv b64>:<tag b64>:<ct b64>"
  export function decryptSecret(blob: string, key = loadMasterKey()): string;  // throws KeyVaultError on tamper/wrong key/bad format
  export class KeyVaultError extends Error {}
  export function resetKeyVaultForTests(): void;
  ```
  `scripts/gen-master-key.mjs` prints `SLICELY_MASTER_KEY=<base64 of 32 random bytes>`.

- [ ] **Step 1: Failing tests**

```ts
// src/main/keyvault.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, KeyVaultError, loadMasterKey, resetKeyVaultForTests } from "./keyvault";

const k1 = randomBytes(32);
const k2 = randomBytes(32);

test("round-trips, and the ciphertext never contains the plaintext", () => {
  const blob = encryptSecret("sk-ant-api03-hello", k1);
  assert.equal(decryptSecret(blob, k1), "sk-ant-api03-hello");
  assert.ok(!blob.includes("sk-ant"));
  assert.ok(blob.startsWith("v1:"));
});

test("two encryptions of the same value differ (fresh IV each time)", () => {
  assert.notEqual(encryptSecret("x", k1), encryptSecret("x", k1));
});

test("the wrong master key, or a tampered blob, is an error — never silent garbage", () => {
  const blob = encryptSecret("secret", k1);
  assert.throws(() => decryptSecret(blob, k2), KeyVaultError);
  const parts = blob.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":"), k1), KeyVaultError);
  assert.throws(() => decryptSecret("not-a-blob", k1), KeyVaultError);
});

test("hosted mode refuses to boot without a real 32-byte SLICELY_MASTER_KEY", () => {
  process.env.SLICELY_MODE = "hosted";
  delete process.env.SLICELY_MASTER_KEY;
  resetKeyVaultForTests();
  assert.throws(() => loadMasterKey(), /SLICELY_MASTER_KEY/);
  process.env.SLICELY_MASTER_KEY = Buffer.from("short").toString("base64");
  resetKeyVaultForTests();
  assert.throws(() => loadMasterKey(), /32 bytes/);
  process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
  resetKeyVaultForTests();
  assert.equal(loadMasterKey().length, 32);
  delete process.env.SLICELY_MASTER_KEY;
  delete process.env.SLICELY_MODE;
  resetKeyVaultForTests();
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** with `crypto.createCipheriv("aes-256-gcm", key, iv)` (12-byte IV, 16-byte tag). Desktop path: `join(getConfig().workdir, "master.key")`, `writeFileSync(..., { mode: 0o600 })` on first run. Cache the loaded key in a module variable; `resetKeyVaultForTests` clears it.

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit** — `slicely-v3: an encrypted vault for the secrets users trust us with`

### Task B3: `userkey.ts` — the user's Anthropic key, per session

**Files:**
- Create: `src/main/userkey.ts`, `src/main/userkey.test.ts`
- Modify: `src/main/config.ts` (remove `anthropicApiKey`; `configState()` removed — replaced by Task B4), `src/main/agent/agent.ts`, `src/shared/types.ts` (remove `ConfigState.hasAnthropicKey` usage or the whole `ConfigState` once Electron stops using it in E1 — for now leave the type, stop populating it from env)

**Interfaces:**
- Produces:
  ```ts
  export const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;
  export class NoApiKeyError extends Error { code = "no_key" as const }
  export function getUserApiKey(): string | undefined;     // decrypts <session>/secrets.json → anthropicKey; operator fallback: ANTHROPIC_API_KEY when isDesktop() or SLICELY_ALLOW_OPERATOR_KEY=1 (userKeyHint() then reports "this server's key", never the last four)
  export function setUserApiKey(key: string): void;        // validates format (throws KeyFormatError code "key_invalid_format"), encrypts, writes 0600, updates cache
  export function clearUserApiKey(): void;
  export function userKeyHint(): string | undefined;       // last 4 chars, e.g. "…a1b2"
  export function disposeSessionUserKey(id: string): void; // drop cache entry
  ```
  Storage: `sessionFile("secrets.json")` → `{ version: 1, anthropicKey?: "<encrypted blob>" }`. Cache: `Map<sessionId, string|undefined>` keyed by `currentSessionId()` (same pattern as `settings.ts`).
- `SlicelyAgent` constructor: `const key = getUserApiKey(); if (!key) throw new NoApiKeyError("Connect your Anthropic API key in Settings to chat.");` Remove every mention of `.env` from user-facing strings in `agent.ts`.

- [ ] **Step 1: Failing tests**

```ts
// src/main/userkey.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInSession, sessionContext } from "./session-context";
import { getUserApiKey, setUserApiKey, clearUserApiKey, userKeyHint, disposeSessionUserKey } from "./userkey";
import { resetKeyVaultForTests } from "./keyvault";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

const GOOD = "sk-ant-api03-" + "a".repeat(40);

test("a key is stored encrypted and only readable inside its own session", () => {
  const dirA = mkdtempSync(join(tmpdir(), "uk-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "uk-b-"));
  runInSession(sessionContext("A", dirA), () => {
    setUserApiKey(GOOD);
    assert.equal(getUserApiKey(), GOOD);
    assert.equal(userKeyHint(), "…" + GOOD.slice(-4));
    const onDisk = readFileSync(join(dirA, "secrets.json"), "utf8");
    assert.ok(!onDisk.includes(GOOD), "plaintext key must never hit disk");
  });
  runInSession(sessionContext("B", dirB), () => {
    assert.equal(getUserApiKey(), undefined);
  });
  disposeSessionUserKey("A");
  runInSession(sessionContext("A", dirA), () => {
    assert.equal(getUserApiKey(), GOOD, "survives a cache drop by re-reading disk");
    clearUserApiKey();
    assert.equal(getUserApiKey(), undefined);
  });
});

test("malformed keys are rejected before anything is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "uk-c-"));
  runInSession(sessionContext("C", dir), () => {
    assert.throws(() => setUserApiKey("sk-ant-oat01-" + "x".repeat(40)), /format|Anthropic API key/i);
    assert.throws(() => setUserApiKey("hello"), /format|Anthropic API key/i);
    assert.equal(getUserApiKey(), undefined);
  });
});
```

Also add to `src/main/agent/` a test that constructing `SlicelyAgent` with no key throws `NoApiKeyError` (code `no_key`) and does not mention `.env`:

```ts
// src/main/agent/agent-key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSession, sessionContext } from "../session-context";
import { SlicelyAgent } from "./agent";
import { NoApiKeyError } from "../userkey";

test("no key → a typed error the UI can turn into the key card, with no .env talk", () => {
  process.env.SLICELY_MODE = "hosted";
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  runInSession(sessionContext("nokey", dir), () => {
    assert.throws(() => new SlicelyAgent(), (e: unknown) => e instanceof NoApiKeyError && (e as NoApiKeyError).code === "no_key" && !/\.env/.test((e as Error).message));
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** per the interface. Note the `sk-ant-oat` rejection is deliberate: the regex requires `sk-ant-api`. In `config.ts` delete `anthropicApiKey` and `configState()`; fix every compile error that surfaces (`main.ts` uses `configState` — replace with a stub returning `{ hasAnthropicKey: false, hasThingiverseToken, model, workdir }` for now; E1 deletes it).

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit** — `slicely-v3: each user brings their own Anthropic key, stored encrypted`

### Task B4: `/api/config`, `/api/key`, `/api/session`, and mapped Anthropic errors

**Files:**
- Create: `src/server/routes/config.ts`, `src/server/routes/key.ts`, `src/server/routes/session.ts`, `src/server/errors.ts`, `src/server/routes/key.test.ts`, `src/server/errors.test.ts`
- Modify: `src/server/index.ts` (mount), `src/server/routes/chat.ts` (409 `no_key`; error mapping), `src/server/session.ts` (`destroy` also disposes state/settings/userkey/printers)

**Interfaces:**
- Produces:
  ```ts
  // errors.ts
  export class WireError extends Error { constructor(public status: number, message: string, public code?: string) }
  export function stripPaths(text: string): string;       // replaces any absolute path under getConfig().workdir or /Users/... or /home/... with "<file>"
  export function toWire(err: unknown): { status: number; body: { error: string; code?: string } };
  //   WireError → as is; NoApiKeyError → 409 no_key; Anthropic.AuthenticationError → 401 key_rejected ("Your Anthropic key was rejected. Update it in Settings.");
  //   Anthropic.RateLimitError → 429 rate_limited ("Your Anthropic account is being rate-limited. Try again in a moment.");
  //   Anthropic.PermissionDeniedError / BadRequestError mentioning credit|billing → 402 code "billing" ("Your Anthropic account has no available credit.");
  //   anything else → 500 "Something went wrong." (log the real error server-side with session id, never the key)
  export function sendError(res: Response, err: unknown): void;
  ```
  ```ts
  // GET /api/config →
  interface ConfigResponse { mode: "hosted"|"desktop"; hasKey: boolean; keyHint?: string; multiUser: boolean; slicerAvailable: boolean; sourceCommit: string; version: string; repoUrl: string; termsUrl: "/terms"; privacyUrl: "/privacy" }
  // PUT /api/key { apiKey } → 200 { hasKey: true, keyHint } | 400 key_invalid_format | 401 key_rejected (validation call: client.models.list({limit:1}) with a 10s timeout; network failure → 502 "Couldn't reach Anthropic to check the key.")
  // DELETE /api/key → 200 { hasKey: false }
  // DELETE /api/session → 204, clears cookie, destroys workspace
  ```
  `sourceCommit` = `process.env.SLICELY_SOURCE_COMMIT ?? (git rev-parse HEAD at boot, cached) ?? "dev"`. `version` from `package.json`.
  `createKeyRouter(opts?: { validate?: (key: string) => Promise<"ok"|"rejected"|"unreachable"> })` so tests inject a validator and never hit the network.

- [ ] **Step 1: Failing tests**

```ts
// src/server/routes/key.test.ts — follow the pattern in src/server/routes/chat.test.ts:
// createApp({ sessionStore: tmpStore, chatAgentFactory: stub, keyValidator: async () => "ok" }), listen on port 0, drive with fetch.
// Tests:
// 1. PUT /api/key with a bad format → 400, body.code === "key_invalid_format"; GET /api/config still hasKey:false.
// 2. PUT valid-format key with validator "rejected" → 401 key_rejected.
// 3. PUT valid + validator "ok" → 200 { hasKey: true, keyHint: "…" + last4 }; GET /api/config → hasKey true; the response text of BOTH calls does not contain the key.
// 4. A second session (no cookie) GET /api/config → hasKey:false.
// 5. DELETE /api/key → hasKey false. DELETE /api/session → 204 and the session dir no longer exists.
// 6. POST /api/chat with no key → SSE stream whose first event is {type:"error", code:"no_key"} then done — OR a 409 JSON before the stream begins. Pick 409 JSON (simpler for the UI) and assert it.
```

```ts
// src/server/errors.test.ts
// stripPaths("/Users/it/Slicely-data/sessions/abc/uploads/x.stl failed") → "<file> failed"
// toWire(new WireError(403, "nope", "forbidden_in_hosted_mode")).status === 403 and body.code
// toWire(new Error("boom /Users/it/secret.txt")).body.error === "Something went wrong." (no path, no message leak)
// toWire(Object.assign(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", undefined))) → 401 key_rejected  (construct via the SDK class; if its ctor is awkward, use `Object.create(Anthropic.AuthenticationError.prototype)` with status set)
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `keyValidator` to `CreateAppOptions`. Default validator builds `new Anthropic({ apiKey, maxRetries: 0, timeout: 10_000 })` and calls `client.models.list({ limit: 1 })`; `AuthenticationError` → "rejected"; `APIConnectionError` → "unreachable"; other API errors (e.g. 403 from a workspace-scoped key) → still "ok"? No: treat `PermissionDeniedError` as "rejected" with a message that mentions workspace scoping. In `routes/chat.ts`, before `makeAgent()`: `if (!getUserApiKey()) { sendError(res, new NoApiKeyError(...)); return; }` (before SSE headers are written). In the catch around `agent.send`, emit `{ type: "error", message: toWire(err).body.error, code: toWire(err).body.code }` — extend `AgentEvent`'s error variant in `src/shared/types.ts` with optional `code?: string`.

- [ ] **Step 4: Run all tests, expect PASS.**

- [ ] **Step 5: Commit** — `slicely-v3: the API tells the client whether a key is connected, and takes one`

---

## Workstream C — Rate limits and resource bounds

### Task C1: Rate-limit on the verified session, in tiers

**Files:**
- Modify: `src/server/security.ts`, `src/server/index.ts`, `src/server/security.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateLimitOptions { name: string; capacity: number; refillPerSec: number; keyFn?: (req) => string | undefined }
  export const LIMITS = {
    api:   { name: "api",   capacity: 60, refillPerSec: 5 },
    chat:  { name: "chat",  capacity: 6,  refillPerSec: 1 / 20 },
    heavy: { name: "heavy", capacity: 10, refillPerSec: 1 / 10 },
  } as const;
  export function rateLimiter(opts: RateLimitOptions): RequestHandler; // default keyFn: req.session?.id ? `sid:${id}` : `ip:${clientIp(req)}`
  export function clientIp(req): string; // req.ip only when SLICELY_TRUST_PROXY==="1", else req.socket.remoteAddress
  ```
  Mount order in `index.ts`: `api.use(sessionMiddleware(store))` **then** `api.use(rateLimiter(LIMITS.api))`; `router.post("/chat", rateLimiter(LIMITS.chat), ...)`; `heavy` on `/slice`, `/jobs/:id/run`, `/import`, `/upload`. `app.set("trust proxy", process.env.SLICELY_TRUST_PROXY === "1")`. 429 body: `{ error: "Too many requests — slow down a little.", code: "rate_limited" }` + `Retry-After` computed from deficit/refill (ceil seconds, min 1).

- [ ] **Step 1: Failing tests** (add to `security.test.ts`, using `createApp` + fetch):
  1. Rotating a *forged* `slicely_sid` cookie per request does NOT reset the bucket: with `capacity: 2` on a test app, three requests each carrying `Cookie: __Host-slicely_sid=<random>.<random>` → third is 429 (they fall back to the same IP key).
  2. `X-Forwarded-For` is ignored unless `SLICELY_TRUST_PROXY=1`: three requests with different XFF → third is 429.
  3. Two genuine sessions (two cookies minted by the server) have independent buckets.
  4. `Retry-After` header present and ≥ 1 on a 429; body `code === "rate_limited"`.

- [ ] **Step 2: Run, expect FAIL** (currently keyed on raw cookie).
- [ ] **Step 3: Implement.** Keep the token-bucket core; allow `capacity`/`refillPerSec` to be overridden through `createApp({ limits })` for tests.
- [ ] **Step 4: Run, PASS.**
- [ ] **Step 5: Commit** — `slicely-v3: rate limits that can't be reset by editing a cookie`

### Task C2: Mint sessions only when they're needed, and not too many per IP

**Files:**
- Modify: `src/server/session.ts`, `src/server/index.ts`, `src/server/session.test.ts`

**Interfaces:**
- `sessionMiddleware(store, opts?: { mintPerHour?: number })` — only mounted under `/api`. Static, `/healthz`, `/terms`, `/privacy` never touch the store. When no valid cookie: check a per-IP bucket (`capacity: mintPerHour (20), refill mintPerHour/3600`); exhausted → 429 `{ error: "Too many new sessions from this address. Try again later.", code: "rate_limited" }`.
- `SessionStore.destroy(id)` and `sweep()` call `disposeSessionState(id)`, `disposeSessionSettings(id)`, `disposeSessionUserKey(id)`, and (after D1) `disposeSessionPrinters(id)`.
- Hosted idle: `DEFAULT_IDLE_MS = 30 days`; **workspace file sweep** separate: `sweepFiles()` every 10 min removes `uploads/ downloads/ slices/` contents idle > 2 h but keeps `secrets.json`, `settings.json`, `chats/`. (Session record and cookie live 30 days.)

- [ ] **Step 1: Failing tests:** (a) `GET /` and `GET /healthz` set no cookie and `store.count()` stays 0; (b) 21 cookie-less `GET /api/config` from one IP → the 21st is 429 and `store.count() === 20`; (c) `destroy` disposes settings (spy via a module-level counter exported for tests: `__disposeCallsForTests()`), (d) after `sweepFiles()` with `fileIdleMs: 0`, `uploads/` is empty but `secrets.json` remains.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: a visitor gets a workspace when they use one, and files don't outlive their usefulness`

### Task C3: Uploads to disk, bounded

**Files:**
- Modify: `package.json` (`multer` → `^2.0.0`, `@types/multer` latest), `src/server/routes/upload.ts`, `src/main/meshzip.ts`, `src/main/sourcing/download.ts`, `src/server/routes/upload.test.ts`

**Why a dependency change:** multer 1.x has a known DoS advisory and `memoryStorage` buffers 200 MB × 12 in RAM. 2.x is the maintained line.

**Interfaces:** `multer({ storage: diskStorage({ destination: <session>/scratch }), limits: { fileSize: 200 MB, files: 12, fields: 4, parts: 20 } })` plus a manual running total ≤ 600 MB (abort with 413 `{ error: "Upload too large (600 MB max per batch).", code: "too_large" }`). Zip caps in both extractors: ≤ 500 entries, ≤ 2 GB total uncompressed (per-entry size already capped in download.ts; add `MAX_ZIP_ENTRIES`, `MAX_ZIP_TOTAL_BYTES` to `src/shared/types.ts` and use in both).

- [ ] **Step 1: Failing tests:** upload of two 1 KB files lands under the session dir (not in a global `uploads/`); a zip with 501 tiny entries → 400 `code: "zip_too_many_entries"`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Run `npm audit --omit=dev` and paste the summary line into the commit body.
- [ ] **Step 5: Commit** — `slicely-v3: uploads stream to disk with a ceiling, and zips can't explode`

### Task C4: PrusaSlicer concurrency and timeouts

**Files:**
- Create: `src/main/semaphore.ts`, `src/main/semaphore.test.ts`
- Modify: `src/main/prusaslicer.ts` (wrap **every** `spawn`/`execFile` of the slicer in `acquire()` + `AbortSignal.timeout(10 min)`), `src/main/config.ts` (`maxSlices` from `SLICELY_MAX_SLICES`, default 2)

**Interfaces:**
```ts
export class Semaphore {
  constructor(public readonly size: number);
  acquire(): Promise<() => void>;   // resolves with a release fn; FIFO
  get waiting(): number;
}
export const sliceSemaphore: Semaphore; // in prusaslicer.ts, size = getConfig().maxSlices
```
While waiting, the progress callback (already used by long tools) reports `"Waiting for a free slicer (N ahead)…"`. A timed-out slice is killed (`SIGKILL`) and surfaces as `WireError(504, "Slicing took too long and was stopped.", "slice_timeout")`.

- [ ] **Step 1: Failing tests** for `Semaphore` (size 2, 5 acquires → 2 resolve immediately, `waiting === 3`, releasing one resolves the next in order) and for `prusaslicer.ts`: with `PRUSASLICER_PATH` pointed at a tiny fake script (`sleep 5`) and timeout overridden to 200 ms via an exported `setSliceTimeoutForTests`, a slice rejects with code `slice_timeout` within 1 s.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: two slicers at a time, and none forever`

---

## Workstream D — Security fixes

### Task D1: Printer registry per session, secrets encrypted

**Files:**
- Modify: `src/main/printers/registry.ts`, `src/main/printers/registry.test.ts`, `src/server/routes/printers.ts`, `src/server/session.ts` (call `disposeSessionPrinters` in destroy/sweep)
- Test: `src/server/printers-isolation.test.ts` (create)

**Interfaces:**
- `registry.ts` keeps its exported function names (`listConnections`, `addConnection`, …) but resolves files via `sessionFile("printers.json")` / `sessionFile("printer-secrets.json")` and caches in `Map<sessionId, …>` keyed by `currentSessionId()` — exactly the pattern `settings.ts` uses. Secrets file content: `{ version: 2, printers: { [id]: "<encrypted blob of JSON PrinterSecrets>" } }`. A legacy v1 plaintext file is read once and rewritten as v2.
- New export: `disposeSessionPrinters(id: string): void`.
- Because `sessionMiddleware` already runs each request inside `runInSession`, `routes/printers.ts` needs **no** API change; the façade calls just start resolving per session.

- [ ] **Step 1: Failing tests**

```ts
// src/server/printers-isolation.test.ts (pattern: createApp + fetch, two cookies)
// Use the REAL registry. Add createApp({ printerTestOverride: async () => ({ ok: true, message: "stub" }) })
// so addPrinter's connection test never touches the network.
// 1. Session A: POST /api/printers {transport:"prusa-connect", label:"A's MK4", host:"connect.prusa3d.com", token:"tok-A"} → 200
//    Session B: GET /api/printers → []
//    Session B: PATCH /api/printers/<A's id> {label:"pwned"} → 404 code "not_found"
//    Session B: POST /api/printers/<A's id>/autostart {armed:true} → 404
//    Session A: GET /api/printers → exactly one printer, label unchanged, autoStart false
// 2. readFileSync(join(sessionDirA, "printer-secrets.json")) does NOT include "tok-A"
```

```ts
// registry.test.ts additions
// runInSession(A) addConnection({... apiKey: "k-A"}); runInSession(B) listConnections() → []; runInSession(B) resolve(idA) throws /not found/i
// readFileSync(join(dirA, "printer-secrets.json"), "utf8") does not include "k-A"
// disposeSessionPrinters("A"); runInSession(A) listConnections() still returns the printer (re-read from disk)
```

- [ ] **Step 2: Run, expect FAIL** (B sees A's printer).
- [ ] **Step 3: Implement.** Also in `routes/printers.ts` make every `:id` route answer 404 `{ error: "No such printer.", code: "not_found" }` when the id is not in this session's registry.
- [ ] **Step 4: PASS.** Wrap the existing `registry.test.ts` tests in `runInSession(sessionContext("t", tmpdir))` so they keep passing.
- [ ] **Step 5: Commit** — `slicely-v3: your printers are yours — one registry per visitor, secrets encrypted`

### Task D2: The `file` transport can't write anywhere it likes

**Files:**
- Modify: `src/main/printers/drivers/file.ts`, `src/main/printers/index.ts` (`sendToPrinter` sanitises `jobName`; `addPrinter`/`updatePrinter` validate `outputDir`), `src/main/printers/util.ts`
- Test: `src/main/printers/util.test.ts` (extend)

**Interfaces:**
```ts
// printers/util.ts
export function safeJobName(name: string | undefined, fallback: string): string;
//  basename only; strip control chars and path separators; must end in .gcode|.bgcode|.3mf else append ".gcode"; max 120 chars; "" → fallback
export function assertAllowedOutputDir(dir: string): string;
//  hosted → WireError(403, "Saving to a folder only works in the Mac app.", "forbidden_in_hosted_mode")
//  must be absolute, resolve inside homedir(), and no path segment may start with "." (blocks ~/.ssh, ~/.config); returns the resolved path
```

- [ ] **Step 1: Failing tests:** `safeJobName("../../authorized_keys", "x.gcode")` → `"authorized_keys.gcode"`; `safeJobName("a\tb.gcode", "x")` → `"ab.gcode"`; `assertAllowedOutputDir(join(homedir(), ".ssh"))` throws; `assertAllowedOutputDir("/etc")` throws; hosted mode: any dir throws with code `forbidden_in_hosted_mode`; desktop mode: `join(homedir(), "Desktop")` is returned unchanged.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: the "save to folder" printer can only save where a person would`

### Task D3: SSRF — redirects, DNS, ranges, ports

**Files:**
- Modify: `src/main/sourcing/net.ts`, `src/main/sourcing/net.test.ts`, `src/server/routes/thumbs.ts` (same manual-redirect loop)

**Interfaces:**
```ts
export function isPrivateAddress(ip: string): boolean;     // exported for printers/util.ts (D4); adds 100.64.0.0/10, 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4
export interface UrlGuardOptions { allowedPorts?: number[]; lookup?: (host: string) => Promise<string[]> }
export async function assertPublicHttpUrl(url: string, opts?: UrlGuardOptions): Promise<URL>;
//  - scheme http/https only; default allowedPorts [80, 443, 8080, 8443]
//  - hostname that is not a valid IP literal but matches /^[0-9.]+$|^0x/i → blocked ("numeric host")
//  - lookup(host) (default dns.promises.lookup all:true) → EVERY address must be public; lookup failure → blocked
export async function guardedFetch(url: string, init?: RequestInit & { maxRedirects?: number; guard?: UrlGuardOptions }): Promise<Response>;
//  - redirect: "manual"; follow up to 5 hops; each Location resolved against the current URL and re-asserted; more → throw "Too many redirects"
```

- [ ] **Step 1: Failing tests** in `net.test.ts`. Start one local `http.createServer` on 127.0.0.1 that counts hits (the "internal" target) and one that answers `302 Location: http://127.0.0.1:<internalPort>/meta` (the "public" origin). Pass `guard.lookup` mapping `public.test` → `["93.184.216.34"]` and `evil.test` → `["93.184.216.34", "10.0.0.5"]`, and use `guard.allowedPorts` to include the origin's port. Since the origin is really loopback, the test must exercise the *redirect* leg: fetch `http://public.test:<originPort>/` with a custom `lookup`, and have `guardedFetch` connect to the resolved IP… that is too invasive. **Instead:** unit-test the pieces the redirect loop relies on, and the loop itself with an injected `fetchImpl`:
  ```ts
  // add to guardedFetch init: fetchImpl?: typeof fetch  (tests only)
  // 1. fetchImpl returns Response(null, {status: 302, headers: {location: "http://127.0.0.1/meta"}}) for the first call → guardedFetch rejects /private|blocked/i and fetchImpl was called exactly once.
  // 2. fetchImpl returns 302 six times to https://public.test/n → rejects /too many redirects/i.
  // 3. assertPublicHttpUrl("https://evil.test/", { lookup }) rejects (mixed records).
  // 4. "http://2130706433/", "http://0x7f000001/" → rejected as numeric host, no lookup performed.
  // 5. "http://public.test:6379/" → rejected (port).
  // 6. lookup that throws → rejected.
  // 7. isPrivateAddress: "100.64.1.1" true, "224.0.0.1" true, "198.18.0.1" true, "8.8.8.8" false, "::ffff:10.0.0.1" true.
  ```
- [ ] **Step 2–4:** FAIL → implement → PASS. Existing tests stay green.
- [ ] **Step 5: Commit** — `slicely-v3: a redirect can no longer walk the fetcher into the private network`

### Task D4: Printer drivers go through a guard too

**Files:**
- Modify: `src/main/printers/util.ts` (`fetchTimeout` validates the host first), every `src/main/printers/drivers/*.ts` that builds URLs (grep for bare `fetch(` and route through `fetchTimeout`), `src/main/printers/index.ts` (`addPrinter`/`updatePrinter` call `assertPrinterHostAllowed`)
- Test: `src/main/printers/util.test.ts` (extend)

**Interfaces:**
```ts
export async function assertPrinterHostAllowed(host: string, opts?: { lookup?: (h: string) => Promise<string[]> }): Promise<void>;
//  always blocked: loopback (127/8, ::1, "localhost", *.localhost), 0.0.0.0, 169.254.0.0/16, fe80::/10, multicast
//  hosted mode: additionally every private range (isPrivateAddress from sourcing/net.ts)
//  desktop mode: private ranges allowed (that's where printers live)
//  resolves hostnames; any blocked record → WireError(400, "That address isn't a printer we can reach from here.", "host_blocked")
```

- [ ] **Step 1: Failing tests:** hosted: `assertPrinterHostAllowed("192.168.1.50")` rejects with code `host_blocked`; desktop: resolves; both modes reject `"127.0.0.1"`, `"169.254.169.254"`, `"localhost"`; `addPrinter({ transport: "octoprint", host: "127.0.0.1", ... })` rejects before the connection test runs (inject a `testPrinter` stub that fails the test if called).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: "test my printer" can't be pointed at the server itself`

### Task D5: The agent's file paths stay inside the workspace

**Files:**
- Modify: `src/main/agent/tools.ts` (`resolvePath`; export `resolvePathForTests`), `src/main/agent/tools-v2.ts` (every tool that takes a path or `parts[].path`), `src/main/session-context.ts`
- Test: `src/main/agent/resolvePath.test.ts` (create)

**Interfaces:**
```ts
// session-context.ts
export function isInsideSessionWorkspace(p: string): boolean;
//  true when resolve(p) is inside currentSession().dir; in desktop mode ALSO inside getConfig().downloadsDir or homedir()
// tools.ts
function resolvePath(p: unknown): string
//  as before, but throws WireError(400, "That file isn't in your workspace. Import or upload it first.", "not_in_workspace") when !isInsideSessionWorkspace(path)
```

- [ ] **Step 1: Failing test:** hosted mode, inside `runInSession(A, dirA)`: `resolvePathForTests(join(dirB, "uploads/x.stl"))` throws code `not_in_workspace`; `resolvePathForTests("/etc/passwd")` throws; `resolvePathForTests(join(dirA, "uploads/x.stl"))` returns it; with no argument and `sessionState.lastModelPath` set inside dirA → returns it.
- [ ] **Step 2–4:** FAIL → implement → PASS. Grep for every place tool input becomes a path (`inspect_model`, `slice_model`, `slice_and_open`, `open_in_slicer`, `plan_job` parts, `split_model`, `orient_model`) and route it through `resolvePath`.
- [ ] **Step 5: Commit** — `slicely-v3: the agent can only touch the files in front of it`

### Task D6: Headers and cookie hardening

**Files:**
- Modify: `src/server/security.ts`, `src/server/session.ts`, `src/server/security.test.ts`, `src/server/session.test.ts`, `src/web/index.html` (meta CSP mirrors the header)

**Interfaces:**
- `securityHeaders()` adds `Strict-Transport-Security: max-age=31536000; includeSubDomains` (hosted only), `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and the CSP gains `frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Export `CSP_STRING` (Electron reuses it in E1).
- `export function cookieName(): string` → `__Host-slicely_sid` when hosted, `slicely_sid` when desktop. Hosted cookies always carry `Secure`.

- [ ] **Step 1: Failing tests:** hosted response has HSTS and the CSP contains `frame-ancestors 'none'`; desktop response has no HSTS; hosted `Set-Cookie` starts with `__Host-slicely_sid=` and includes `Secure` even over plain http (tests run over http; `__Host-` is a browser rule, not a server one).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: the headers a public site should have`

### Task D7: No GET with side effects; discovery is a POST

**Files:**
- Modify: `src/server/routes/chats.ts`, `src/server/routes/printers.ts`, `src/web/app.ts` (callers), `src/server/chats.test.ts` (extend)

**Interfaces:** `GET /api/chats/:id` returns the chat and does **not** change `session.activeChatId` or the agent history. `POST /api/chats/:id/activate` does both and returns the chat. `POST /api/printers/discover` with body `{ timeoutMs? }` replaces the GET.

- [ ] **Step 1: Failing test:** with chat `a` active, `GET /api/chats/<b>` leaves `store.get(id).activeChatId === a`; `POST /api/chats/<b>/activate` sets it to `b`; `GET /api/printers/discover` → 404.
- [ ] **Step 2–4:** FAIL → implement → PASS. Update the two web-client call sites in the same commit so the app keeps working.
- [ ] **Step 5: Commit** — `slicely-v3: reading a chat doesn't switch to it`

### Task D8: Error mapping everywhere, and a static allow-list

**Files:**
- Create: `src/server/static.ts`, `src/server/static.test.ts`
- Modify: every `src/server/routes/*.ts` (`res.status(5xx).json({ error: err.message })` → `sendError(res, err)`), `src/server/routes/slice.ts` (success body: replace absolute `path`/`gcodePath` with the opaque token plus a `displayName`), `src/server/index.ts`

**Interfaces:**
```ts
// static.ts
export function webStatic(repoRoot: string): RequestHandler;
//  GET /              → src/web/index.html
//  GET /styles.css    → src/web/styles.css
//  GET /favicon.svg   → site/favicon.svg
//  GET /web/<name>.js → dist-web/web/<name>.js   (404 for .map, .ts, nested paths, anything else)
//  GET /terms, /privacy → site/terms.html, site/privacy.html
//  everything else → next()
```
After this task, `grep -rn 'error: (err as Error).message\|error: err.message' src/server` must print nothing.

- [ ] **Step 1: Failing tests:** `GET /web/app.js.map` → 404; `GET /web/../package.json` → 404; `GET /app.ts` → 404; `GET /terms` → 200 `text/html`; `POST /api/slice` with a path outside the session → 400 with `code: "not_in_workspace"` and a body that does not contain the sessions root path.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `slicely-v3: errors say what happened without saying where the server keeps things`

### Task D9: Retire `SLICELY_MULTI_USER`, update docs

**Files:**
- Modify: `README.md` (config table gains `SLICELY_MODE`, `SLICELY_MASTER_KEY`, `SLICELY_TRUST_PROXY`, `SLICELY_MAX_SLICES`; `ANTHROPIC_API_KEY` leaves Requirements; add a "Bring your own key" section with the spec §7 wording), `.env.example` (rewrite: server secrets only), `src/server/LICENSING.md` (append: "Decision 2026-09-12: comply by publishing — `/api/config.sourceCommit` links to the running commit; the site footer and Settings → About link there").

- [ ] **Step 1:** `grep -rn SLICELY_MULTI_USER . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git` → fix every hit.
- [ ] **Step 2:** Commit — `slicely-v3: docs and env for the hosted/desktop split`

---

## Workstream E — One UI

### Task E1: Electron boots the server on loopback and loads the web client

**Files:**
- Modify: `src/main/main.ts`, `src/server/index.ts` (`startServer(opts)`), `src/server/session.ts` (desktop single session)
- Test: `src/server/desktop-mode.test.ts` (create)

**Interfaces:**
```ts
// server/index.ts
export interface StartServerOptions { host?: string; port?: number; desktopToken?: string; store?: SessionStore }
export async function startServer(opts?: StartServerOptions): Promise<{ server: Server; store: SessionStore; port: number; url: string }>;
// CreateAppOptions gains desktopToken?: string. In desktop mode every request (static included) must carry cookie
// `slicely_desktop=<token>` or header `x-slicely-desktop: <token>`, else 403 { error: "Forbidden.", code: "forbidden" }.
// session.ts desktop mode: SessionStore returns ONE record with id "desktop" and dir = getConfig().workdir
// (so sessionFile() resolves to today's Electron paths); no sweeping; cookie minting is harmless but unnecessary.
```
`main.ts` (shape, not verbatim):
```ts
process.env.SLICELY_MODE = "desktop";
process.env.SLICELY_WORKDIR ??= app.getPath("userData");
const token = randomBytes(24).toString("hex");
const { url, store } = await startServer({ host: "127.0.0.1", port: 0, desktopToken: token });
await session.defaultSession.cookies.set({ url, name: "slicely_desktop", value: token, httpOnly: true, sameSite: "strict" });
win = new BrowserWindow({ width: 1100, height: 760, minWidth: 420, minHeight: 600, titleBarStyle: "hiddenInset",
  webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) void shell.openExternal(u); return { action: "deny" }; });
win.webContents.on("will-navigate", (e, target) => { if (!target.startsWith(url)) e.preventDefault(); });
session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": [CSP_STRING] } }));
await win.loadURL(url);
```
Delete the old IPC agent plumbing (`getAgent`, `IPC.sendMessage`, `settingsState`, `configState`, the old `SlicelyApi`). Keep IPC only for E2's native surface.

- [ ] **Step 1: Failing test:** `SLICELY_MODE=desktop`, `createApp({ desktopToken: "t", sessionStore })`: `GET /` without the cookie → 403; with `Cookie: slicely_desktop=t` → 200; two requests share one session (`store.count() === 1`).
- [ ] **Step 2–4:** FAIL → implement → PASS. Then `npm start`: the window shows the web client; `fetch("/api/config")` in devtools shows `mode: "desktop"`.
- [ ] **Step 5: Commit** — `slicely-v3: the Mac app is the web app, served to itself`

### Task E2: Native-only bridge, tokens not paths

**Files:**
- Modify: `src/main/preload.ts`, `src/main/main.ts`, `src/shared/types.ts` (`SlicelyDesktopApi` replaces `SlicelyApi`; `IPC` shrinks), `src/web/app.ts` (feature-detect)
- Create: `src/server/routes/local.ts`, `src/server/routes/local.test.ts`

**Interfaces:**
```ts
// shared/types.ts
export interface SlicelyDesktopApi {
  openGcode(token: string): Promise<void>;        // main: store.get("desktop").gcodeFiles.get(token)?.path → shell.openPath
  revealGcode(token: string): Promise<void>;      // shell.showItemInFolder
  openInSlicer(token: string): Promise<void>;     // existing PrusaSlicer GUI open, with the resolved path
  pickFiles(): Promise<string[]>;                 // dialog.showOpenDialog filtered to ACCEPTED_UPLOAD_EXTS → absolute paths
  pathsForDrop(files: File[]): string[];          // webUtils.getPathForFile, synchronous
  version(): string;
}
declare global { interface Window { slicely?: SlicelyDesktopApi } }
// POST /api/attach-local { paths: string[] } — desktop only (hosted → 403 forbidden_in_hosted_mode);
// each path must exist, have an accepted extension, and be inside homedir(); copied into session.uploadsDir;
// response shape identical to POST /api/upload.
```
Web client: on drop/pick, when `window.slicely` exists → `pathsForDrop`/`pickFiles` → `POST /api/attach-local`; otherwise the existing multipart upload. "Open in PrusaSlicer" / "Reveal in Finder" buttons render only when `window.slicely` exists.

- [ ] **Step 1: Failing test:** hosted → `POST /api/attach-local` 403; desktop with a temp `.stl` under `homedir()` → 200 and the file appears in the session's `uploads/`; a path under `/etc` → 400; a `.exe` → 400.
- [ ] **Step 2–4:** FAIL → implement → PASS. Manual: drag an STL onto the Mac app → attaches via `/api/attach-local` (check the network panel).
- [ ] **Step 5: Commit** — `slicely-v3: the Mac app keeps only what needs a Mac`

### Task E3: Delete the old renderer

**Files:**
- Delete: `src/renderer/` (all)
- Modify: `scripts/copy-assets.mjs` (no renderer copy; only verify `dist-web/web` exists), `tsconfig.renderer.json` (`include` drops `src/renderer/**`), `package.json` `build.files` (add `dist-web/**`, `src/web/*.html`, `src/web/*.css`, `site/terms.html`, `site/privacy.html`, `site/favicon.svg`), README "How it's built"

- [ ] **Step 1:** `git rm -r src/renderer`; edit configs; `npm run build && npm run test:only` green; `npm start` still loads.
- [ ] **Step 2:** Commit — `slicely-v3: one UI — the old renderer is gone`

---

## Workstream F — Web client: split, a11y, states, onboarding

Runs in its own worktree in parallel with B–D. It depends only on these contracts: `GET /api/config`, `PUT/DELETE /api/key`, `DELETE /api/session` (B4); `POST /api/chats/:id/activate` and `POST /api/printers/discover` (D7); error bodies `{ error, code }`; and the `AgentEvent` error variant gaining `code?: string`. Until the server side lands, stub them in a tiny dev shim if needed, but do not commit the shim.

### Task F1: Split `app.ts` into modules (no behaviour change)

**Files:**
- Create: `src/web/api.ts`, `src/web/ui.ts`, `src/web/markdown.ts`, `src/web/cards.ts`, `src/web/chat.ts`, `src/web/jobs.ts`, `src/web/printers.ts`, `src/web/settings.ts`
- Modify: `src/web/app.ts` (boot + wiring only), `src/web/index.html` (script stays `/web/app.js`, `type="module"`)

**Interfaces (exports):**
```ts
// api.ts
export class ApiError extends Error { status: number; code?: string }
export function getJson<T>(url: string): Promise<T>;
export function postJson<T>(url: string, body: unknown): Promise<T>;
export function patchJson<T>(url: string, body: unknown): Promise<T>;
export function del(url: string): Promise<void>;
export function streamSse(url: string, body: unknown, onEvent: (e: unknown) => void, signal?: AbortSignal): Promise<void>;
// ui.ts
export function byId<T extends HTMLElement>(id: string): T;
export function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K];
export function toast(msg: string, kind?: "info" | "error" | "success"): void;
export function openSheet(id: "settings" | "chats" | "jobs"): void;
export function closeSheets(): void;
export function menu(trigger: HTMLElement, items: Array<{ id: string; label: string; hint?: string; disabled?: boolean }>, onPick: (id: string) => void): void; // role=menu, arrow keys, Esc, focus return
export function confirmDialog(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean>; // role=alertdialog, focus trap
export function errorCard(message: string, retry?: () => void): HTMLElement;
export function skeleton(rows: number): HTMLElement;
// markdown.ts  export function renderMarkdownLite(text: string): DocumentFragment;
// cards.ts     export function buildCard(...); export function renderMetrics(...); export function renderInfo(...);
// chat.ts      export function initChat(deps: ChatDeps): { send(text: string): Promise<void>; cancel(): void; handleAgentEvent(e: AgentEvent): void }
// jobs.ts      export function initJobs(deps: JobsDeps): void
// printers.ts  export function initPrinters(deps: PrintersDeps): { refresh(): Promise<void> }
// settings.ts  export function initSettings(deps: SettingsDeps): { load(): Promise<void> }
```
Rule: no module reaches into another's DOM; shared elements are passed via `deps` at init.

- [ ] **Step 1:** Move code section by section using the audit's line map (117-183 → api; 190-273 → markdown; 26-114 + 542-550 + sheet code → ui; 552-916 → cards; 275-540 + 1363-1610 → chat; 917-1310 → jobs; 1899-2288 → printers; 1689-1898 + 2289-2364 → settings). After each move: `npm run typecheck` green.
- [ ] **Step 2:** Verify with the `browser-automation` skill against `npm run serve` (hosted, `SLICELY_MASTER_KEY` set): page loads, zero console errors, settings sheet opens, chats sheet opens.
- [ ] **Step 3:** Commit — `slicely-v3: the web client in eight files instead of one`

### Task F2: Onboarding, the key card, and the consent line

**Files:**
- Create: `src/web/onboarding.ts`
- Modify: `src/web/index.html`, `src/web/styles.css`, `src/web/settings.ts` (new "AI", "Data", "About" sections), `src/web/chat.ts` (`no_key` / `key_rejected` errors open the key card)

**Behaviour:**
- On boot `GET /api/config`. If `!hasKey`: the empty state shows three steps — **1. Connect your Claude key** (card inline) → **2. Tell it what to print** → **3. Connect a printer (optional)**. The composer stays enabled for search and paste-link; the send button's tooltip says "Connect a key to chat".
- Key card copy (exact):
  > **Use your own AI account.** Slicely runs on your own Anthropic API key. Usage is billed by Anthropic directly to you at their standard API rates; Slicely never pays for or resells AI usage.
  > Paste a key from console.anthropic.com → Settings → API keys. We suggest a personal key with an expiry. Your key is encrypted on the server and only ever sent to Anthropic.
  > Claude Pro/Max subscriptions can't be used here — Anthropic allows subscription logins only in its own apps. An API account is separate and pay-as-you-go.
  Input `type="password"` with a show toggle, `autocomplete="off"`, `spellcheck="false"`. Submit → `PUT /api/key`; 400 → the format message; 401 → "Anthropic rejected that key"; 200 → toast "Key connected · …a1b2", card collapses.
- Settings → **AI**: "Connected key: …a1b2 · Replace · Remove". **Data**: "Delete my data" → `confirmDialog` → `DELETE /api/session` → reload. **About**: version, "Source (this build)" → `repoUrl/tree/<sourceCommit>`, Terms, Privacy.
- First-visit line above the composer (dismissible, remembered in `localStorage`): "By continuing you agree to the Terms and Privacy Policy." with links.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `browser-automation`: fresh session → key card visible; submit `hello` → format error; submit a well-formed but fake key → 401 rejection shown; confirm the network log shows the key only in the PUT request body.
- [ ] **Step 3:** Commit — `slicely-v3: connect your own key in a minute, and know what it means`

### Task F3: Accessibility — menus, dialogs, labels

**Files:** `src/web/ui.ts`, `src/web/index.html`, `src/web/settings.ts`, `src/web/cards.ts`

- Menus (model/effort/any `.menu-item`) become `<button role="menuitem">` inside `role="menu"`; ArrowUp/Down/Home/End/Esc; `aria-expanded` on the trigger; focus returns on close.
- Sheets: `role="dialog" aria-modal="true" aria-labelledby`; focus trap (port from `site/main.js` lines 79-96); Esc closes; focus restored.
- Icon buttons get `aria-label` (keep `title`). Thumbnails get `alt="<model title>"`. Toast container is `aria-live="polite"`.
- [ ] Verify with `browser-automation`: Tab to the settings trigger, Enter opens, Tab cycles inside, Esc closes and focus returns (assert `document.activeElement.id`).
- [ ] Commit — `slicely-v3: the whole UI works from the keyboard`

### Task F4: Confirmations and truthful printer state

**Files:** `src/web/printers.ts`, `src/web/chat.ts`, `src/shared/printers.ts` (if `autoStart` is not already on `PrinterConnection`, add `autoStart: boolean` and populate it in `listPrinters()`)

- `confirmDialog` before: remove printer ("Remove <label>? Its saved credentials are deleted."), arm auto-start ("Prints will start the moment they're sent to <label>. Only arm this if you always clear the bed. You can disarm at any time."), delete chat.
- Armed state comes from the server, never a local mirror. Poll interval computed inside the tick: 15 s normally, 4 s while the settings sheet is open.
- Send-button label restore uses the button's own reference and is skipped if it is detached.
- [ ] Verify: arm → reload → still shows armed. Commit — `slicely-v3: dangerous switches ask first, and the UI stops guessing`

### Task F5: Loading, empty, error states; mobile polish

**Files:** `src/web/settings.ts`, `src/web/printers.ts`, `src/web/chat.ts`, `src/web/styles.css`

- Every list (`printers`, `sources`, `chats`, `jobs`, `discovered`): `skeleton()` while loading → content, an explicit empty message, or `errorCard(msg, retry)`. No `catch {}` that leaves the UI silent.
- Chat errors render as `.error-card` in the transcript (message + Retry that re-sends the last user message), not a coloured bubble.
- CSS: composer `padding-bottom: calc(12px + env(safe-area-inset-bottom))`; header pill row wraps under 480px; `@media (min-width: 1024px)` layout (max-width 860px); `body.is-desktop` (set when `window.slicely` exists) gives the header `-webkit-app-region: drag` and its controls `no-drag`.
- [ ] Verify at 400px and 1280px with `browser-automation` screenshots. Commit — `slicely-v3: every list says loading, empty, or failed — and it fits a phone`

### Task F6: Web client uses the new endpoints

**Files:** `src/web/api.ts`, `src/web/settings.ts`, `src/web/printers.ts`, `src/web/chat.ts`

- Multi-user comes from `config.multiUser`, not the 403 probe; switching chats → `POST /activate`; discovery → `POST`; `ApiError.code` drives copy (`rate_limited` → "Slow down a little — try again in a few seconds").
- [ ] Verify: hosted server, zero console errors through search → settings → chats. Commit — `slicely-v3: the client speaks the new API`

---

## Workstream G — Landing page

Static site, no build step (spec §6). `site/config.js` is the only place URLs live.

### Task G1: Config, copy, structure

**Files:**
- Create: `site/config.js`
- Modify: `site/index.html`, `site/main.js` (remove the waitlist modal + Apps Script submit; keep reveal + reduced-motion), `site/favicon.svg` (the `◆` mark on the dark canvas)
- Delete: `site/apps-script.gs`; rewrite `site/README.md`

**Interfaces:**
```js
// site/config.js
window.SLICELY_SITE = {
  APP_URL: "https://app.slicely.example",           // placeholder until the Fly app exists — owner fills in
  DOWNLOAD_URL: "https://github.com/ishmael07/slicely/releases/latest",
  REPO_URL: "https://github.com/ishmael07/slicely",
  CONTACT_EMAIL: "{{CONTACT_EMAIL}}",
};
```
`main.js` sets every `[data-href="APP_URL"]` etc. from that object on load.

**Sections and copy (in order):**
1. **Nav**: `◆ Slicely` · How it works · Features · Web or Mac · GitHub · **Open the web app** (primary).
2. **Hero**: eyebrow "AI for 3D printing · bring your own Claude key"; H1 "Type what you want to print."; lead "Slicely finds it across 11 model sites, works out how to slice it for your printer, and sends it over. No CAD, no settings rabbit hole."; CTAs **Open the web app** / **Download for Mac** with microcopy under the second: "macOS 13+ · Apple silicon & Intel · unsigned build for now: right-click → Open"; hero animation (G2).
3. **How it works** (4 steps): Connect your key → Say what you want (or paste a link / drop a file) → Slicely finds, orients, slices → Send to your printer. Callout under step 4: "Prints never start on their own. You arm that per printer, and only you can."
4. **Features** (10 cards, scroll-reveal): 11 sources · Paste any link · Upload your own · Smart orientation · Slice for your goal · Big multi-part jobs · Multi-colour · Six ways to reach a printer · Chat history · Pick your model & effort. One sentence each, lifted from README capability rows.
5. **Web or Mac** — comparison table from README (Install / Who / Slicing / Cloud printers / LAN printers / Open in PrusaSlicer GUI).
6. **Bring your own AI** — the exact key wording from spec §7 (three short paragraphs).
7. **Requirements** — PrusaSlicer on Mac; a browser on the web; an Anthropic API key.
8. **Footer** — Terms · Privacy · Source (GitHub) · MIT · Made by ishmael07 · "PrusaSlicer is a trademark of Prusa Research; Slicely is not affiliated."

`<head>`: `<link rel="canonical">`, `og:title/description/image/url/site_name`, `twitter:card summary_large_image`, `theme-color`, `<link rel="icon" href="favicon.svg">`. Self-host Inter (`site/fonts/inter-latin-400.woff2`, `-600.woff2`, `-700.woff2`; download from the Inter GitHub release and `@font-face` them; fallback stack `system-ui, -apple-system, Segoe UI, Roboto, sans-serif`).

- [ ] **Step 1:** Implement. **Step 2:** `browser-automation` on `python3 -m http.server` in `site/`: no console errors; all `data-href` links resolved; renders at 400px and 1280px; `prefers-reduced-motion` disables the reveal (emulate via CDP if the skill supports it, else read the CSS).
- [ ] **Step 3:** Commit — `slicely-v3: the landing page says what Slicely is now`

### Task G2: The hero animation

**Files:** `site/index.html` (hero mockup markup), `site/styles.css` (keyframes)

A single looping ~9 s pure-CSS sequence inside a phone-width "app" frame:
1. 0–2.2 s: a typed prompt appears character-by-character ("print me a phone stand, sturdy") via `steps()` on a `width` animation of a monospace span with a blinking caret.
2. 2.2–4.5 s: a model card slides up (thumbnail block, title "Phone Stand (Printables)", licence pill).
3. 4.5–7 s: a metrics panel fills — three bars animate to width (Time 1h 42m · Filament 18 g · Layers 210) with a small "orientation: flat, no supports" note.
4. 7–8.6 s: a pill "Sent to Ender 3 ✓" pops in.
5. 8.6–9 s: fade out, loop.
Everything is `animation-play-state: paused` under `prefers-reduced-motion: reduce` with the final frame shown. GPU-cheap: transforms and opacity only, plus the two `width` animations (short, on small elements).

- [ ] **Step 1:** Implement. **Step 2:** Screenshot at 0 s, 3 s, 6 s, 8 s via `browser-automation` and eyeball the four states. **Step 3:** Commit — `slicely-v3: a nine-second demo of the whole loop`

### Task G3: `og.png`, `robots.txt`, `sitemap.xml`

**Files:** `site/og.png` (1200×630), `site/robots.txt`, `site/sitemap.xml`, `scripts/make-og.mjs` (renders `site/og.html` to PNG via the headless browser the `browser-automation` skill drives; commit the PNG, keep the script)

- [ ] `robots.txt`: `User-agent: *` / `Allow: /` / `Sitemap: <canonical>/sitemap.xml`. `sitemap.xml` lists `/`, `/terms.html`, `/privacy.html`.
- [ ] Commit — `slicely-v3: share cards and crawler basics for the site`

---

## Workstream H — Legal

### Task H1: Terms, Privacy, Acceptable Use, AGPL source link

**Files:**
- Create: `site/terms.html`, `site/privacy.html` (both use `site/styles.css` + a small `.legal` layout; both begin with a visible note "Template — not legal advice. Have a lawyer review before launch." **inside an HTML comment AND as a small banner the owner deletes after review**)
- Modify: `site/index.html` footer, `src/server/static.ts` mapping (D8), `src/server/LICENSING.md`

**Terms of Service must cover (headings, in order):** 1 Acceptance · 2 The service (find, slice, send; no CAD; provided as-is) · 3 Your Anthropic account and key (you own it, you pay Anthropic, you may revoke any time; we store it encrypted; we never resell usage) · 4 **3D printing safety** (you are solely responsible for your printer, materials, ventilation, bed clearance and supervision; FDM printers are a fire risk; Slicely never starts a print unless you arm auto-start for that printer; slice settings are suggestions and may be wrong; check the preview) · 5 Third-party models and licences (each model carries its author's licence, shown in the app; you must comply; we do not host models; takedown contact) · 6 Acceptable use (no unlawful items, no weapons or regulated parts where prohibited, no circumventing source-site protections or rate limits, no abuse, no attempting to access other users' data) · 7 Your content (uploads stay yours; you grant us the licence needed to process them; deleted with your session) · 8 Availability and changes · 9 Disclaimer of warranties · 10 Limitation of liability (cap: the greater of $0 paid to us and $100) · 11 Indemnity · 12 Termination · 13 Governing law `{{JURISDICTION}}` · 14 Changes to these terms · 15 Contact `{{CONTACT_EMAIL}}`. Effective `{{EFFECTIVE_DATE}}`, operated by `{{ENTITY}}`.

**Privacy Policy must cover:** what we collect (a session cookie; your chats; files you upload, paste links to, or import; sliced output; printer connection details and credentials, encrypted; your Anthropic API key, encrypted; server logs with IP and timestamps for 14 days) · what we do not collect (no analytics, no ads, no account, no email on the app) · where it lives (hosted: our server's encrypted volume in the region shown at `/api/config`; Mac app: only on your Mac) · who receives it (Anthropic — your prompts and files' derived text, under your own key and Anthropic's terms; the model sites you search; your printer or cloud print service; no one else) · retention (hosted: sessions expire after 30 days idle; workspace files after 2 h idle; "Delete my data" removes everything immediately) · your rights (access/deletion via the button or `{{CONTACT_EMAIL}}`; GDPR/UK GDPR/CCPA statements) · children (not for under-16s) · changes · contact.

- [ ] **Step 1:** Write both pages. **Step 2:** Serve via `npm run serve` → `GET /terms` and `GET /privacy` render with the site stylesheet; footer links from the app's Settings → About resolve. **Step 3:** Commit — `slicely-v3: terms and privacy, as templates for a lawyer to finish`

---

## Workstream I — Mac packaging

### Task I1: Icon, entitlements, builder config

**Files:**
- Create: `build/icon.icns`, `build/icon.png` (1024²), `build/entitlements.mac.plist`, `scripts/make-icon.sh`
- Modify: `package.json` (`build` block), `.gitignore` (`release/` already ignored)

`scripts/make-icon.sh`: renders `site/favicon.svg` to `build/icon.png` with `qlmanage -t -s 1024 -o` (macOS built-in), then builds an `.iconset` with `sips -z` at 16/32/64/128/256/512/1024 (+@2x) and `iconutil -c icns`. Commit the outputs.

```json
"build": {
  "appId": "dev.ishmael.slicely",
  "productName": "Slicely",
  "asar": true,
  "npmRebuild": false,
  "files": ["dist/**/*", "dist-web/**/*", "src/web/*.html", "src/web/*.css", "site/terms.html", "site/privacy.html", "site/favicon.svg", "package.json", "!**/*.map", "!**/*.test.js"],
  "mac": {
    "category": "public.app-category.graphics-design",
    "icon": "build/icon.icns",
    "target": [{ "target": "dmg", "arch": ["universal"] }, { "target": "zip", "arch": ["universal"] }],
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": false,
    "extraResources": [{ "from": "build/How to open.txt", "to": "How to open.txt" }]
  },
  "dmg": { "contents": [{ "x": 130, "y": 220 }, { "x": 410, "y": 220, "type": "link", "path": "/Applications" }] },
  "publish": { "provider": "github", "owner": "ishmael07", "repo": "slicely" }
}
```
Entitlements: `com.apple.security.cs.allow-jit`, `com.apple.security.network.client`, `com.apple.security.network.server` (loopback), `com.apple.security.files.user-selected.read-write`. Scripts: `"dist:mac": "npm run build && electron-builder --mac"`, `"release:mac": "npm run build && electron-builder --mac --publish always"`. `afterSign` notarization is enabled only when `APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID` are set (`scripts/notarize.cjs`, using electron-builder's built-in `notarize: { teamId }` toggled from env in a `beforeBuild`-free way: read env in `scripts/electron-builder.config.cjs` and point `package.json` `build` at it via `--config`).

`build/How to open.txt`: "This build isn't signed with an Apple Developer ID yet. First launch: right-click Slicely.app → Open → Open. Or: System Settings → Privacy & Security → Open Anyway. Source: <REPO_URL>."

- [ ] **Step 1:** `npm run dist:mac` → `release/Slicely-<v>-universal.dmg` exists, is < 150 MB, and `Slicely.app/Contents/Resources/icon.icns` is ours (open the DMG, check the icon). Launch the built app: it boots the loopback server and shows the UI.
- [ ] **Step 2:** Commit — `slicely-v3: a Mac build with our icon, half the size, ready to sign later`

### Task I2: Release notes and download wiring

**Files:** `docs/RELEASING.md` (steps: bump version, `npm run release:mac`, GitHub Release notes template, update `site/config.js` `DOWNLOAD_URL` if not using `/releases/latest`), `README.md` (Download section)

- [ ] Commit — `slicely-v3: how a Mac release ships`

---

## Workstream J — Deployment

### Task J1: Dockerfile with headless PrusaSlicer

**Files:** `Dockerfile`, `.dockerignore`

```Dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json scripts ./
COPY src ./src
COPY site ./site
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ARG PRUSASLICER_VERSION=2.9.2
ARG SOURCE_COMMIT=dev
ENV SLICELY_MODE=hosted SLICELY_WORKDIR=/data SLICELY_TRUST_PROXY=1 SLICELY_PORT=8080 \
    PRUSASLICER_PATH=/opt/prusaslicer/AppRun SLICELY_SOURCE_COMMIT=${SOURCE_COMMIT} NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libgtk-3-0 libgl1 libglu1-mesa libegl1 libwebkit2gtk-4.1-0 libdbus-1-3 xvfb \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/ps.AppImage \
      "https://github.com/prusa3d/PrusaSlicer/releases/download/version_${PRUSASLICER_VERSION}/PrusaSlicer-${PRUSASLICER_VERSION}+linux-x64-GTK3-$(date +%Y%m%d 2>/dev/null | cut -c1-0)*.AppImage" \
    || true
# The asset name carries a build date; resolve it via the GitHub API instead of guessing:
RUN set -eux; url=$(curl -fsSL "https://api.github.com/repos/prusa3d/PrusaSlicer/releases/tags/version_${PRUSASLICER_VERSION}" \
      | grep browser_download_url | grep 'linux-x64-GTK3' | grep -v 'bgcode\|older' | head -1 | cut -d '"' -f 4); \
    curl -fsSL -o /tmp/ps.AppImage "$url"; chmod +x /tmp/ps.AppImage; \
    cd /tmp && ./ps.AppImage --appimage-extract >/dev/null && mv squashfs-root /opt/prusaslicer && rm /tmp/ps.AppImage; \
    /opt/prusaslicer/AppRun --help >/dev/null
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/src/web ./src/web
COPY --from=build /app/site ./site
RUN useradd -r -u 10001 slicely && mkdir -p /data && chown -R slicely /data /app
USER slicely
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server/index.js"]
```
(Delete the first, guessing `RUN curl … || true` line — it is only there to show the failure mode; the GitHub-API resolution is the real step.) If `AppRun --help` needs a display, prefix with `xvfb-run -a`; the slicer CLI is invoked the same way in `prusaslicer.ts` when `SLICELY_XVFB=1` — add that flag.

- [ ] **Step 1:** `docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t slicely .` succeeds; `docker run --rm -e SLICELY_MASTER_KEY=$(node scripts/gen-master-key.mjs | cut -d= -f2) -p 8080:8080 slicely` → `curl localhost:8080/healthz` ok; `curl localhost:8080/api/config` → `mode: "hosted"`, `slicerAvailable: true`, `sourceCommit` = the commit.
- [ ] **Step 2:** Commit — `slicely-v3: one container with a headless PrusaSlicer inside`

### Task J2: `fly.toml` and `docs/DEPLOY.md`

**Files:** `fly.toml`, `docs/DEPLOY.md`

```toml
app = "slicely"            # owner renames
primary_region = "iad"
[build]
  [build.args]
    SOURCE_COMMIT = "set by deploy script"
[env]
  SLICELY_MODE = "hosted"
  SLICELY_WORKDIR = "/data"
  SLICELY_TRUST_PROXY = "1"
  SLICELY_PORT = "8080"
  SLICELY_MAX_SLICES = "2"
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false   # sessions are in memory
  auto_start_machines = true
  min_machines_running = 1
  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "GET"
    path = "/healthz"
[mounts]
  source = "slicely_data"
  destination = "/data"
[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
```
`docs/DEPLOY.md`: `fly launch --no-deploy`, `fly volumes create slicely_data --size 10`, `fly secrets set SLICELY_MASTER_KEY=… THINGIVERSE_APP_TOKEN=… GITHUB_TOKEN=… MYMINIFACTORY_API_KEY=… SMITHSONIAN_API_KEY=…`, `fly deploy --build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`, custom domain + certs, then set `APP_URL` in `site/config.js`. A section "What to check after deploy": `/api/config`, upload → slice → gcode download, key card, `/terms`. A section "Single machine only" explaining why (in-memory sessions).

- [ ] Commit — `slicely-v3: deploy to Fly in six commands`

### Task J3: `.env.example`, README refresh

Covered by D9 + I2; this task is the final consistency pass: every env var in code appears in README and `.env.example`, `ANTHROPIC_API_KEY` appears nowhere except the "Bring your own key" explanation.

- [ ] `grep -rhoE 'process\.env\.[A-Z_]+' src | sort -u` vs README table — reconcile. Commit — `slicely-v3: the README matches the code again`

---

## Workstream K — Verification and merge

### Task K1: Full verification

- [ ] `npm run typecheck && npm run build && npm run test:only` → all green; record the totals.
- [ ] `npm audit --omit=dev` → no high/critical.
- [ ] `browser-automation` end-to-end on the hosted build (with `SLICELY_MASTER_KEY`): landing page (site/) → app: key card → reject fake key → settings/chats/jobs sheets → a search ("phone stand") returns cards → upload a small STL → slice → gcode download link works → Delete my data → workspace gone. Zero console errors. Screenshots at 400px and 1280px saved to the scratchpad.
- [ ] Electron: `npm start` → UI loads, `mode: "desktop"`, drop an STL → attaches, "Open in PrusaSlicer" button present; `npm run dist:mac` → DMG; open the DMG'd app once.
- [ ] Docker: J1 checks.
- [ ] Security spot-checks with curl against the hosted build: forged cookie rotation → 429 after burst; `POST /api/import {url: "http://127.0.0.1:8080/healthz"}` → blocked; `GET /web/app.js.map` → 404; `Origin: https://evil.example` POST → 403; two cookies cannot see each other's printers.

### Task K2: Merge

- [ ] Use `superpowers:finishing-a-development-branch`: `slicely-v3` → `main` (the public repo's default). Squash is **not** required; keep the story. Push. Tag `v0.2.0`.
- [ ] Owner follow-ups (not code): Fly account + `fly launch`; domain; fill `{{ENTITY}}`/`{{CONTACT_EMAIL}}`/`{{JURISDICTION}}`; lawyer review of `site/terms.html` and `site/privacy.html`; Apple Developer ID when ready; rotate any Anthropic key that was ever in a `.env` on a shared machine.

---

## Self-review (done while writing)

- **Spec coverage:** §1 → B2–B4, F2; §2 → C1–C4; §3 table → D1–D9 (+B1 mode, C2 dispose, B4 delete-session); §4 → E1–E3; §5 → F1–F6; §6 → G1–G3; §7 → H1 (+D9 LICENSING, B4 sourceCommit, F2 About); §8 → I1–I2; §9 → J1–J3; testing → every task + K1. Out-of-scope items are not planned.
- **Type consistency:** `WireError(status, message, code)` (B4) is what D2/D4/D5 throw; `isPrivateAddress` is exported from `sourcing/net.ts` (D3) and imported in `printers/util.ts` (D4); `disposeSessionUserKey` (B3) and `disposeSessionPrinters` (D1) are the names C2's `destroy` calls; `CSP_STRING` is exported in D6 and used in E1; `sessionFile()` already exists in `session-context.ts` and is used by B3 and D1; `cookieName()` (D6) is used by C1's key function only through `req.session.id`, so the limiter never parses cookies itself.
- **Placeholders:** the only `{{…}}` tokens are the intentional legal placeholders; `APP_URL` is a documented owner-filled value.
