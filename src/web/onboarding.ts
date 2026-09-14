// ─────────────────────────────────────────────────────────────────────────────
// onboarding.ts — what a first-time visitor sees, and the one place that knows
// about the user's AI keys.
//
// Slicely is bring-your-own-key: the server never has an AI key of its own, so
// until the user connects one there is nothing to chat with.
//
// ONE CARD, ONE DECISION. The first run is a single card — a heading, one
// sentence, a choice of provider, a paste box, one Connect button. Everything
// else that used to live here (two side-by-side cards, two paragraphs of fine
// print, a repeated warning about subscriptions) was noise on the one screen
// where the user has exactly one thing to do. The subscription line is still
// said, but only to the person who actually pastes a subscription token.
//
// Once a key is connected, keys are not mentioned in the chat again: Settings →
// AI is the one place they are managed.
//
// The client only ever sees `{ hasKey, keyHint }` per provider — a key itself
// goes out in one PUT body and is never read back, never logged, never in a URL.
// ─────────────────────────────────────────────────────────────────────────────
import type { ProviderId, ProviderInfo } from "../shared/types";
import { ApiError, del, getJson, putJson, ready } from "./api.js";
import { buildSigninBlock, hasFreeCredit } from "./account.js";
import { externalLink, make, toast } from "./ui.js";

/** One way in, as this deploy offers it. Rendered as a button; pressing it is a
 *  top-level navigation, never a fetch. */
export interface SigninProvider {
  id: "google" | "github";
  label: string;
}

/** The free tier as this deploy is configured — the model the owner's credit
 *  runs on, and how much of it a new account is given. Null when there is no
 *  free tier (desktop, or no owner key), which is today's BYO-only product. */
export interface FreeTierInfo {
  model: string;
  modelLabel: string;
  effort: "medium";
  creditCents: number;
}

export interface AppConfig {
  mode: "hosted" | "desktop";
  /** Does ANY provider have a key? */
  hasKey: boolean;
  /** The hint for the provider the chosen model would bill. */
  keyHint?: string;
  providers: ProviderInfo[];
  multiUser: boolean;
  slicerAvailable: boolean;
  sourceCommit: string;
  version: string;
  repoUrl: string;
  termsUrl: string;
  privacyUrl: string;
  /** Can a stranger sign in here at all? False on desktop, false with no OAuth
   *  provider configured, and false with no free tier to hand them. */
  accountsEnabled: boolean;
  signinProviders: SigninProvider[];
  freeTier: FreeTierInfo | null;
}

/**
 * The per-provider copy the form is built from.
 *
 * THE SERVER OWNS MOST OF IT. `/api/config` ships each provider's `keyHelp`
 * (field label, placeholder, console URL and link text, and the refusal
 * sentence) straight from main/agent/provider-*.ts, and `help()` below prefers
 * it. What is left here is the fallback for a server too old to send
 * `providers`, or for /api/config being unreachable.
 */
interface ProviderHelp {
  id: ProviderId;
  label: string;
  keyLabel: string;
  placeholder: string;
  consoleUrl: string;
  consoleLabel: string;
  /** The client-side guess when the server sends no message. */
  formatMessage: string;
}

const PROVIDER_HELP: ProviderHelp[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    keyLabel: "Anthropic API key",
    placeholder: "sk-ant-…",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleLabel: "console.anthropic.com",
    formatMessage: "That doesn't look like an Anthropic API key — they start with sk-ant-api.",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyLabel: "OpenAI API key",
    placeholder: "sk-…",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com/api-keys",
    formatMessage: "That doesn't look like an OpenAI API key — they start with sk-.",
  },
];

function help(id: ProviderId): ProviderHelp {
  const fallback = PROVIDER_HELP.find((p) => p.id === id) ?? PROVIDER_HELP[0];
  const info = current.providers.find((p) => p.id === id);
  if (!info) return fallback;
  const wire = info.keyHelp;
  return {
    ...fallback,
    label: info.label || fallback.label,
    ...(wire
      ? {
          keyLabel: wire.label,
          placeholder: wire.placeholder,
          consoleUrl: wire.consoleUrl,
          consoleLabel: wire.consoleLabel,
          formatMessage: wire.formatMessage,
        }
      : {}),
  };
}

/** What /api/config said about one provider, or a keyless placeholder for a
 *  server too old to mention it. */
function providerState(id: ProviderId): ProviderInfo {
  return current.providers.find((p) => p.id === id) ?? { id, label: help(id).label, hasKey: false };
}

/**
 * What to assume when /api/config cannot be reached.
 *
 * `hasKey: true` on purpose: an older server that has no /api/config also has no
 * key route to offer, and nagging the user to connect a key the server would not
 * accept is worse than staying quiet. A real hosted server always answers, and
 * a `no_key` reply from /api/chat still says so.
 *
 * `accountsEnabled: false` for the same reason read the other way round: with no
 * answer from the server, the safe guess is the product that needs no server
 * feature at all — bring your own key. Offering a sign-in button that leads
 * nowhere would be worse than not offering one.
 */
const ASSUMED: AppConfig = {
  mode: "desktop",
  hasKey: true,
  providers: [],
  multiUser: false,
  slicerAvailable: true,
  sourceCommit: "",
  version: "",
  repoUrl: "",
  termsUrl: "/terms",
  privacyUrl: "/privacy",
  accountsEnabled: false,
  signinProviders: [],
  freeTier: null,
};

let current: AppConfig = ASSUMED;
let loaded = false;
const listeners = new Set<() => void>();

/** Notified whenever the config changes — a key connected or removed. */
export function onConfigChange(fn: () => void): void {
  listeners.add(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function config(): AppConfig {
  return current;
}

export function hasKey(): boolean {
  return current.hasKey;
}

/**
 * What a server that predates accounts left out.
 *
 * `/api/config` is read straight into `AppConfig`, so any field an older build
 * does not send arrives as `undefined` — and `config().signinProviders.map(…)`
 * on an undefined is a blank page, not a missing button. The three account
 * fields are therefore filled in on the way through, defaulted to the BYO-only
 * product.
 */
function withAccountDefaults(raw: AppConfig): AppConfig {
  return {
    ...raw,
    accountsEnabled: raw.accountsEnabled === true,
    signinProviders: Array.isArray(raw.signinProviders) ? raw.signinProviders : [],
    freeTier: raw.freeTier ?? null,
  };
}

/** True when this deploy can sign a stranger in and fund their first turns. */
export function accountsEnabled(): boolean {
  return current.accountsEnabled;
}

/** The sign-in buttons to draw, in the order the server listed them. */
export function signinProviders(): SigninProvider[] {
  return current.signinProviders;
}

/** The free tier as configured here, or null when there isn't one. */
export function freeTier(): FreeTierInfo | null {
  return current.freeTier;
}

/** False when /api/config could not be reached, so the client is working from
 *  assumptions. Anything that would state a fact about the account — "your key
 *  is connected" — should stay quiet rather than make one up. */
export function configLoaded(): boolean {
  return loaded;
}

/**
 * Read the config the boot call already fetched.
 *
 * `ready()` IS `GET /api/config` — the one request api.ts lets out before any
 * other, because it is what gives this browser its session cookie.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    current = withAccountDefaults((await ready()) as unknown as AppConfig);
    loaded = true;
  } catch {
    current = ASSUMED;
    loaded = false;
  }
  emit();
  return current;
}

/**
 * Read /api/config again.
 *
 * `loadConfig` reads the boot call's cached answer, which is the right thing on
 * load and the wrong thing afterwards: when a turn comes back saying the key is
 * missing or rejected, the cached answer is exactly the one that is out of date.
 */
export async function refreshConfig(): Promise<void> {
  try {
    current = withAccountDefaults(await getJson<AppConfig>("/api/config"));
    loaded = true;
    emit();
  } catch {
    /* keep what we had — a failed refresh is not news about the account */
  }
}

// ── the key form ─────────────────────────────────────────────────────────────

const CONNECT_HEADING = "Connect an AI provider to start";
const CONNECT_LEAD =
  "Slicely uses your own API key. It stays encrypted and is only sent to the provider you choose.";
const WHERE_LINK = "Where do I get one?";
const REJECTED_MESSAGE = "That key was rejected.";
/** Said only to someone who actually pastes one, rather than warned about twice
 *  on a screen where most people are pasting the right thing. */
const SUBSCRIPTION_NOTE =
  "That looks like a subscription token. Slicely needs an API key from the provider's console — Claude Pro/Max and ChatGPT Plus can't be used.";

let keyFieldSeq = 0;

/** Claude Pro/Max hands out `sk-ant-oat…`/`sk-ant-ort…` OAuth tokens; a ChatGPT
 *  session token is a JWT. Neither is an API key, and neither provider permits
 *  it outside its own apps. */
function looksLikeSubscriptionToken(value: string): boolean {
  const t = value.trim();
  return /^sk-ant-(oat|ort|sid)/i.test(t) || /^eyJ[A-Za-z0-9_-]/.test(t);
}

export interface KeyFormOptions {
  /** A Cancel button, for the Settings rows where the form is an expansion of
   *  something that was already on screen. */
  onCancel?(): void;
  /** After a key is accepted. */
  onConnected?(): void;
}

/**
 * The paste box for one provider: label, field, where-to-get-one, Connect.
 *
 * The same form is the whole of the first-run card's body and the whole of a
 * Settings row's expansion, so there is exactly one place that knows how a key
 * is submitted and what each refusal means.
 */
function buildKeyForm(id: ProviderId, opts: KeyFormOptions = {}): HTMLFormElement {
  const h = help(id);
  const inputId = `apiKeyInput${++keyFieldSeq}`;

  const form = make("form", "key-form");
  const label = make("label", "key-label", h.keyLabel);
  label.htmlFor = inputId;

  const row = make("div", "key-row");
  const input = make("input", "key-input");
  input.id = inputId;
  input.type = "password";
  input.name = "apiKey";
  input.placeholder = h.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  const reveal = make("button", "btn ghost small key-reveal", "Show");
  reveal.type = "button";
  reveal.setAttribute("aria-label", `Show the ${h.label} key`);
  reveal.addEventListener("click", () => {
    const shown = input.type === "password";
    input.type = shown ? "text" : "password";
    reveal.textContent = shown ? "Hide" : "Show";
    reveal.setAttribute("aria-label", shown ? `Hide the ${h.label} key` : `Show the ${h.label} key`);
  });
  row.append(input, reveal);

  const note = make("p", "key-note hidden", SUBSCRIPTION_NOTE);
  note.setAttribute("role", "status");
  const error = make("p", "key-error hidden");
  error.setAttribute("role", "alert");

  const actions = make("div", "key-actions");
  actions.appendChild(externalLink(h.consoleUrl, WHERE_LINK));
  if (opts.onCancel) {
    const cancel = make("button", "btn ghost", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => opts.onCancel?.());
    actions.appendChild(cancel);
  }
  const submit = make("button", "btn primary", "Connect");
  submit.type = "submit";
  actions.appendChild(submit);

  form.append(label, row, note, error, actions);

  input.addEventListener("input", () => {
    note.classList.toggle("hidden", !looksLikeSubscriptionToken(input.value));
  });

  function fail(message: string): void {
    error.textContent = message;
    error.classList.remove("hidden");
    input.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const apiKey = input.value.trim();
    error.classList.add("hidden");
    if (!apiKey) {
      fail(`Paste your ${h.label} key first.`);
      return;
    }
    submit.disabled = true;
    submit.textContent = "Checking…";
    void (async () => {
      try {
        const result = await putJson<{ hasKey: true; provider: ProviderId; keyHint: string }>("/api/key", {
          provider: id,
          apiKey,
        });
        input.value = "";
        rememberKey(id, result.keyHint);
        toast(`${h.label} connected · ${result.keyHint}`, "success");
        opts.onConnected?.();
        emit();
      } catch (err) {
        const api = err instanceof ApiError ? err : undefined;
        if (api?.code === "key_invalid_format" || api?.status === 400) fail(api?.message || h.formatMessage);
        else if (api?.code === "key_rejected" || api?.status === 401) fail(api?.message || REJECTED_MESSAGE);
        else fail((err as Error).message || `Couldn't reach ${h.label} to check that key.`);
      } finally {
        submit.disabled = false;
        submit.textContent = "Connect";
      }
    })();
  });

  return form;
}

/**
 * The first-run card.
 *
 * Two shapes, one card. On a deploy with a free tier the card is the sign-in
 * block: a title, one sentence, a button per provider and a plain link for
 * people who already have an API key — pressing that link swaps the key form
 * in, in place, so nobody has to go looking for it. With accounts off the card
 * is byte-for-byte the one it has always been: a heading, one sentence, a choice
 * of provider, a paste box.
 */
export function buildConnectCard(): HTMLElement {
  const card = make("section", "connect");
  const signin = buildSigninBlock(() => {
    card.replaceChildren(buildKeyCard());
    // The link was pressed to type a key, so put the keyboard where the key
    // goes rather than leaving it on a button that no longer exists.
    card.querySelector<HTMLInputElement>(".key-input")?.focus();
  });
  card.appendChild(signin ?? buildKeyCard());
  return card;
}

/** The key card's own contents: heading, sentence, provider choice, paste box.
 *  A fragment rather than a card of its own, so it can be swapped into the
 *  first-run card in place without the card moving or changing size abruptly. */
function buildKeyCard(): DocumentFragment {
  const card = document.createDocumentFragment();
  const titleId = `connectTitle${++keyFieldSeq}`;
  const title = make("h2", "connect-title", CONNECT_HEADING);
  title.id = titleId;
  card.append(title, make("p", "connect-lead", CONNECT_LEAD));

  const choice = make("div", "provider-choice");
  choice.setAttribute("role", "radiogroup");
  choice.setAttribute("aria-labelledby", titleId);
  const slot = make("div", "connect-slot");

  let chosen: ProviderId = PROVIDER_HELP[0].id;
  const buttons = PROVIDER_HELP.map((p) => {
    const b = make("button", "provider-option", help(p.id).label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => select(p.id));
    return b;
  });

  function paint(): void {
    buttons.forEach((b, i) => {
      const on = PROVIDER_HELP[i].id === chosen;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
  }

  function select(id: ProviderId, focus = false): void {
    chosen = id;
    paint();
    slot.replaceChildren(buildKeyForm(chosen));
    if (focus) buttons[PROVIDER_HELP.findIndex((p) => p.id === id)]?.focus();
  }

  // Arrow keys move between radios, which is how a radiogroup is meant to work.
  choice.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const at = PROVIDER_HELP.findIndex((p) => p.id === chosen);
    const next = PROVIDER_HELP[(at + step + PROVIDER_HELP.length) % PROVIDER_HELP.length];
    select(next.id, true);
  });

  for (const b of buttons) choice.appendChild(b);
  card.append(choice, slot);
  select(chosen);
  return card;
}

/** Record a connected key locally, so the UI reflects it without another
 *  /api/config round trip. */
function rememberKey(id: ProviderId, keyHint: string | undefined): void {
  const providers = PROVIDER_HELP.map((h) => {
    const existing = providerState(h.id);
    return h.id === id ? { ...existing, hasKey: true, keyHint } : existing;
  });
  const active = current.providers.find((p) => p.id === id);
  current = {
    ...current,
    hasKey: providers.some((p) => p.hasKey),
    // The top-level hint describes the ACTIVE model's provider, which only
    // changed if that is the one just connected.
    keyHint: active && current.keyHint === active.keyHint ? keyHint : current.keyHint,
    providers,
  };
}

function forgetKey(id: ProviderId): void {
  const providers = PROVIDER_HELP.map((h) => {
    const existing = providerState(h.id);
    return h.id === id ? { ...existing, hasKey: false, keyHint: undefined } : existing;
  });
  current = {
    ...current,
    hasKey: providers.some((p) => p.hasKey),
    keyHint: providers.some((p) => p.hasKey) ? current.keyHint : undefined,
    providers,
  };
}

// ── the empty state ──────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  "Find me a phone stand I can print today",
  "Slice this for strength, PETG, my Ender 3",
  "Show me a cable clip for a desk",
];

/**
 * The transcript's empty state.
 *
 * With a key connected it is the invitation to type something. Without one it is
 * the connect card and nothing else — the three-step tour that used to sit under
 * it described work the user cannot start yet.
 */
export function buildEmptyState(onExample: (prompt: string) => void): HTMLElement {
  // Somebody signed in with credit to spend needs no card at all: they can type
  // straight away, and being shown a way to start when they have already started
  // is the same noise as the old three-step tour.
  if (!current.hasKey && !hasFreeCredit()) {
    const first = make("div", "empty onboarding");
    first.appendChild(buildConnectCard());
    return first;
  }

  const empty = make("div", "empty");
  const mark = make("span", "big", "◆");
  mark.setAttribute("aria-hidden", "true");
  empty.appendChild(mark);
  const p = make("p");
  p.appendChild(document.createTextNode("Find a "));
  p.appendChild(make("b", "", "free 3D model"));
  p.appendChild(document.createTextNode(", slice it, and print. Right from your phone."));
  empty.appendChild(p);
  const examples = make("div", "examples");
  for (const ex of EXAMPLE_PROMPTS) {
    const b = make("button", "ex", ex);
    b.type = "button";
    b.onclick = () => onExample(ex);
    examples.appendChild(b);
  }
  empty.appendChild(examples);
  return empty;
}

// ── the consent line ─────────────────────────────────────────────────────────

const CONSENT_KEY = "slicely:consentDismissed";

function consentDismissed(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

/** A one-line, one-time notice above the composer. Dismissed for good once the
 *  user has read it — it is a notice, not a gate. */
export function initConsent(host: HTMLElement): void {
  if (consentDismissed()) return;
  host.replaceChildren();
  const line = make("span", "consent-text");
  line.appendChild(document.createTextNode("By continuing you agree to the "));
  line.appendChild(externalLink(current.termsUrl, "Terms"));
  line.appendChild(document.createTextNode(" and "));
  line.appendChild(externalLink(current.privacyUrl, "Privacy Policy"));
  line.appendChild(document.createTextNode("."));
  const dismiss = make("button", "consent-dismiss", "×");
  dismiss.type = "button";
  dismiss.title = "Got it";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.addEventListener("click", () => {
    host.classList.add("hidden");
    try {
      localStorage.setItem(CONSENT_KEY, "1");
    } catch {
      /* private browsing — it will show again, which is harmless */
    }
  });
  host.append(line, dismiss);
  host.classList.remove("hidden");
}

// ── Settings → AI / About ────────────────────────────────────────────────────

/**
 * Settings → AI. One row per provider: name, status, one action.
 *
 * Every provider is always listed, connected or not — this is the panel a user
 * opens to find out what they can switch to, and a provider that only appears
 * once you already have its key answers that question backwards.
 */
export function renderAiSection(host: HTMLElement): void {
  host.replaceChildren();
  const list = make("div", "ai-rows");
  for (const h of PROVIDER_HELP) list.appendChild(providerRow(h, host));
  host.appendChild(list);
}

/** One provider in Settings → AI, collapsed to a single line until there is
 *  something to type. */
function providerRow(h: ProviderHelp, host: HTMLElement): HTMLElement {
  const state = providerState(h.id);
  const row = make("div", "ai-row");
  const head = make("div", "ai-row-head");
  const text = make("div", "ai-text");
  text.appendChild(make("span", "ai-name", h.label));
  text.appendChild(
    make("span", "ai-status", state.hasKey ? `Connected · ${state.keyHint ?? "key on file"}` : "Not connected"),
  );
  head.appendChild(text);

  const actions = make("div", "ai-actions");
  const slot = make("div", "ai-row-form");

  function collapse(): void {
    slot.replaceChildren();
    actions.classList.remove("hidden");
  }
  function expand(): void {
    actions.classList.add("hidden");
    slot.replaceChildren(
      buildKeyForm(h.id, { onCancel: collapse, onConnected: () => renderAiSection(host) }),
    );
    slot.querySelector<HTMLInputElement>(".key-input")?.focus();
  }

  const connect = make("button", "btn ghost small", state.hasKey ? "Replace" : "Connect");
  connect.type = "button";
  connect.setAttribute("aria-label", state.hasKey ? `Replace the ${h.label} key` : `Connect an ${h.label} key`);
  connect.addEventListener("click", expand);
  actions.appendChild(connect);

  if (state.hasKey) {
    const remove = make("button", "btn ghost small danger", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove the ${h.label} key`);
    remove.addEventListener("click", () => {
      void (async () => {
        try {
          // The provider goes in the query, not a DELETE body: removing the
          // wrong one would disconnect the key the user meant to keep.
          await del(`/api/key?provider=${encodeURIComponent(h.id)}`);
          forgetKey(h.id);
          toast(`${h.label} key removed.`, "info");
          emit();
          renderAiSection(host);
        } catch (err) {
          toast((err as Error).message || `Couldn't remove the ${h.label} key.`, "error");
        }
      })();
    });
    actions.appendChild(remove);
  }

  head.appendChild(actions);
  row.append(head, slot);
  return row;
}

/** Which providers this session has a key for — what the model picker needs to
 *  know to disable the models it cannot pay for. */
export function providersWithKeys(): ProviderId[] {
  return current.providers.filter((p) => p.hasKey).map((p) => p.id);
}

/** How a provider is named in the UI, for a message about a model of theirs. */
export function providerLabel(id: ProviderId): string {
  return current.providers.find((p) => p.id === id)?.label ?? help(id).label;
}

/** Put the keyboard on the first thing in Settings → AI that connects a key —
 *  where the composer's "Connect" link sends you. */
export function focusFirstConnect(host: HTMLElement): void {
  host.querySelector<HTMLButtonElement>(".ai-actions .btn")?.focus();
}

/** Settings → About: what this build is, and where its terms live. */
export function renderAboutSection(host: HTMLElement): void {
  host.replaceChildren();
  const rows = make("div", "about-rows");
  if (current.version) rows.appendChild(make("div", "about-row", `Version ${current.version}`));
  const links = make("div", "about-links");
  if (current.repoUrl) {
    links.appendChild(
      current.sourceCommit
        ? externalLink(`${current.repoUrl}/tree/${current.sourceCommit}`, "Source (this build)")
        : externalLink(current.repoUrl, "Source"),
    );
  }
  links.appendChild(externalLink(current.termsUrl, "Terms"));
  links.appendChild(externalLink(current.privacyUrl, "Privacy"));
  rows.appendChild(links);
  host.appendChild(rows);
}
