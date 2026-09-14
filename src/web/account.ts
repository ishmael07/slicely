// ─────────────────────────────────────────────────────────────────────────────
// account.ts — signing in, and what is left of the free credit.
//
// Slicely is still bring-your-own-key: this module is what a HOSTED deploy adds
// on top of that, and every part of it disappears when `/api/config` says
// accounts are off (desktop, or no OAuth provider configured). Nothing here
// ever renders a claim it cannot support — with no config and no `/api/me`
// there are no buttons, no pill and no balance, which is byte-for-byte today's
// product.
//
// THE PROVIDER BUTTONS ARE ANCHORS, NOT FETCHES. OAuth needs a top-level
// navigation, the CSP allows exactly that and nothing else, and there is no
// third-party logo file to load — the buttons are plain words in the app's own
// type, like every other button here.
// ─────────────────────────────────────────────────────────────────────────────
import { account, errorMessage, postJson, refreshAccount, setAccount } from "./api.js";
import { config } from "./onboarding.js";
import { byId, make, menu, toast } from "./ui.js";

// ── signing in ───────────────────────────────────────────────────────────────

const SIGNIN_TITLE = "Sign in to start — free to try";
const USE_OWN_KEY = "or use your own API key";

/** Where a provider button goes. `return_to` is a path on this origin only —
 *  the server validates it again and refuses anything else, so an open redirect
 *  cannot be built out of it from here. */
export function signinHref(provider: string): string {
  const back = location.pathname + location.search;
  return `/auth/${encodeURIComponent(provider)}/start?return_to=${encodeURIComponent(back)}`;
}

/** The grant, said the way a person says it: "50 cents", or "$1.50" once it is
 *  more than a dollar. */
function creditWords(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "free credit";
  if (cents < 100) return `${Math.round(cents)} cents`;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The first thing a visitor sees on a deploy that has a free tier: a title, one
 * sentence, one button per provider, and a link for the people who already have
 * an API key.
 *
 * Returns `undefined` when accounts are off, and the caller then renders exactly
 * the key card it always did.
 */
export function buildSigninBlock(onUseOwnKey: () => void): HTMLElement | undefined {
  const cfg = config();
  if (!cfg.accountsEnabled || cfg.signinProviders.length === 0) return undefined;

  const block = make("div", "signin");
  const free = cfg.freeTier;
  block.append(
    make("h2", "connect-title", SIGNIN_TITLE),
    make(
      "p",
      "connect-lead",
      free
        ? `You get ${creditWords(free.creditCents)} of Slicely's AI credit — no card, no trial timer.`
        : "No card, no trial timer.",
    ),
  );

  const buttons = make("div", "signin-buttons");
  cfg.signinProviders.forEach((p, i) => {
    // The first provider carries the primary style: one obvious way in, with the
    // other beside it — not two equal-weight decisions to make before starting.
    const a = make("a", `btn${i === 0 ? " primary" : ""}`, `Continue with ${p.label}`);
    a.href = signinHref(p.id);
    buttons.appendChild(a);
  });
  block.appendChild(buttons);

  const own = make("button", "link-btn signin-own", USE_OWN_KEY);
  own.type = "button";
  own.addEventListener("click", () => onUseOwnKey());
  block.appendChild(own);

  return block;
}

// ── coming back from the provider ────────────────────────────────────────────

/**
 * A failed sign-in comes back as `/#auth_error=<code>`, because the callback
 * has no page of its own to say it on.
 *
 * Read once and cleared from the URL immediately, so a reload does not repeat a
 * complaint about something that happened a minute ago.
 */
export function readAuthErrorFromHash(): string | undefined {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return undefined;
  const code = new URLSearchParams(hash).get("auth_error");
  if (!code) return undefined;
  history.replaceState(null, "", location.pathname + location.search);
  return /^[a-z_]{1,40}$/.test(code) ? code : "oauth_failed";
}

// ── the header pill ──────────────────────────────────────────────────────────
//
// One button in the corner that answers the two questions a person on free
// credit keeps asking: am I signed in, and how much is left. It is the only
// always-visible account surface, so it is also where signing out lives.

export interface AccountDeps {
  /** Open Settings → AI with the first key field focused. */
  openAiSettings(): void;
}

export interface AccountApi {
  /** Re-read `/api/me` and repaint. */
  refresh(): Promise<void>;
}

let deps: AccountDeps;
let pill: HTMLButtonElement | undefined;
let initialEl: HTMLElement;
let balanceEl: HTMLElement;

/**
 * Paint the pill from the one account store.
 *
 * Three states and no fourth: hidden where there are no accounts at all
 * (desktop, or a BYO-only server), "Sign in" where there are and nobody is,
 * and a monogram plus the balance once somebody is.
 */
export function renderAccountPill(): void {
  if (!pill) return;
  const on = config().accountsEnabled;
  pill.hidden = !on;
  if (!on) return;

  const me = account();
  const acct = me.signedIn ? me.account : undefined;
  if (acct) {
    initialEl.textContent = acct.initial || acct.email.slice(0, 1).toUpperCase();
    initialEl.hidden = false;
    balanceEl.textContent = acct.balanceLabel;
    pill.title = acct.email;
    pill.setAttribute("aria-label", `${acct.email} — ${acct.balanceLabel} of free credit left`);
  } else {
    // No monogram for nobody: the pill is a plain "Sign in" button until there
    // is a person to stand for.
    initialEl.hidden = true;
    balanceEl.textContent = "Sign in";
    pill.title = "Sign in to Slicely";
    pill.setAttribute("aria-label", "Sign in to Slicely");
  }
}

function openAccountMenu(): void {
  if (!pill) return;
  const me = account();
  const acct = me.signedIn ? me.account : undefined;

  if (!acct) {
    // Signed out: the pill offers the same two doors as the first-run card, so
    // somebody who pasted a key first can still sign in later.
    menu(
      pill,
      config().signinProviders.map((p) => ({ id: p.id, label: `Continue with ${p.label}` })),
      (id) => location.assign(signinHref(id)),
    );
    return;
  }

  menu(
    pill,
    [
      // Who you are and what is left, as one quiet, unclickable row.
      {
        id: "who",
        label: acct.email,
        hint: `${acct.balanceLabel} left of ${acct.grantedLabel} free credit`,
        disabled: true,
      },
      { id: "key", label: "Add your own key…" },
      { id: "signout", label: "Sign out" },
    ],
    (id) => {
      if (id === "key") deps.openAiSettings();
      if (id === "signout") void signOut();
    },
  );
}

async function signOut(): Promise<void> {
  try {
    await postJson("/api/auth/signout", {});
    // The workspace, the chats and any key of their own all stay — signing out
    // only forgets which account was paying.
    setAccount({ signedIn: false });
    toast("Signed out.", "info");
  } catch (err) {
    toast(errorMessage(err, "Couldn't sign you out."), "error");
  }
}

/** Wire the pill up. Called once from app.ts's boot, before the first paint. */
export function initAccount(d: AccountDeps): AccountApi {
  deps = d;
  pill = byId<HTMLButtonElement>("accountPill");
  initialEl = byId<HTMLElement>("accountInitial");
  balanceEl = byId<HTMLElement>("accountBalance");
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    openAccountMenu();
  });
  renderAccountPill();
  return {
    refresh: async () => {
      // Only ever ask a server that says it has accounts. On desktop there is
      // no such route, and a 404 on every boot is noise in someone's log.
      if (!config().accountsEnabled) return;
      await refreshAccount();
    },
  };
}

// ── what the rest of the client asks about the account ───────────────────────

/** Signed in with credit still on the account — the state in which a visitor
 *  can chat without a key of their own. */
export function hasFreeCredit(): boolean {
  const me = account();
  return Boolean(me.signedIn && me.account && !me.account.exhausted);
}

/** Signed in, but the credit is gone. The one state with its own card and its
 *  own composer line. */
export function creditExhausted(): boolean {
  const me = account();
  return Boolean(me.signedIn && me.account?.exhausted);
}
