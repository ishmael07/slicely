import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resetConfigForTests } from "../config";
import { resetKeyVaultForTests } from "../keyvault";
import { runInSession, sessionContext } from "../session-context";
import { disposeSessionSettings, updateSettings, MODEL_CATALOG } from "../settings";
import {
  clearUserApiKey, disposeSessionUserKey, getUserApiKey, setUserApiKey, NoApiKeyError,
} from "../userkey";
import { centsToMicros, type TurnUsage } from "../pricing";
import { WireError } from "../../server/errors";
import {
  findOrCreateAccount, getAccount, resetAccountsForTests, writeAccount,
  type Account,
} from "../accounts/store";
import { chargeAccount, resetMeterForTests } from "../accounts/meter";
import { usageFile, utcDay } from "../accounts/paths";
import {
  accountsEnabled, freeTierInfo, resolveTurnFunding, resetFundingForTests,
} from "./funding";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
// A developer's own .env may carry either provider key; these tests decide which
// owner keys exist, one case at a time.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
delete process.env.SLICELY_FREE_MODEL;
resetKeyVaultForTests();

const OWNER_ANTHROPIC = "sk-ant-api03-" + "o".repeat(40);
const OWNER_OPENAI = "sk-proj-" + "o".repeat(40);
const USER_ANTHROPIC = "sk-ant-api03-" + "u".repeat(40);
const USER_OPENAI = "sk-proj-" + "u".repeat(40);

/** The spec §4.3 worked example. 4,714,000 µ¢ on claude-sonnet-5. */
const SPEC_USAGE: TurnUsage = {
  inputTokens: 8_670,
  cachedInputTokens: 18_000,
  cacheWriteTokens: 6_000,
  outputTokens: 1_120,
};

let seq = 0;

/** A clean workdir, a clean session, and every cache dropped — then the body,
 *  inside that session's ambient context (which is what `getUserApiKey` and
 *  `getSettings` resolve against). */
async function fresh(run: (sid: string) => Promise<void> | void): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), "slicely-funding-"));
  const sid = `F${(seq += 1)}`;
  process.env.SLICELY_WORKDIR = workdir;
  resetConfigForTests();
  resetAccountsForTests();
  resetMeterForTests();
  resetFundingForTests();
  try {
    await runInSession(sessionContext(sid, join(workdir, "sessions", sid)), async () => {
      await run(sid);
    });
  } finally {
    disposeSessionSettings(sid);
    disposeSessionUserKey(sid);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
    delete process.env.SLICELY_FREE_MODEL;
    process.env.SLICELY_MODE = "hosted";
    resetConfigForTests();
    rmSync(workdir, { recursive: true, force: true });
  }
}

function signedIn(): Account {
  return findOrCreateAccount(
    {
      provider: "google",
      providerUserId: "107812345",
      email: "Jane.Doe@gmail.com",
      normalizedEmail: "janedoe@gmail.com",
      name: "Jane Doe",
    },
    centsToMicros(50),
  ).account;
}

/** The thrown WireError, so a test can assert the status AND the code. */
function wireThrown(fn: () => unknown): WireError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof WireError, `expected a WireError, got ${String(err)}`);
    return err;
  }
  throw new Error("expected a refusal, but funding resolved");
}

// ── 1, 16: a user's own key wins, and is never metered ───────────────────────

test("a user with their own key pays for their own turn, and nothing is metered", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;   // present, and irrelevant here
    setUserApiKey("anthropic", USER_ANTHROPIC);
    updateSettings({ model: "claude-opus-4-8", effort: "high" });

    const funding = resolveTurnFunding({ oauthConfigured: true });
    assert.equal(funding.source, "user");
    assert.equal(funding.apiKey, USER_ANTHROPIC);
    assert.equal(funding.model, "claude-opus-4-8");
    assert.equal(funding.maxOutputTokens, 16_000, "the provider's own ceiling, not the free one");
    assert.doesNotThrow(() => funding.guard());
    await funding.onUsage(SPEC_USAGE);
    assert.equal(funding.balance(), undefined, "there is no balance to report");
    assert.equal(existsSync(usageFile(utcDay())), false, "a paid turn writes no ledger line");
  });
});

test("the user's own key wins even when their account still has credit", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    setUserApiKey("anthropic", USER_ANTHROPIC);
    updateSettings({ model: "claude-opus-4-8" });

    const funding = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    assert.equal(funding.source, "user");
    await funding.onUsage(SPEC_USAGE);
    assert.equal(getAccount(account.id)!.spentMicros, 0, "a user paying their own bill is not metered");
  });
});

// ── 2, 3: strangers cannot spend the owner's key ─────────────────────────────

test("a hosted server with an owner key refuses an unsigned-in visitor", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const err = wireThrown(() => resolveTurnFunding({ oauthConfigured: true }));
    assert.equal(err.status, 401);
    assert.equal(err.code, "signin_required");
  });
});

test("SLICELY_ALLOW_OPERATOR_KEY is retired and buys nothing", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    process.env.SLICELY_ALLOW_OPERATOR_KEY = "1";
    assert.equal(getUserApiKey("anthropic"), undefined, "the flag no longer opens the door");
    const err = wireThrown(() => resolveTurnFunding({ oauthConfigured: true }));
    assert.equal(err.status, 401);
    assert.equal(err.code, "signin_required");
  });
});

// ── 4: no accounts, no key — today's behaviour, unchanged ────────────────────

test("with no free tier and no key, the answer is still connect one", async () => {
  await fresh(() => {
    assert.throws(() => resolveTurnFunding({ oauthConfigured: false }), NoApiKeyError);
    // And with OAuth configured but no owner key to fund anything, likewise.
    assert.throws(() => resolveTurnFunding({ oauthConfigured: true }), NoApiKeyError);
  });
});

// ── 5, 6, 7, 8, 9: the free path and its five refusals ───────────────────────

test("a signed-in visitor with credit runs on the free model, at the free ceiling", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    // A model they stored while they had a key must not decide the turn.
    updateSettings({ model: "claude-opus-4-8", effort: "max" });

    const funding = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    assert.equal(funding.source, "free");
    assert.equal(funding.apiKey, OWNER_ANTHROPIC);
    assert.equal(funding.model, "claude-sonnet-5");
    assert.equal(funding.effort, "medium");
    assert.equal(funding.maxOutputTokens, 4_000);
  });
});

test("an empty balance is 402 credit_exhausted", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    account.spentMicros = account.grantedMicros;
    writeAccount(account);
    const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
    assert.equal(err.status, 402);
    assert.equal(err.code, "credit_exhausted");
  });
});

test("a blocked account is 409 account_blocked", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    account.blocked = true;
    writeAccount(account);
    const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
    assert.equal(err.status, 409);
    assert.equal(err.code, "account_blocked");
    assert.equal(err.message, "This account can't use Slicely.");
  });
});

test("a blocked account holding its OWN key is refused too — blocked means blocked", async () => {
  await fresh(() => {
    // The own-key branch is normally the first and last word on who pays, and it
    // never consults the account at all. A block has to be asked BEFORE it, or
    // the one thing the owner can do about an abusive account is undone by the
    // abuser pasting a key of their own.
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    setUserApiKey("anthropic", USER_ANTHROPIC);
    assert.equal(getUserApiKey("anthropic"), USER_ANTHROPIC, "the key really is there");
    const account = signedIn();
    account.blocked = true;
    writeAccount(account);
    const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
    assert.equal(err.status, 409);
    assert.equal(err.code, "account_blocked");
  });
});

test("a blocked account is refused even when the free tier is off entirely", async () => {
  await fresh(() => {
    // No owner key, no free tier: the ordinary answer here is `no_key`. The
    // block still comes first, so the person is told the true reason.
    const account = signedIn();
    account.blocked = true;
    writeAccount(account);
    const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
    assert.equal(err.status, 409);
    assert.equal(err.code, "account_blocked");
  });
});

test("the global daily cap is 503 free_tier_paused, for everyone at once", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    process.env.SLICELY_DAILY_SPEND_CAP_CENTS = "1";
    resetConfigForTests();
    try {
      const account = signedIn();
      await chargeAccount(account.id, "claude-sonnet-5", SPEC_USAGE);   // 4.7¢, over a 1¢ cap
      const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
      assert.equal(err.status, 503);
      assert.equal(err.code, "free_tier_paused");
    } finally {
      delete process.env.SLICELY_DAILY_SPEND_CAP_CENTS;
      resetConfigForTests();
    }
  });
});

test("a spent daily chat cap is 429, and the sentence names the number", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    account.chatDay = utcDay();
    account.chatCount = 40;
    writeAccount(account);
    const err = wireThrown(() => resolveTurnFunding({ accountId: account.id, oauthConfigured: true }));
    assert.equal(err.status, 429);
    assert.equal(err.code, "rate_limited");
    assert.match(err.message, /40/, "a limit the user cannot see is not a limit they can plan around");
  });
});

test("a session bound to an account that no longer exists is asked to sign in again", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const err = wireThrown(() =>
      resolveTurnFunding({ accountId: "0".repeat(32), oauthConfigured: true }));
    assert.equal(err.status, 401);
    assert.equal(err.code, "signin_required");
  });
});

// ── 10, 11, 12, 13: which model the free tier runs on ────────────────────────

test("the free model follows whichever owner key exists", async () => {
  await fresh(() => {
    process.env.OPENAI_API_KEY = OWNER_OPENAI;
    assert.equal(freeTierInfo()?.model, "gpt-5.6-luna");
    assert.equal(freeTierInfo()?.modelLabel, "GPT-5.6 Luna");

    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    assert.equal(freeTierInfo()?.model, "claude-sonnet-5", "Anthropic wins when both are set");
    assert.equal(freeTierInfo()?.modelLabel, "Sonnet 5");
    assert.equal(freeTierInfo()?.effort, "medium");
    assert.equal(freeTierInfo()?.creditCents, 50);
    assert.equal(freeTierInfo()?.maxOutputTokens, 4_000);

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(freeTierInfo(), undefined, "no owner key, no free tier");
    assert.equal(accountsEnabled(true), false, "and so nothing to sign in for");
  });
});

test("SLICELY_FREE_MODEL whose provider has no owner key is a misconfiguration, logged once", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    process.env.SLICELY_FREE_MODEL = "gpt-5.6-luna";
    resetConfigForTests();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      assert.equal(freeTierInfo(), undefined);
      assert.equal(freeTierInfo(), undefined);
      assert.equal(freeTierInfo(), undefined);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 1, "once per misconfiguration, not once per request");
    assert.match(warnings[0], /SLICELY_FREE_MODEL/);
    assert.match(warnings[0], /gpt-5\.6-luna/);
  });
});

test("SLICELY_FREE_MODEL nobody can price disables the free tier", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    process.env.SLICELY_FREE_MODEL = "claude-imaginary-9";
    resetConfigForTests();
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(freeTierInfo(), undefined);
      assert.equal(accountsEnabled(true), false);
    } finally {
      console.warn = realWarn;
    }
  });
});

test("accounts need hosted mode, a free tier and an OAuth provider — all three", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    assert.equal(accountsEnabled(true), true);
    assert.equal(accountsEnabled(false), false, "nothing to sign in WITH");

    process.env.SLICELY_MODE = "desktop";
    assert.equal(accountsEnabled(true), false, "the owner is the user on the desktop");
    assert.equal(freeTierInfo(), undefined);
  });
});

// ── 14, 15: metering through the seam ────────────────────────────────────────

test("a free turn is metered through onUsage, and the balance is reported for the pill", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    const funding = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    await funding.onUsage(SPEC_USAGE);

    assert.equal(getAccount(account.id)!.spentMicros, 4_714_000);
    assert.deepEqual(funding.balance(), {
      balanceMicros: 45_286_000,
      balanceLabel: "$0.45",
      exhausted: false,
    });
  });
});

test("credit that runs out mid-turn stops the next call, in its own words", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    const funding = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    assert.doesNotThrow(() => funding.guard(), "the first call of the turn is fine");

    // Eleven calls of 4.714¢ empty a 50¢ grant.
    for (let i = 0; i < 11; i += 1) await funding.onUsage(SPEC_USAGE);
    assert.equal(funding.balance()!.exhausted, true);
    assert.equal(funding.balance()!.balanceMicros, 0, "reported floored, never negative");

    const err = wireThrown(() => funding.guard());
    assert.equal(err.status, 402);
    assert.equal(err.code, "credit_exhausted");
    assert.match(err.message, /part-way through/, "distinct from the pre-flight sentence");
  });
});

// ── the catalogue entry P1's completeness test needs ─────────────────────────

test("claude-sonnet-5 is in the picker, so key-holders can choose it too", () => {
  const entry = MODEL_CATALOG.find((m) => m.id === "claude-sonnet-5");
  assert.ok(entry, "the free-tier model must be in MODEL_CATALOG");
  assert.equal(entry.provider, "anthropic");
  assert.equal(entry.label, "Sonnet 5");
  assert.equal(MODEL_CATALOG.findIndex((m) => m.id === "claude-sonnet-5"), 1,
    "first after Opus, so it is visible rather than buried");
});

test("an OpenAI key-holder still gets their own model and their own bill", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    setUserApiKey("openai", USER_OPENAI);
    updateSettings({ model: "gpt-6-astra" });
    const funding = resolveTurnFunding({ oauthConfigured: true });
    assert.equal(funding.source, "user");
    assert.equal(funding.apiKey, USER_OPENAI);
    assert.equal(funding.model, "gpt-6-astra");
    assert.equal(funding.maxOutputTokens, 32_000, "OpenAI's ceiling, which counts reasoning too");
  });
});

// ── Fix round 1: a key for ANY provider is still the user paying ─────────────

test("a signed-in user with an OpenAI key and an Anthropic model selected pays their own bill", async () => {
  await fresh(async () => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;   // the owner's credit exists
    const account = signedIn();                        // and they have 50¢ of it
    setUserApiKey("openai", USER_OPENAI);
    updateSettings({ model: "claude-sonnet-5", effort: "high" });

    const funding = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    assert.equal(funding.source, "user", "a key is a key, whoever's provider it is for");
    assert.equal(funding.provider, "openai");
    assert.equal(funding.apiKey, USER_OPENAI);
    assert.equal(funding.model, "gpt-5.6-terra", "OpenAI's default, since their key cannot run Sonnet");
    assert.equal(funding.modelSwitchedFrom, "claude-sonnet-5", "and the client is told what happened");
    assert.equal(funding.effort, "high", "their own effort choice stands");
    assert.equal(funding.maxOutputTokens, 32_000, "OpenAI's ceiling, not the free tier's 4,000");

    await funding.onUsage(SPEC_USAGE);
    assert.equal(getAccount(account.id)!.spentMicros, 0, "the owner's credit is untouched");
    assert.equal(funding.balance(), undefined, "so there is no credit event to emit");
    assert.equal(existsSync(usageFile(utcDay())), false, "and no ledger line");
  });
});

test("a key for the selected model's own provider switches nothing", async () => {
  await fresh(() => {
    setUserApiKey("anthropic", USER_ANTHROPIC);
    updateSettings({ model: "claude-opus-4-8" });
    const funding = resolveTurnFunding({ oauthConfigured: true });
    assert.equal(funding.source, "user");
    assert.equal(funding.provider, "anthropic");
    assert.equal(funding.model, "claude-opus-4-8");
    assert.equal(funding.modelSwitchedFrom, undefined, "nothing to tell the client about");
  });
});

test("owner credit is only for someone with no key at all", async () => {
  await fresh(() => {
    process.env.ANTHROPIC_API_KEY = OWNER_ANTHROPIC;
    const account = signedIn();
    // Both directions of the switch, and then neither key.
    setUserApiKey("openai", USER_OPENAI);
    updateSettings({ model: "claude-sonnet-5" });
    assert.equal(resolveTurnFunding({ accountId: account.id, oauthConfigured: true }).source, "user");

    clearUserApiKey("openai");   // disconnect
    const free = resolveTurnFunding({ accountId: account.id, oauthConfigured: true });
    assert.equal(free.source, "free", "now, and only now, the owner pays");
    assert.equal(free.provider, "anthropic");
    assert.equal(free.model, "claude-sonnet-5");
  });
});
