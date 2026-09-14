// ─────────────────────────────────────────────────────────────────────────────
// boot-checks.ts — the two things about accounts that must be said at boot, not
// discovered by a visitor.
//
// Accounts have three ingredients: an OAuth client (id + secret), the origin the
// provider will redirect back to (`SLICELY_PUBLIC_URL`), and an owner key to fund
// the free credit. Get one wrong and the failure surfaces a long way from the
// cause:
//
//   • A BAD PUBLIC URL is the worst of the three, because everything looks fine
//     from here. `redirectUri()` happily builds "example.com/auth/google/callback"
//     out of "example.com", the provider rejects it as a mismatch, and the visitor
//     reads Google's error page rather than ours. There is no graceful degradation
//     to fall back on and nothing a restart discovers later, so a set-but-unusable
//     value REFUSES TO BOOT.
//   • A MISSING PUBLIC URL, or a missing owner key, does degrade gracefully by
//     design (spec §6: `accountsEnabled` needs all three, and the sign-in buttons
//     are withheld rather than offered as a dead end). But it degrades SILENTLY,
//     and an owner who set two OAuth clients did not mean to ship a
//     bring-your-own-key-only server. So it gets exactly one warning line.
//
// Both answers are pure functions of their inputs so they can be tested without
// an environment, a server, or a provider.
// ─────────────────────────────────────────────────────────────────────────────

/** The OAuth variables. Both halves of each pair, in the order the spec lists. */
const OAUTH_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

/** The two owner keys that can fund free credit. */
const OWNER_KEY_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * Why this value cannot be the app's public origin — or `undefined` if it can.
 *
 * Accepted: an `https:` origin, or an `http:` origin on loopback (localhost,
 * 127.0.0.1, ::1) so a developer can run the whole sign-in flow without a
 * certificate. Rejected: anything with a path, a query, a fragment, or
 * credentials in it, because the redirect URI is built by appending to this
 * string and a trailing path silently produces a URI no provider is registered
 * for.
 *
 * An EMPTY value is not this function's business: unset means "no OAuth", which
 * is a supported configuration (see `accountsBootWarning`).
 */
export function publicOriginProblem(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "it is not a URL — it needs a scheme, as in https://slicely.fly.dev";
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "it must be https (plain http is accepted only on localhost)";
  }
  if (url.username || url.password) {
    return "it must not carry a username or password";
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return "it must be a bare origin — scheme, host and port only, with no path, query or #fragment";
  }
  return undefined;
}

/** The message a refusal to boot carries. One sentence on what is wrong, one on
 *  why it matters, one on the two ways out. */
export function publicOriginFatal(raw: string, problem: string): string {
  return (
    `SLICELY_PUBLIC_URL is not usable: ${problem}. Got ${JSON.stringify(raw)}. ` +
    "Every OAuth redirect URI is built from this origin (and never from the Host header), so a " +
    "wrong value sends visitors to a callback address the provider will refuse — and the error " +
    "they see is the provider's, not ours. Set it to the origin this app is reached at, e.g. " +
    "https://slicely.fly.dev, or unset the OAuth client id and secret to run Slicely " +
    "bring-your-own-key only."
  );
}

export interface AccountsEnv {
  /** Any OAuth client id or secret is set. */
  oauthSecretsSet: boolean;
  /** `SLICELY_PUBLIC_URL`, as given. */
  publicUrl: string;
  /** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set. */
  ownerKeySet: boolean;
}

/**
 * The single boot warning, or `undefined` when there is nothing to say.
 *
 * At most ONE line, because two lines about the same disabled feature is noise:
 * the missing origin is reported first because it is the earlier gate, and the
 * owner will hit the second one on the next restart if it is also unset.
 */
export function accountsBootWarning(env: AccountsEnv): string | undefined {
  if (!env.oauthSecretsSet) return undefined;

  if (!env.publicUrl.trim()) {
    return (
      "accounts are DISABLED: an OAuth client id/secret is set, but SLICELY_PUBLIC_URL is not, " +
      "so no redirect URI can be built and no sign-in button is offered. Set it to this app's " +
      "own origin (e.g. https://slicely.fly.dev) to turn accounts on."
    );
  }

  if (!env.ownerKeySet) {
    return (
      "accounts are DISABLED: OAuth is configured, but neither ANTHROPIC_API_KEY nor " +
      "OPENAI_API_KEY is set, so there is no free credit to grant — and a sign-in button that " +
      "leads to no credit is worse than none, so it is withheld. Set one of the two keys to fund " +
      "the free tier, or leave it as is to run Slicely bring-your-own-key only."
    );
  }

  return undefined;
}

/**
 * Read the environment, refuse to boot on the fatal case, and log the one
 * warning. Called once from `createApp`, hosted mode only — the desktop app
 * mounts no `/auth` router at all, so none of this can bite there.
 */
export function runAccountsBootChecks(log: (message: string) => void = (m) => console.warn(m)): void {
  const publicUrl = process.env.SLICELY_PUBLIC_URL ?? "";
  const problem = publicOriginProblem(publicUrl);
  const oauthSecretsSet = OAUTH_ENV.some((name) => (process.env[name] ?? "").trim().length > 0);

  // The refusal is conditional on somebody actually wanting OAuth: a stray
  // SLICELY_PUBLIC_URL on a bring-your-own-key server is unused, and killing a
  // working deploy over an unused variable would be the wrong trade.
  if (problem && oauthSecretsSet) throw new Error(publicOriginFatal(publicUrl.trim(), problem));

  const warning = accountsBootWarning({
    oauthSecretsSet,
    publicUrl,
    ownerKeySet: OWNER_KEY_ENV.some((name) => (process.env[name] ?? "").trim().length > 0),
  });
  if (warning) log(`[accounts] ${warning}`);
}
