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
import { ApiError, account, codeMessage, errorMessage, postJson, refreshAccount, setAccount } from "./api.js";
import { buildConnectCard, config } from "./onboarding.js";
import { byId, make, menu, openSheet, toast } from "./ui.js";

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
  // Already signed in — even with the credit spent, there is nothing to sign in
  // to, and "Sign in to start" would be nonsense. The caller falls back to the
  // key card, which is the one thing left to do.
  if (account().signedIn) return undefined;

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
      { id: "waitlist", label: "Paid plans — coming soon" },
      { id: "signout", label: "Sign out" },
    ],
    (id) => {
      if (id === "key") deps.openAiSettings();
      if (id === "waitlist") openWaitlist();
      if (id === "signout") void signOut();
    },
  );
}

/** Sign out: the account is forgotten, everything else — the workspace, the
 *  chats, any key of their own — stays exactly where it was. Shared with the
 *  Settings row, so there is one place that knows what signing out means. */
export async function signOut(): Promise<void> {
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

// ── the credit states, in the transcript ─────────────────────────────────────
//
// Two endings need a card rather than a line: the credit running out, and the
// day's shared budget running out. Both are calm — nothing broke, a free trial
// finished — so they are the app's ordinary card, not the red one a failure
// gets, and both offer the same two ways forward.

export type CreditState = "credit_exhausted" | "free_tier_paused";

const CREDIT_COPY: Record<CreditState, { title: string; body: string }> = {
  credit_exhausted: {
    title: "You've used your free credit.",
    body: "Add your own API key to keep going — your provider bills you directly, usually a few cents a session. Or join the waitlist for a paid plan.",
  },
  free_tier_paused: {
    title: "Free usage is busy today.",
    body: "Slicely's shared credit for today is used up. Add your own API key to keep going, or come back tomorrow.",
  },
};

export interface CreditCardDeps {
  onAddKey(): void;
  onWaitlist(): void;
}

/** The card the transcript shows when free credit can pay for nothing more. */
export function buildCreditCard(state: CreditState, on: CreditCardDeps): HTMLElement {
  const copy = CREDIT_COPY[state];
  const card = make("div", "credit-card");
  card.setAttribute("role", "group");
  card.append(make("h3", "credit-title", copy.title), make("p", "credit-body", copy.body));

  const actions = make("div", "credit-actions");
  const key = make("button", "btn primary", "Add my own key");
  key.type = "button";
  key.addEventListener("click", () => on.onAddKey());
  const list = make("button", "btn", "Join the waitlist");
  list.type = "button";
  list.addEventListener("click", () => on.onWaitlist());
  actions.append(key, list);
  card.appendChild(actions);
  return card;
}

/**
 * The card for a turn the server refused because nobody is signed in.
 *
 * It must not pick a provider on the user's behalf, so it is the first-run card
 * itself — both buttons, and the link to a key of their own — rather than a
 * single "Sign in" button that would quietly choose Google.
 */
export function buildSigninCard(): HTMLElement {
  return buildConnectCard();
}

/** A `credit` frame at the end of a metered turn. No fetch: the server has just
 *  told us the new balance, so the pill repaints from that. */
export function applyCreditEvent(e: {
  balanceMicros?: number;
  balanceLabel?: string;
  exhausted?: boolean;
}): void {
  const me = account();
  if (!me.signedIn || !me.account) return;
  setAccount({
    signedIn: true,
    account: {
      ...me.account,
      balanceMicros: e.balanceMicros ?? me.account.balanceMicros,
      balanceLabel: e.balanceLabel ?? me.account.balanceLabel,
      exhausted: e.exhausted ?? me.account.exhausted,
    },
  });
}

/** A refusal that says the credit is gone is also news about the balance — the
 *  pill and the composer line should not still be promising 2 cents. */
export function markExhausted(): void {
  const me = account();
  if (!me.signedIn || !me.account || me.account.exhausted) return;
  setAccount({
    signedIn: true,
    account: { ...me.account, balanceMicros: 0, balanceLabel: "$0.00", exhausted: true },
  });
}

// ── the waitlist sheet ───────────────────────────────────────────────────────
//
// The one thing Slicely can honestly offer somebody whose free credit is gone
// and who does not want to paste a key: tell us where to write when there is a
// paid plan. One sentence, two fields (one of them optional), one button, and a
// thank-you that replaces the form so it cannot be sent twice.

const WAITLIST_LEAD =
  "We're building a paid plan with a bigger budget and every model. Leave your email and we'll tell you when it opens — we won't use it for anything else.";
const WAITLIST_THANKS = "You're on the list. We'll email you once, when it opens.";

let waitlistBody: HTMLElement | undefined;

function buildWaitlistForm(): HTMLFormElement {
  const form = make("form", "waitlist-form");
  form.appendChild(make("p", "sheet-hint waitlist-lead", WAITLIST_LEAD));

  const fields = make("div", "fields");
  const emailField = make("div", "field");
  const emailLabel = make("label", "", "Email");
  emailLabel.htmlFor = "waitlistEmail";
  const email = make("input", "");
  email.id = "waitlistEmail";
  email.type = "email";
  email.name = "email";
  email.autocomplete = "email";
  email.placeholder = "you@example.com";
  emailField.append(emailLabel, email);

  const nameField = make("div", "field");
  const nameLabel = make("label", "", "Name");
  nameLabel.htmlFor = "waitlistName";
  const name = make("input", "");
  name.id = "waitlistName";
  name.type = "text";
  name.name = "name";
  name.autocomplete = "name";
  name.placeholder = "Optional";
  nameField.append(nameLabel, name);
  fields.append(emailField, nameField);

  const error = make("p", "key-error hidden");
  error.setAttribute("role", "alert");
  const submit = make("button", "btn primary", "Add me to the list");
  submit.type = "submit";

  const actions = make("div", "group-actions");
  actions.appendChild(submit);
  form.append(fields, error, actions);

  // Prefill from the account, because the person asking is usually the person
  // already signed in — and nobody should type their address twice.
  const me = account();
  if (me.account?.email) email.value = me.account.email;
  if (me.account?.name) name.value = me.account.name;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    error.classList.add("hidden");
    const address = email.value.trim();
    if (!address) {
      error.textContent = "Enter your email address first.";
      error.classList.remove("hidden");
      email.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Adding…";
    void (async () => {
      try {
        await postJson("/api/waitlist", { email: address, name: name.value.trim() || undefined });
        waitlistBody?.replaceChildren(make("p", "waitlist-thanks", WAITLIST_THANKS));
      } catch (err) {
        // A refused address is a fact about THIS field, so it is said under the
        // field rather than thrown across the screen as a toast.
        error.textContent =
          (err instanceof ApiError && codeMessage(err.code)) || errorMessage(err, "Couldn't add you to the list.");
        error.classList.remove("hidden");
        email.focus();
      } finally {
        submit.disabled = false;
        submit.textContent = "Add me to the list";
      }
    })();
  });

  return form;
}

/** Open the waitlist sheet, freshly built, with the keyboard in the first field
 *  that still needs an answer. */
export function openWaitlist(): void {
  waitlistBody ??= byId<HTMLElement>("waitlistBody");
  waitlistBody.replaceChildren(buildWaitlistForm());
  openSheet("waitlist");
  // The keyboard goes to the first field that still needs an answer — and, when
  // the account already answered both, to the button, which is all that is left
  // to do.
  const fields = [
    waitlistBody.querySelector<HTMLInputElement>("#waitlistEmail"),
    waitlistBody.querySelector<HTMLInputElement>("#waitlistName"),
  ];
  const empty = fields.find((f) => f && !f.value);
  (empty ?? waitlistBody.querySelector<HTMLButtonElement>(".waitlist-form .btn"))?.focus();
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
