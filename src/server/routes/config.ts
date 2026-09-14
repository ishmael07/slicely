// ─────────────────────────────────────────────────────────────────────────────
// GET /api/config — the one call the client makes before it can render
// anything: which mode this server runs in, which AI providers a key can be
// connected to and whether THIS session has each one, whether a slicer exists
// here at all, and the legal / source links the page footer needs.
//
// It replaces two older hacks: the client probing a privileged endpoint and
// reading the 403 as "multi-user", and Electron's env-derived `ConfigState`.
//
// `sourceCommit` is not decoration. Slicely runs AGPL software (PrusaSlicer) as
// a network service, so §13 requires offering the running version's source to
// its users — the commit here is what `REPO_URL/tree/<commit>` in the footer
// points at. A deployed image sets `SLICELY_SOURCE_COMMIT`; a dev checkout asks
// git; anything else says "dev" rather than lying about a commit.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../../main/config";
import { getMode, isHosted } from "../../main/mode";
import { getUserApiKey, hasAnyUserApiKey, userKeyHint } from "../../main/userkey";
import { PROVIDERS, providerForModel } from "../../main/agent/provider";
import { getSettings } from "../../main/settings";
import { accountsEnabled, freeTierInfo } from "../../main/agent/funding";
import { formatMoney } from "../../main/pricing";
import { balanceMicros, type Account } from "../../main/accounts/store";
import { chatAllowance } from "../../main/accounts/meter";
import type {
  AccountView, FreeTierView, ProviderInfo, SigninProvider,
} from "../../shared/types";

/** A string that is not a key and not one of the prefixes any provider names
 *  specially, so `formatMessage` returns its GENERAL refusal — the sentence the
 *  client needs when it turns a paste away locally. */
const UNRECOGNISED_KEY = "?";

/** Repo root from this file's compiled location (`dist/server/routes/`) — the
 *  same three levels up from `src/server/routes/`, so it resolves either way. */
const REPO_ROOT = join(__dirname, "..", "..", "..");

const DEFAULT_REPO_URL = "https://github.com/ishmael07/slicely";

export interface ConfigResponse {
  mode: "hosted" | "desktop";
  /** Does this session have a usable key for ANY provider? A user with only an
   *  OpenAI key is not a user without a key, so this is not per-provider. */
  hasKey: boolean;
  /** The hint for the ACTIVE model's provider — the key that would pay for the
   *  next message. Undefined when that provider has no key, even if the other
   *  one does. */
  keyHint?: string;
  /** Every provider a key can be connected to, in UI order. */
  providers: ProviderInfo[];
  multiUser: boolean;
  slicerAvailable: boolean;
  sourceCommit: string;
  version: string;
  repoUrl: string;
  termsUrl: "/terms";
  privacyUrl: "/privacy";
  /** Should the sign-in block render at all? Hosted, a fundable free tier, and
   *  at least one OAuth provider fully configured — all three, or this is
   *  exactly today's bring-your-own-key product. */
  accountsEnabled: boolean;
  /** Which buttons to show, in the order to show them. Empty when
   *  `accountsEnabled` is false. */
  signinProviders: SigninProvider[];
  /** What free credit runs on, or null when there is none. Per-deploy facts
   *  only — what one PERSON has left is on GET /api/me. */
  freeTier: FreeTierView | null;
}

/**
 * The two ways in, in the order the UI shows them.
 *
 * FIXED ORDER, because a list assembled from `Object.entries(process.env)` would
 * reorder itself between deploys and move the buttons under the user's cursor.
 *
 * A provider counts as configured only with BOTH halves of its client AND
 * `SLICELY_PUBLIC_URL`: redirect URIs are built from that origin and never from
 * a request's `Host` header, so without it there is nothing to send the person
 * back to and the flow would fail after they had already typed their password.
 * Half a client is no client.
 *
 * ON MERGING WITH THE OAUTH LANE: `src/server/routes/auth.ts` exports
 * `signInProviders()`, which answers this same question from the provider
 * objects themselves (`OauthProvider.configured()`). That is the better source —
 * it cannot drift from the flow that actually runs — so at merge time pass it in
 * as `createConfigRouter({ signinProviders: signInProviders })` and this
 * function becomes the fallback for a server built without the auth router.
 */
export function signinProvidersFromEnv(): SigninProvider[] {
  if (!isHosted() || !getConfig().publicUrl) return [];
  const out: SigninProvider[] = [];
  const configured = (prefix: string): boolean =>
    Boolean(process.env[`${prefix}_CLIENT_ID`]?.trim() && process.env[`${prefix}_CLIENT_SECRET`]?.trim());
  if (configured("GOOGLE")) out.push({ id: "google", label: "Google" });
  if (configured("GITHUB")) out.push({ id: "github", label: "GitHub" });
  return out;
}

/**
 * One account as its owner is shown it — and the whole of what ever crosses the
 * wire about a person (see `AccountView`).
 *
 * Exported so `GET /api/me` (routes/auth.ts, lane B) renders the same shape from
 * the same code. Two copies of "what does a signed-in person look like" is how a
 * balance in the header comes to disagree with the balance in Settings.
 *
 * `initial` is the first character of the address, uppercased — not of the name,
 * which may be absent, may be a company, and may be in a script with no
 * uppercase at all. `"?"` when there is no first character to take, because a
 * monogram with a blank in it reads as a broken avatar rather than as an unusual
 * address.
 */
export function accountView(account: Account): AccountView {
  const chats = chatAllowance(account);
  const balance = balanceMicros(account);
  return {
    email: account.email,
    ...(account.name ? { name: account.name } : {}),
    initial: account.email.trim()[0]?.toUpperCase() ?? "?",
    balanceMicros: balance,
    balanceLabel: formatMoney(balance),
    grantedMicros: account.grantedMicros,
    grantedLabel: formatMoney(account.grantedMicros),
    chatsToday: chats.used,
    chatsPerDay: chats.limit,
    exhausted: balance <= 0,
  };
}

export interface ConfigRouterOptions {
  /**
   * The OAuth providers this deployment offers, injected.
   *
   * Structurally the subset of lane B's `OauthConfig` this route needs, so a
   * real `OauthConfig` is assignable to it: `configured()` is asked of each, and
   * nothing else about a provider is any of this route's business.
   */
  oauth?: {
    providers?: readonly { id: "google" | "github"; label: string; configured(): boolean }[];
  };
  /** Override how the provider list is resolved — see `signinProvidersFromEnv`.
   *  Takes precedence over `oauth`. */
  signinProviders?: () => SigninProvider[];
}

let commitCache: string | undefined;

/** The commit this server is running, resolved once. */
function sourceCommit(): string {
  if (commitCache) return commitCache;
  const fromEnv = process.env.SLICELY_SOURCE_COMMIT?.trim();
  if (fromEnv) {
    commitCache = fromEnv;
    return commitCache;
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // A packaged app has no .git, and a stray git failure must not turn into a
    // fake commit in a legally-meaningful field.
    if (/^[0-9a-f]{7,40}$/i.test(head)) {
      commitCache = head;
      return commitCache;
    }
  } catch {
    /* no git, no checkout, or not a repo */
  }
  commitCache = "dev";
  return commitCache;
}

let versionCache: string | undefined;

function appVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    versionCache = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }
  return versionCache;
}

/** Is a slicer binary present on THIS machine? A plain stat, not
 *  prusaslicer.getStatus(): that also shells out to `pgrep`/`lsappinfo` to see
 *  whether the GUI is open, which is meaningless on a server and far too
 *  expensive for a call every page load makes. */
function slicerAvailable(): boolean {
  try {
    return existsSync(getConfig().prusaSlicerPath);
  } catch {
    return false;
  }
}

export function createConfigRouter(opts: ConfigRouterOptions = {}): Router {
  const router = Router();
  // Resolve the commit AT BOOT (app construction), not on the first request:
  // asking git is a subprocess, and no visitor should wait for it.
  sourceCommit();

  /** Read per request, not per boot: a Fly secret change means a restart, but a
   *  test flips the environment between two requests to the same app. */
  const listProviders = (): SigninProvider[] => {
    if (opts.signinProviders) return opts.signinProviders();
    if (opts.oauth?.providers) {
      return opts.oauth.providers
        .filter((p) => p.configured())
        .map((p) => ({ id: p.id, label: p.label }));
    }
    return signinProvidersFromEnv();
  };

  router.get("/config", (_req: Request, res: Response) => {
    const active = providerForModel(getSettings().model).id;
    const signinProviders = listProviders();
    // All three legs, in one place: the client should never have to work out
    // from three fields whether the sign-in block is worth rendering.
    const accounts = accountsEnabled(signinProviders.length > 0);
    const free = accounts ? freeTierInfo() : undefined;
    const body: ConfigResponse = {
      mode: getMode(),
      hasKey: hasAnyUserApiKey(),
      // The hint is the ONLY thing about a key that ever crosses the wire: four
      // characters, so a user can tell which key is connected.
      keyHint: userKeyHint(active),
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        hasKey: Boolean(getUserApiKey(p.id)),
        keyHint: userKeyHint(p.id),
        keyHelp: {
          label: p.keyHelp.label,
          placeholder: p.keyHelp.placeholder,
          consoleUrl: p.keyHelp.consoleUrl,
          consoleLabel: p.keyHelp.consoleLabel,
          formatMessage: p.keyHelp.formatMessage(UNRECOGNISED_KEY),
        },
      })),
      multiUser: isHosted(),
      slicerAvailable: slicerAvailable(),
      sourceCommit: sourceCommit(),
      version: appVersion(),
      repoUrl: process.env.SLICELY_REPO_URL?.trim() || DEFAULT_REPO_URL,
      termsUrl: "/terms",
      privacyUrl: "/privacy",
      accountsEnabled: accounts,
      // Empty rather than "the configured ones" when accounts are off: a button
      // that starts a flow with nothing to fund is a dead end with a password
      // prompt in the middle of it.
      signinProviders: accounts ? signinProviders : [],
      freeTier: free
        ? {
            model: free.model,
            modelLabel: free.modelLabel,
            effort: free.effort,
            creditCents: free.creditCents,
          }
        : null,
    };
    res.json(body);
  });

  return router;
}
