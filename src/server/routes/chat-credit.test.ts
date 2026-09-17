// Who pays for a chat turn, answered BEFORE the SSE headers — and what the
// meter does to the balance once the turn is under way.
//
// Hermetic, like routes/config-accounts.test.ts (whose harness this borrows): an
// ephemeral loopback server, a temp-dir-backed session store, a workdir under
// $TMPDIR, and "keys" that are syntactically valid strings nothing ever sends.
// The metering cases build a REAL SlicelyAgent around a FAKE provider, because
// the thing under test is the loop's charging, not the SSE plumbing — the route
// hands the agent factory its funding resolver precisely so a test can do that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { randomBytes } from "node:crypto";
import { createApp } from "../index";
import { SessionStore, bindAccountToSession, type ChatAgent } from "../session";
import { DESKTOP_HEADER } from "../desktop-token";
import { runInSession, sessionContext } from "../../main/session-context";
import { setUserApiKey } from "../../main/userkey";
import { resetConfigForTests } from "../../main/config";
import { resetKeyVaultForTests } from "../../main/keyvault";
import { centsToMicros, type TurnUsage } from "../../main/pricing";
import {
  findOrCreateAccount, getAccount, resetAccountsForTests, writeAccount, type Account,
} from "../../main/accounts/store";
import { resetMeterForTests } from "../../main/accounts/meter";
import { spendFile, usageFile, utcDay } from "../../main/accounts/paths";
import { resetFundingForTests, type TurnFunding } from "../../main/agent/funding";
import { SlicelyAgent } from "../../main/agent/agent";
import { getProvider } from "../../main/agent/provider";
import type { NeutralBlock, Provider, StreamRequest, TurnResult } from "../../main/agent/provider";

process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

const TOKEN = "token-for-this-launch";
const OWNER_ANTHROPIC = "sk-ant-api03-" + "o".repeat(40);
const USER_ANTHROPIC = "sk-ant-api03-" + "u".repeat(40);

/** The spec §4.3 worked example: 4,714,000 µ¢ on claude-sonnet-5. */
const SPEC_USAGE: TurnUsage = {
  inputTokens: 8_670,
  cachedInputTokens: 18_000,
  cacheWriteTokens: 6_000,
  outputTokens: 1_120,
};

interface Frame {
  type: string;
  [other: string]: unknown;
}

// ── the harness ──────────────────────────────────────────────────────────────

const OAUTH_ENV = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "SLICELY_PUBLIC_URL",
] as const;

function clearEnv(): void {
  for (const name of OAUTH_ENV) delete process.env[name];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SLICELY_FREE_MODEL;
  process.env.SLICELY_MODE = "hosted";
}

/** Accounts on: a public URL to build redirect URIs from, one OAuth provider,
 *  and the owner key the free tier is spent from. */
function accountsOn(): void {
  process.env.SLICELY_PUBLIC_URL = "https://app.test";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-value";
  process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface HarnessOptions {
  /** Environment for this case, applied before any cache is built. */
  setup?: () => void;
  /** The agent factory. Default: a stub that streams one `done` and records the
   *  calls, so a refusal can be proved to have reached no provider. */
  factory?: (resolveFunding: () => TurnFunding) => ChatAgent;
  /** Loosen the `chat` bucket — most cases here are about credit, not rate
   *  limits, and the real tier (6 per 2 minutes) would refuse the seventh turn. */
  chatBurst?: number;
  /** How fast that bucket refills. The default is brisk on purpose, but a case
   *  that means to see a REFUSAL must outlive its own first request: a capacity-1
   *  bucket at 100/s is full again 10 ms later, and a full SSE turn under
   *  full-suite load takes longer than that, so the second request would find a
   *  refilled bucket and pass 200. Such a case sets this near zero. */
  chatRefillPerSec?: number;
}

interface Harness {
  base: string;
  store: SessionStore;
  workdir: string;
  cookie: string;
  /** How many times the agent factory was asked for an agent. */
  agents: number;
  close: () => Promise<void>;
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), "slicely-chat-credit-"));
  process.env.SLICELY_WORKDIR = workdir;
  clearEnv();
  opts.setup?.();
  resetConfigForTests();
  resetAccountsForTests();
  resetMeterForTests();
  resetFundingForTests();

  const store = new SessionStore({
    sessionsRoot: join(workdir, "sessions"),
    secretDir: workdir,
    desktopDir: join(workdir, "desktop"),
    sweepIntervalMs: 0,
  });
  const h: Harness = {
    base: "",
    store,
    workdir,
    cookie: "",
    agents: 0,
    close: async () => undefined,
  };
  const factory = (resolveFunding: () => TurnFunding): ChatAgent => {
    h.agents += 1;
    return (opts.factory ?? stubAgent)(resolveFunding);
  };
  const app = createApp({
    sessionStore: store,
    chatAgentFactory: factory,
    desktopToken: TOKEN,
    limits: { chat: { capacity: opts.chatBurst ?? 200, refillPerSec: opts.chatRefillPerSec ?? 100 } },
  });
  const { base, close } = await listen(app);
  h.base = base;
  const boot = await fetch(`${base}/api/config`, { headers: { [DESKTOP_HEADER]: TOKEN } });
  assert.equal(boot.status, 200);
  h.cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
  h.close = async () => {
    await close();
    store.stopSweep();
    clearEnv();
    resetConfigForTests();
    rmSync(workdir, { recursive: true, force: true });
  };
  return h;
}

/** A stub that never reaches a provider — what a refusal test proves untouched. */
const stubAgent = (): ChatAgent => ({
  async send(_message, emit) {
    emit({ type: "text", text: "ok" });
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised here */
  },
});

function sessionId(cookie: string): string {
  return decodeURIComponent(cookie.split("=")[1].split(".")[0]);
}

/** Sign a cookie's session in, and return the account it now belongs to. */
function signIn(h: Harness, cookie = h.cookie): Account {
  const { account } = findOrCreateAccount(
    {
      provider: "google",
      providerUserId: "107812345",
      email: "jane@example.com",
      normalizedEmail: "jane@example.com",
      name: "Jane Doe",
    },
    centsToMicros(50),
  );
  bindAccountToSession(h.store.get(sessionId(cookie))!, account.id);
  return account;
}

/** A second browser on the SAME account — what the per-account limiter bucket
 *  and `countChatTurn` exist for. */
async function secondCookie(h: Harness, accountId: string): Promise<string> {
  const boot = await fetch(`${h.base}/api/config`, { headers: { [DESKTOP_HEADER]: TOKEN } });
  const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
  bindAccountToSession(h.store.get(sessionId(cookie))!, accountId);
  return cookie;
}

/** Store a BYO key for a session, the way PUT /api/key does (minus the live
 *  validation call, which is not what these cases are about). */
function connectKey(h: Harness, provider: "anthropic" | "openai", key: string): void {
  const session = h.store.get(sessionId(h.cookie))!;
  runInSession(sessionContext(session.id, session.dir), () => setUserApiKey(provider, key));
}

async function chat(h: Harness, cookie = h.cookie, message = "find me a phone stand"): Promise<{
  status: number;
  contentType: string;
  retryAfter: string | null;
  json?: { error?: string; code?: string };
  frames: Frame[];
}> {
  const resp = await fetch(`${h.base}/api/chat`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", [DESKTOP_HEADER]: TOKEN },
    body: JSON.stringify({ message }),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const retryAfter = resp.headers.get("retry-after");
  const text = await resp.text();
  if (!contentType.includes("text/event-stream")) {
    return {
      status: resp.status,
      contentType,
      retryAfter,
      json: text ? (JSON.parse(text) as { error?: string; code?: string }) : undefined,
      frames: [],
    };
  }
  const frames = text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as Frame);
  return { status: resp.status, contentType, retryAfter, frames };
}

/** A provider that replays scripted turns (usage included) and records what it
 *  was asked for. The real provider supplies the parts a fake need not invent. */
function fakeProvider(turns: TurnResult[]): Provider & { seen: StreamRequest[] } {
  const real = getProvider("anthropic");
  const seen: StreamRequest[] = [];
  let i = 0;
  return {
    id: "anthropic",
    label: real.label,
    keyPattern: real.keyPattern,
    keyHelp: real.keyHelp,
    maxOutputTokens: real.maxOutputTokens,
    seen,
    async stream(req, emit) {
      seen.push(structuredClone(req) as StreamRequest);
      const turn = turns[i++] ?? { assistant: [{ type: "text", text: "done." }], toolCalls: [] };
      for (const block of turn.assistant) {
        if (block.type === "text") emit({ type: "text", text: block.text });
      }
      return turn;
    },
    async validateKey() {
      return "ok";
    },
    classifyError: real.classifyError,
  };
}

/** One text turn that reports `usage`. */
function textTurn(text: string, usage?: TurnUsage): TurnResult {
  const assistant: NeutralBlock[] = [{ type: "text", text }];
  return usage ? { assistant, toolCalls: [], usage } : { assistant, toolCalls: [] };
}

/** A turn that asks for the one tool needing neither network nor model file. */
function toolTurn(id: string, usage?: TurnUsage): TurnResult {
  const assistant: NeutralBlock[] = [{ type: "tool_use", id, name: "get_slicer_status", input: {} }];
  const calls = [{ id, name: "get_slicer_status", input: {} }];
  return usage ? { assistant, toolCalls: calls, usage } : { assistant, toolCalls: calls };
}

/** The real agent over a fake provider, funded by whatever the route resolved. */
function realAgent(provider: Provider): (resolveFunding: () => TurnFunding) => ChatAgent {
  return (resolveFunding) => new SlicelyAgent({ resolveProvider: () => provider, resolveFunding });
}

function ledgerLines(): string[] {
  const path = usageFile(utcDay());
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function creditFrames(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === "credit");
}

// ── 1. the pre-flight: seven rows, seven answers, and not one SSE byte ────────

test("accounts on, no key, not signed in: 401 signin_required as JSON, before any stream", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const r = await chat(h);
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, "signin_required");
    assert.match(r.contentType, /application\/json/);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
    assert.equal(h.agents, 0, "a refusal must never build an agent");
  } finally { await h.close(); }
});

test("a blocked account is refused 409 account_blocked, with no provider call", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const account = signIn(h);
    account.blocked = true;
    writeAccount(account);
    const r = await chat(h);
    assert.equal(r.status, 409);
    assert.equal(r.json?.code, "account_blocked");
    assert.equal(r.json?.error, "This account can't use Slicely.");
    assert.match(r.contentType, /application\/json/);
    assert.doesNotMatch(r.contentType, /text\/event-stream/);
    assert.equal(h.agents, 0, "a blocked account never reaches a provider");
  } finally { await h.close(); }
});

test("a blocked account with its own key is refused too, still before any provider call", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const account = signIn(h);
    account.blocked = true;
    writeAccount(account);
    connectKey(h, "anthropic", USER_ANTHROPIC);
    const r = await chat(h);
    assert.equal(r.status, 409);
    assert.equal(r.json?.code, "account_blocked");
    assert.equal(h.agents, 0);
  } finally { await h.close(); }
});

test("the day's global spend cap pauses the free tier: 503 free_tier_paused", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    signIn(h);
    // The cap is 500 cents by default; spend all of it, on everyone's behalf.
    writeFileSync(spendFile(utcDay()), JSON.stringify({ version: 1, micros: centsToMicros(500) }));
    resetMeterForTests();
    const r = await chat(h);
    assert.equal(r.status, 503);
    assert.equal(r.json?.code, "free_tier_paused");
    assert.match(r.contentType, /application\/json/);
  } finally { await h.close(); }
});

test("the account's 40 chats for today are spent: 429 rate_limited, with Retry-After", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const account = signIn(h);
    account.chatDay = utcDay();
    account.chatCount = 40;
    writeAccount(account);
    const r = await chat(h);
    assert.equal(r.status, 429);
    assert.equal(r.json?.code, "rate_limited");
    assert.match(r.contentType, /application\/json/);
    assert.ok(r.retryAfter, "a 429 the user can wait out must say how long");
    assert.ok(Number(r.retryAfter) > 0);
  } finally { await h.close(); }
});

test("a spent balance is refused 402 credit_exhausted", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const account = signIn(h);
    account.spentMicros = centsToMicros(50);
    writeAccount(account);
    const r = await chat(h);
    assert.equal(r.status, 402);
    assert.equal(r.json?.code, "credit_exhausted");
    assert.match(r.contentType, /application\/json/);
    assert.equal(h.agents, 0);
  } finally { await h.close(); }
});

test("accounts off and no key: today's 409 no_key, unchanged", async () => {
  const h = await harness();
  try {
    const r = await chat(h);
    assert.equal(r.status, 409);
    assert.equal(r.json?.code, "no_key");
    assert.match(r.contentType, /application\/json/);
  } finally { await h.close(); }
});

test("signed in with credit: 200 text/event-stream", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    signIn(h);
    const r = await chat(h);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.equal(r.frames.at(-1)?.type, "done");
  } finally { await h.close(); }
});

test("a hosted server with an owner key and nobody signed in never reaches the provider", async () => {
  const provider = fakeProvider([textTurn("hello", SPEC_USAGE)]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const r = await chat(h);
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, "signin_required");
    assert.equal(provider.seen.length, 0, "the owner's key is not a free-for-all");
    assert.equal(ledgerLines().length, 0);
  } finally { await h.close(); }
});

// ── 2. a metered turn ────────────────────────────────────────────────────────

test("a metered turn charges the spec's worked example once and reports the balance left", async () => {
  const provider = fakeProvider([textTurn("Here are three stands.", SPEC_USAGE)]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const account = signIn(h);
    const r = await chat(h);
    assert.equal(r.status, 200);

    // The free tier's model, effort and ceiling — never the session's settings.
    assert.equal(provider.seen.length, 1);
    assert.equal(provider.seen[0].model, "claude-sonnet-5");
    assert.equal(provider.seen[0].effort, "medium");
    assert.equal(provider.seen[0].maxOutputTokens, 4_000);
    assert.equal(provider.seen[0].apiKey, OWNER_ANTHROPIC, "the OWNER's key pays for a free turn");

    assert.equal(getAccount(account.id)?.spentMicros, 4_714_000);
    assert.equal(ledgerLines().length, 1, "one provider call, one ledger line");

    const credits = creditFrames(r.frames);
    assert.equal(credits.length, 1, "exactly one credit frame per turn");
    assert.deepEqual(credits[0], {
      type: "credit",
      balanceMicros: 45_286_000,
      balanceLabel: "$0.45",
      exhausted: false,
    });
    // ...and it arrives before `done`, so the pill is right the moment the
    // composer comes back.
    assert.ok(r.frames.indexOf(credits[0]) < r.frames.length - 1);
    assert.equal(r.frames.at(-1)?.type, "done");
  } finally { await h.close(); }
});

test("every iteration of a tool loop is charged, and the turn reports one balance", async () => {
  const provider = fakeProvider([
    toolTurn("t1", SPEC_USAGE),
    textTurn("All set.", SPEC_USAGE),
  ]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const account = signIn(h);
    const r = await chat(h);
    assert.equal(r.status, 200);
    assert.equal(provider.seen.length, 2);
    // The SUM of the turn's calls, not the last one.
    assert.equal(getAccount(account.id)?.spentMicros, 2 * 4_714_000);
    assert.equal(ledgerLines().length, 2);
    const credits = creditFrames(r.frames);
    assert.equal(credits.length, 1);
    assert.equal(credits[0].balanceMicros, 50_000_000 - 2 * 4_714_000);
  } finally { await h.close(); }
});

test("a call the provider reported no usage for is charged nothing", async () => {
  const provider = fakeProvider([textTurn("no receipt for this one")]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const account = signIn(h);
    const r = await chat(h);
    assert.equal(r.status, 200);
    assert.equal(getAccount(account.id)?.spentMicros, 0, "a guessed number is worse than none");
    assert.equal(ledgerLines().length, 0);
    // The balance is still reported — it is a metered turn either way.
    assert.deepEqual(creditFrames(r.frames), [
      { type: "credit", balanceMicros: 50_000_000, balanceLabel: "$0.50", exhausted: false },
    ]);
  } finally { await h.close(); }
});

// ── 3. a key of their own is never metered ───────────────────────────────────

test("a BYO turn on a signed-in session emits no credit event and writes no ledger line", async () => {
  const provider = fakeProvider([textTurn("Here you go.", SPEC_USAGE)]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const account = signIn(h);
    connectKey(h, "anthropic", USER_ANTHROPIC);
    const r = await chat(h);
    assert.equal(r.status, 200);
    assert.equal(provider.seen[0].apiKey, USER_ANTHROPIC, "their key, their bill");
    assert.equal(creditFrames(r.frames).length, 0);
    assert.equal(ledgerLines().length, 0);
    assert.equal(getAccount(account.id)?.spentMicros, 0);
    // And a BYO turn does not spend one of the free chats for the day.
    assert.equal(getAccount(account.id)?.chatCount ?? 0, 0);
  } finally { await h.close(); }
});

// ── 4. the balance running out mid-turn ──────────────────────────────────────

test("a turn that empties the balance mid-loop stops, says so, and lands on zero", async () => {
  // 60,000 output tokens at 1000¢/1M is 60,000,000 µ¢ — more than the whole
  // 50¢ grant, in one call that still asks for a tool.
  const provider = fakeProvider([
    toolTurn("t1", { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 60_000 }),
    textTurn("this call must never happen", SPEC_USAGE),
  ]);
  const h = await harness({ setup: accountsOn, factory: realAgent(provider) });
  try {
    const account = signIn(h);
    const r = await chat(h);
    assert.equal(r.status, 200, "the user already has part of an answer; this is an in-band error");
    assert.equal(provider.seen.length, 1, "the second call is refused by guard(), not attempted");

    const failure = r.frames.find((f) => f.type === "error");
    assert.equal(failure?.code, "credit_exhausted");
    const credits = creditFrames(r.frames);
    assert.deepEqual(credits, [
      { type: "credit", balanceMicros: 0, balanceLabel: "$0.00", exhausted: true },
    ]);
    assert.equal(r.frames.at(-1)?.type, "done");
    // One call's overshoot is charged in full; the balance floors at zero rather
    // than running negative for the next turn to inherit.
    assert.equal(getAccount(account.id)?.spentMicros, 60_000_000);
    assert.equal(ledgerLines().length, 1);
  } finally { await h.close(); }
});

// ── 5. forty chats a day, per ACCOUNT, however many tabs ─────────────────────

test("forty turns are allowed and the forty-first is refused, across two cookies on one account", async () => {
  const h = await harness({ setup: accountsOn });
  try {
    const account = signIn(h);
    const other = await secondCookie(h, account.id);
    // Twenty from each tab: the count belongs to the account, not the browser.
    for (let i = 0; i < 20; i++) {
      assert.equal((await chat(h, h.cookie)).status, 200, `turn ${i} on the first tab`);
      assert.equal((await chat(h, other)).status, 200, `turn ${i} on the second tab`);
    }
    assert.equal(getAccount(account.id)?.chatCount, 40);
    for (const cookie of [h.cookie, other]) {
      const r = await chat(h, cookie);
      assert.equal(r.status, 429, "the forty-first turn is refused on BOTH tabs");
      assert.equal(r.json?.code, "rate_limited");
    }
    // A refusal does not count, so tomorrow's first turn is not stolen today.
    assert.equal(getAccount(account.id)?.chatCount, 40);
  } finally { await h.close(); }
});

test("two tabs on one account share one chat rate-limit bucket", async () => {
  // Capacity one, so the SECOND request of the pair is refused if — and only if
  // — both tabs key on the account rather than on their own session id. The
  // refill is set to one token every sixteen minutes so that the first request's
  // own duration cannot hand the second tab a fresh token.
  const h = await harness({ setup: accountsOn, chatBurst: 1, chatRefillPerSec: 0.001 });
  try {
    const account = signIn(h);
    const other = await secondCookie(h, account.id);
    assert.equal((await chat(h, h.cookie)).status, 200);
    const second = await chat(h, other);
    assert.equal(second.status, 429);
    assert.equal(second.json?.code, "rate_limited");
  } finally { await h.close(); }
});

// ── 6. desktop is untouched ──────────────────────────────────────────────────

test("desktop mode chats on the owner's key with no account anywhere in sight", async () => {
  const provider = fakeProvider([textTurn("Sliced it.", SPEC_USAGE)]);
  const h = await harness({
    setup: () => {
      process.env.SLICELY_MODE = "desktop";
      // On the desktop the owner IS the user, so the env key is their key.
      process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    },
    factory: realAgent(provider),
  });
  try {
    const r = await chat(h);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    assert.equal(provider.seen[0].apiKey, OWNER_ANTHROPIC);
    // No meter, no credit frame, and no accounts directory on the user's Mac.
    assert.equal(creditFrames(r.frames).length, 0);
    assert.equal(existsSync(join(h.workdir, "accounts")), false);
  } finally { await h.close(); }
});
