// ─────────────────────────────────────────────────────────────────────────────
// Who pays for this turn, with which key, on which model.
//
// This is the ONLY place that question is answered, and everything about the
// free tier follows from that. `POST /api/chat` asks once before it writes an
// SSE byte (so a refusal is plain JSON with a status, not an error frame inside
// a 200), and the agent loop asks again — `guard()` — before every one of its
// up-to-twelve provider calls, because a balance can empty half way through a
// turn.
//
// THE ORDER OF THE CHECKS IS THE POLICY (spec §10.4) and it is deliberate:
//
//   1. THE USER'S OWN KEY WINS, ALWAYS — FOR ANY PROVIDER. Someone who pasted
//      their own key is paying their own bill: they are never metered, never
//      capped, never told about credit. Checking this first is also what keeps
//      the free tier from quietly becoming the default for people who have
//      already paid. And "any provider" is the whole of it: if their key is an
//      OpenAI one while their stored model choice is an Anthropic one, the thing
//      that gives way is the MODEL, not the payer — the effective model becomes
//      that provider's default and `modelSwitchedFrom` says so, so the client can
//      tell them. Falling back to owner credit there would be exactly the wrong
//      way round: it would meter someone who is holding a key, and owner credit
//      exists for people who have none.
//   2. NO FREE TIER AND NO KEY is today's product, unchanged — `NoApiKeyError`,
//      409 `no_key`, "connect a key". Desktop always lands here.
//   3. THEN, AND ONLY THEN, the account: signed in, not blocked, the day not
//      spent globally, chats left today, credit left. Five refusals, five codes,
//      five different sentences, because each has a different fix.
//
// THE MODEL COMES FROM HERE, NOT FROM SETTINGS. A visitor who chose
// `gpt-6-astra` while they had an OpenAI key, then disconnected it, would
// otherwise run the owner's Anthropic key against a model the owner is not
// paying for — or, worse, one with no price row. On free credit the model, the
// effort and the output ceiling are all the free tier's, and `PATCH /api/settings`
// refuses to change them (routes/settings.ts). On a key of their own only the
// model can move, and only to the provider they hold a key for.
//
// THE OWNER'S KEY IS READ HERE AND ALMOST NOWHERE ELSE. `process.env.ANTHROPIC_API_KEY`
// and `OPENAI_API_KEY` appear in exactly two places in `src/main`: userkey.ts's
// desktop-only fallback (where the owner IS the user) and this file (where a
// signed-in account with credit is the only thing that can spend them). That is
// the whole of what retiring `SLICELY_ALLOW_OPERATOR_KEY` means.
//
// ON THE ONE IMPORT FROM `src/server`: `WireError` is the wire contract's own
// type, and errors.ts is where it lives. Inventing a second error class here so
// that `src/main` imports nothing from `src/server` would mean `toWire` could
// not map it, and every refusal below would reach the browser as a generic 500.
// The dependency is one type and one constructor, and it does not cycle back.
// Whether an OAuth provider is configured, by contrast, IS injected
// (`FundingContext.oauthConfigured`), because that answer lives in
// `src/server/oauth/` and reading it here would drag the router in.
// ─────────────────────────────────────────────────────────────────────────────
import { getConfig } from "../config";
import { isHosted } from "../mode";
import { getSettings, modelOption, MODEL_CATALOG, type EffortLevel } from "../settings";
import { getUserApiKey, NoApiKeyError } from "../userkey";
import { formatMoney, isPriced, type TurnUsage } from "../pricing";
import { balanceMicros, getAccount, type Account } from "../accounts/store";
import { chargeAccount, chatAllowance, freeTierPaused } from "../accounts/meter";
import { WireError } from "../../server/errors";
import { getProvider, providerForModel, PROVIDERS, type Provider } from "./provider";
import type { ProviderId } from "../../shared/types";

/** The free tier as configured. Every field is a per-DEPLOY fact, so the whole
 *  object is safe to put on `/api/config`. */
export interface FreeTierInfo {
  /** "claude-sonnet-5" | "gpt-5.6-luna" | whatever SLICELY_FREE_MODEL names. */
  model: string;
  /** From MODEL_CATALOG, so the UI and the picker agree on the name. */
  modelLabel: string;
  effort: "medium";
  creditCents: number;
  maxOutputTokens: number;
}

/** The owner's own key for one provider — the standard variable name each
 *  provider's SDK reads. Not cached: it is an env var, and a Fly secret change
 *  takes effect on the restart that follows it. */
function ownerKey(provider: ProviderId): string | undefined {
  const name = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  return process.env[name]?.trim() || undefined;
}

/** Misconfigurations already reported, so a broken `SLICELY_FREE_MODEL` costs
 *  one log line rather than one per request for the life of the deploy. */
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[funding] ${message}`);
}

/**
 * The free tier as configured, or `undefined` when it is off.
 *
 * Spec §6, exactly: an explicit `SLICELY_FREE_MODEL` must be in the catalogue,
 * have a price row, AND have its provider's owner key set — all three, or the
 * free tier is off and the owner is told why. Otherwise the model follows
 * whichever owner key exists, Anthropic first (`claude-sonnet-5` is both the
 * cheapest capable option and the one the worked example is costed against).
 *
 * Read fresh every time. There is nothing to cache: three env reads and a
 * lookup, and caching would mean a restart was needed to fix a typo that a
 * restart was already needed to fix.
 */
export function freeTierInfo(): FreeTierInfo | undefined {
  // Accounts are hosted-only. On the desktop the owner is the user, so the key
  // is spent through userkey.ts's fallback and there is nothing to meter.
  if (!isHosted()) return undefined;
  const cfg = getConfig();

  const model = chooseFreeModel(cfg.freeModel);
  if (!model) return undefined;
  const option = modelOption(model);
  if (!option) return undefined;

  return {
    model,
    modelLabel: option.label,
    effort: "medium",
    creditCents: cfg.freeCreditCents,
    maxOutputTokens: cfg.freeMaxOutputTokens,
  };
}

/** The three-branch decision in spec §6, and the one place it is written. */
function chooseFreeModel(configured: string): string | undefined {
  if (configured) {
    const option = modelOption(configured);
    if (!option) {
      warnOnce(`SLICELY_FREE_MODEL="${configured}" is not in MODEL_CATALOG — the free tier is off.`);
      return undefined;
    }
    if (!isPriced(configured)) {
      warnOnce(`SLICELY_FREE_MODEL="${configured}" has no row in PRICE_TABLE, so it cannot be metered — the free tier is off.`);
      return undefined;
    }
    if (!ownerKey(option.provider)) {
      warnOnce(`SLICELY_FREE_MODEL="${configured}" needs a ${option.provider} owner key, which is not set — the free tier is off.`);
      return undefined;
    }
    return configured;
  }
  if (ownerKey("anthropic") && isPriced("claude-sonnet-5")) return "claude-sonnet-5";
  if (ownerKey("openai") && isPriced("gpt-5.6-luna")) return "gpt-5.6-luna";
  return undefined;
}

/**
 * True when the sign-in buttons should render.
 *
 * All three legs, because any one of them missing makes sign-in a dead end:
 * hosted mode (desktop has no accounts), a usable free tier (nothing to offer a
 * new visitor), and at least one fully configured OAuth provider (nothing to
 * sign in WITH). Missing any of them leaves exactly today's BYO-only product.
 *
 * `oauthConfigured` is injected rather than read — see the header.
 */
export function accountsEnabled(oauthConfigured: boolean): boolean {
  return isHosted() && oauthConfigured && freeTierInfo() !== undefined;
}

export type FundingSource = "user" | "free";

export interface TurnFunding {
  source: FundingSource;
  /** Whose API this turn will actually talk to. Follows `apiKey` and `model`,
   *  never the visitor's stored choice — see `ownKeyForTurn`. */
  provider: ProviderId;
  apiKey: string;
  model: string;
  effort: EffortLevel;
  maxOutputTokens: number;
  /** The model the visitor had SELECTED, when it is not the one being run.
   *
   *  Set only on the BYO path, and only when their key is for another provider:
   *  "you picked Sonnet 5, your key is an OpenAI one, so this turn ran on GPT-5.6
   *  Terra" is a sentence the client has to be able to say, or the answer appears
   *  to come from a model they did not choose with nothing to explain it. Nothing
   *  in the agent loop reads it. */
  modelSwitchedFrom?: string;
  /** Throws `WireError(402, …, "credit_exhausted")` when the balance ran out.
   *  A no-op for source "user". Called before every provider call. */
  guard(): void;
  /** Charges one provider call and updates the cached balance. No-op for "user". */
  onUsage(usage: TurnUsage): Promise<void>;
  /** The balance after the last charge, for the `credit` SSE event.
   *  `undefined` for "user" — there is nothing of ours being spent. */
  balance(): { balanceMicros: number; balanceLabel: string; exhausted: boolean } | undefined;
}

export interface FundingContext {
  accountId?: string;
  oauthConfigured: boolean;
}

/**
 * Who pays for this turn. Throws a `WireError` for every refusal in spec §10.4.
 *
 * Called twice per turn by design: once by the route, before any header is
 * written, and once by the agent when it builds the request. Cheap enough for
 * that — a key read, a file read of one small JSON, and three integer
 * comparisons.
 */
export function resolveTurnFunding(ctx: FundingContext): TurnFunding {
  const settings = getSettings();
  const active = providerForModel(settings.model);
  const own = ownKeyForTurn(settings.model);
  if (own) {
    return userFunding(own.apiKey, own.model, settings.effort, own.provider, own.switchedFrom);
  }

  const free = freeTierInfo();
  if (!free || !accountsEnabled(ctx.oauthConfigured)) {
    // Today's behaviour, unchanged: 409 `no_key`, and the provider is NAMED
    // because which key is missing is the whole of what the user must act on.
    throw new NoApiKeyError(`Connect your ${active.label} API key in Settings to chat.`);
  }
  if (!ctx.accountId) {
    throw new WireError(401, "Sign in to start — you get free credit to try Slicely.", "signin_required");
  }
  const account = getAccount(ctx.accountId);
  // A binding to an account that no longer exists (deleted, or a workdir wiped
  // under us) is not an error the visitor can act on except by signing in.
  if (!account) {
    throw new WireError(401, "Sign in again to keep going.", "signin_required");
  }
  if (account.blocked) {
    throw new WireError(403, "This account can't use Slicely. Get in touch if that's wrong.", "email_blocked");
  }
  if (freeTierPaused()) {
    throw new WireError(503, "Free usage is busy today — add your own key or try tomorrow.", "free_tier_paused");
  }
  const chats = chatAllowance(account);
  if (!chats.allowed) {
    throw new WireError(
      429,
      `You've used your ${chats.limit} free chats for today. Add your own key to keep going.`,
      "rate_limited",
    );
  }
  if (balanceMicros(account) <= 0) {
    throw new WireError(402, "You've used your free credit. Add your own API key to keep going.", "credit_exhausted");
  }
  return freeFunding(account, free);
}

/**
 * The user's own key and the model it can actually run, or `undefined` when they
 * hold no key at all.
 *
 * THE SELECTED MODEL'S PROVIDER FIRST — that is the ordinary case and it changes
 * nothing. Only when there is no key for it does this look at the other
 * providers, and a hit there switches the model rather than the payer: a person
 * holding a key is paying their own bill, so metering them against the owner's
 * fifty cents would bill the owner for somebody who had already paid, and would
 * hand them a free-tier model instead of one their key could run anyway.
 *
 * `switchedFrom` is set only on that second branch, and is what the client shows.
 */
function ownKeyForTurn(model: string): {
  apiKey: string;
  provider: Provider;
  model: string;
  switchedFrom?: string;
} | undefined {
  const selected = providerForModel(model);
  const direct = getUserApiKey(selected.id);
  if (direct) return { apiKey: direct, provider: selected, model };

  for (const provider of PROVIDERS) {
    if (provider.id === selected.id) continue;
    const key = getUserApiKey(provider.id);
    if (key) {
      return { apiKey: key, provider, model: defaultModelFor(provider.id), switchedFrom: model };
    }
  }
  return undefined;
}

/** A provider's default model: the first catalogue entry that is theirs, which is
 *  also the first one the picker offers, so the switch lands somewhere the user
 *  would recognise rather than on whatever happens to be cheapest. */
function defaultModelFor(provider: ProviderId): string {
  return MODEL_CATALOG.find((m) => m.provider === provider)?.id ?? MODEL_CATALOG[0].id;
}

/** The BYO path: their key, their model, their provider's ceiling, no meter. */
function userFunding(
  apiKey: string,
  model: string,
  effort: EffortLevel,
  provider: Provider,
  switchedFrom?: string,
): TurnFunding {
  return {
    source: "user",
    provider: provider.id,
    apiKey,
    model,
    effort,
    maxOutputTokens: provider.maxOutputTokens,
    ...(switchedFrom && switchedFrom !== model ? { modelSwitchedFrom: switchedFrom } : {}),
    guard: () => undefined,
    onUsage: async () => undefined,
    balance: () => undefined,
  };
}

/**
 * The free path: the owner's key, the free model, the free ceiling, metered
 * after every call.
 *
 * `balance` is held locally and updated from each charge's result rather than
 * re-read, so the `credit` event the browser gets is the balance as of the last
 * call of THIS turn and cannot be confused by a concurrent turn in another tab
 * (whose charges are serialised by the account lock either way).
 *
 * It may go slightly negative in between: a call is charged only after it has
 * already happened, so the overshoot is ONE CALL PER CONCURRENT TURN — not one
 * call. Two tabs that both clear `guard()` on the last of the credit each spend
 * a call before either charge lands, and the pre-flight in `resolveTurnFunding`
 * is a read, so three tabs overshoot by three. Bounded by `maxOutputTokens`
 * times however many turns one account can have in flight, which is what the
 * per-account rate-limit bucket (`acct:<id>`) keeps small. The floor is applied
 * where it is visible — on display, and on the next `guard()`.
 */
function freeFunding(account: Account, free: FreeTierInfo): TurnFunding {
  const provider = getProvider(modelOption(free.model)?.provider ?? "anthropic");
  const apiKey = ownerKey(provider.id);
  // Unreachable: `freeTierInfo()` only names a model whose provider key is set.
  if (!apiKey) {
    throw new WireError(503, "Free usage isn't available right now.", "free_tier_paused");
  }
  let balance = balanceMicros(account);
  return {
    source: "free",
    provider: provider.id,
    apiKey,
    model: free.model,
    effort: free.effort,
    maxOutputTokens: free.maxOutputTokens,
    guard: () => {
      if (balance <= 0) {
        // A DIFFERENT SENTENCE from the pre-flight refusal on purpose: the user
        // has already seen part of an answer, and "you've used your free credit"
        // with half a reply above it reads as though the reply was the problem.
        throw new WireError(
          402,
          "Your free credit ran out part-way through that answer. Add your own API key to carry on.",
          "credit_exhausted",
        );
      }
    },
    onUsage: async (usage: TurnUsage) => {
      const result = await chargeAccount(account.id, free.model, usage);
      balance = result.balanceMicros;
    },
    balance: () => ({
      balanceMicros: Math.max(0, balance),
      balanceLabel: formatMoney(balance),
      exhausted: balance <= 0,
    }),
  };
}

/** Tests only: forget which misconfigurations have been reported, so a case can
 *  assert that a broken `SLICELY_FREE_MODEL` logs exactly once. */
export function resetFundingForTests(): void {
  warned.clear();
}
