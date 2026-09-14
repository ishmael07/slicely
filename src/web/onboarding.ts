// ─────────────────────────────────────────────────────────────────────────────
// onboarding.ts — what a first-time visitor sees, and the one place that knows
// about the user's AI keys.
//
// Slicely is bring-your-own-key: the server never has an AI key of its own, so
// until the user connects one there is nothing to chat with. That is stated
// plainly rather than discovered by pressing Send and getting an error, and the
// same cards are used in the empty state, in Settings → AI, and in the
// transcript when a turn comes back with `no_key`.
//
// TWO PROVIDERS, ONE CARD EACH. Anthropic and OpenAI are offered side by side
// and either alone is enough — a user with one key is not a user without a key.
// Each card carries its own field label, placeholder, console link and refusal
// message, because the two keys look nothing alike and "that key looks wrong"
// with no prefix to compare against is not help.
//
// The one thing both cards say, up front: A SUBSCRIPTION IS NOT AN API KEY.
// Claude Pro/Max and ChatGPT Plus are the two things people arrive expecting to
// use, and neither provider permits it outside its own apps. Said here, once,
// rather than learned from a 401.
//
// The client only ever sees `{ hasKey, keyHint }` per provider — a key itself
// goes out in one PUT body and is never read back, never logged, never in a URL.
// ─────────────────────────────────────────────────────────────────────────────
import type { ProviderId, ProviderInfo } from "../shared/types";
import { ApiError, del, putJson, ready } from "./api.js";
import { externalLink, make, toast } from "./ui.js";

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
}

/**
 * The per-provider copy the cards are built from.
 *
 * THE SERVER OWNS MOST OF IT. `/api/config` ships each provider's `keyHelp`
 * (field label, placeholder, console URL and link text, and the refusal sentence)
 * straight from main/agent/provider-*.ts, and `help()` below prefers it. What is
 * left here is a fallback for the ASSUMED config — a server too old to send
 * `providers`, or /api/config unreachable — plus `detail`, which is onboarding
 * copy rather than anything the key route knows about.
 *
 * Keeping the whole table client-side was two tables for one truth: a corrected
 * console URL on the server left the card pointing at the old one.
 */
interface ProviderHelp {
  id: ProviderId;
  label: string;
  keyLabel: string;
  placeholder: string;
  consoleUrl: string;
  consoleLabel: string;
  /** Where the key comes from, and which subscription will not do. */
  detail: string;
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
    detail:
      "Create one under Settings → API keys. Claude Pro/Max can't be used — Anthropic allows subscription logins only in its own apps.",
    formatMessage: "That doesn't look like an Anthropic API key — they start with sk-ant-api.",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyLabel: "OpenAI API key",
    placeholder: "sk-…",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com/api-keys",
    detail:
      "Create one under API keys. ChatGPT Plus/Pro can't be used — OpenAI allows subscription sign-in only in its own apps.",
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
 * key card to offer, and nagging the user to connect a key the server would not
 * accept is worse than staying quiet. A real hosted server always answers, and
 * a `no_key` reply from /api/chat still opens the card.
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
 * other, because it is what gives this browser its session cookie. Fetching it
 * again here would be a second call for bytes we already have (and, on a first
 * load, a second workspace on any server that still minted one per request).
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    current = (await ready()) as unknown as AppConfig;
    loaded = true;
  } catch {
    current = ASSUMED;
    loaded = false;
  }
  emit();
  return current;
}

// ── the key cards ────────────────────────────────────────────────────────────

/**
 * The fine print, said once for both cards — and said BELOW them.
 *
 * Three paragraphs above the fields pushed the fields themselves off the first
 * screen, which is exactly backwards: someone who already has a key wants to
 * paste it, and someone who doesn't is going to read either way.
 */
const KEY_FINE_PRINT: Array<Array<string | { bold: string }>> = [
  [
    { bold: "Use your own AI account." },
    " Usage is billed by that provider directly to you at their standard API rates; Slicely never pays for or resells AI usage. Your key is encrypted on the server, only ever sent to the provider it belongs to, and never shown back to you — we suggest a personal key with an expiry.",
  ],
  [
    { bold: "A subscription is not an API key." },
    " Claude Pro/Max and ChatGPT Plus can't be used here: both providers allow subscription logins only in their own apps. An API account is separate and pay-as-you-go.",
  ],
];

const REJECTED_MESSAGE = "That key was rejected";

let keyFieldSeq = 0;

/** The fine print, as elements. */
function finePrint(): HTMLElement[] {
  return KEY_FINE_PRINT.map((parts) => {
    const p = make("p", "key-copy");
    for (const part of parts) {
      if (typeof part === "string") p.appendChild(document.createTextNode(part));
      else p.appendChild(make("strong", "", part.bold));
    }
    return p;
  });
}

/**
 * One provider's card: the field, the console link, and what to do when the
 * paste is refused.
 *
 * `note` is the reason it is on screen (e.g. this provider's key was rejected
 * mid-turn), so the same component can introduce itself or explain itself.
 */
export function buildProviderKeyCard(id: ProviderId, opts: { note?: string } = {}): HTMLElement {
  const h = help(id);
  const card = make("div", `key-card provider-${id}`);
  const seq = ++keyFieldSeq;
  const inputId = `apiKeyInput${seq}`;

  const head = make("div", "key-head");
  head.appendChild(make("span", "key-provider", h.label));
  head.appendChild(externalLink(h.consoleUrl, h.consoleLabel));
  card.appendChild(head);
  card.appendChild(make("p", "key-copy", h.detail));

  if (opts.note) card.appendChild(make("p", "key-note", opts.note));

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
  const submit = make("button", "btn primary", "Connect key");
  submit.type = "submit";
  row.append(input, reveal, submit);
  const error = make("p", "key-error hidden");
  error.setAttribute("role", "alert");
  form.append(label, row, error);
  card.appendChild(form);

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
    const original = submit.textContent ?? "Connect key";
    submit.textContent = "Checking…";
    void (async () => {
      try {
        const result = await putJson<{ hasKey: true; provider: ProviderId; keyHint: string }>("/api/key", {
          provider: id,
          apiKey,
        });
        input.value = "";
        rememberKey(id, result.keyHint);
        toast(`${h.label} key connected · ${result.keyHint}`, "success");
        card.replaceChildren(make("p", "key-copy", `${h.label} key connected: ${result.keyHint}`));
        emit();
      } catch (err) {
        const api = err instanceof ApiError ? err : undefined;
        if (api?.code === "key_invalid_format" || api?.status === 400) fail(api?.message || h.formatMessage);
        else if (api?.code === "key_rejected" || api?.status === 401) fail(api?.message || REJECTED_MESSAGE);
        else fail((err as Error).message || `Couldn't reach ${h.label} to check that key.`);
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    })();
  });

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

/**
 * The whole "connect a key" block: the shared copy, then one card per provider.
 *
 * Both are offered at once rather than behind a chooser, because the answer to
 * "which do I need?" is "whichever account you already have", and a tab hides
 * half of that.
 */
export function buildKeyCard(opts: { note?: string } = {}): HTMLElement {
  const wrap = make("div", "key-block");
  if (opts.note) wrap.appendChild(make("p", "key-note", opts.note));
  const cards = make("div", "key-cards");
  for (const h of PROVIDER_HELP) cards.appendChild(buildProviderKeyCard(h.id));
  wrap.appendChild(cards);
  for (const p of finePrint()) wrap.appendChild(p);
  return wrap;
}

/** The block as it appears mid-conversation, when a turn found no usable key. */
export function buildKeyPrompt(code: string): HTMLElement {
  const wrap = make("div", "key-prompt enter");
  wrap.appendChild(
    buildKeyCard({
      note:
        code === "key_rejected"
          ? "The key on file was rejected. Paste a new one to carry on."
          : "Connect a key to chat. Searching and pasting links work without one.",
    }),
  );
  return wrap;
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
 * With a key connected this is the old invitation to type something. Without
 * one it is the three steps to a first print, with the key card inline as step
 * one — because that is the step nothing else works without.
 */
export function buildEmptyState(onExample: (prompt: string) => void): HTMLElement {
  if (current.hasKey) {
    const empty = make("div", "empty");
    empty.appendChild(make("span", "big", "◆"));
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

  const empty = make("div", "empty onboarding");
  empty.appendChild(make("span", "big", "◆"));
  const steps = make("ol", "steps");

  const one = make("li", "step");
  one.appendChild(make("h2", "step-title", "1. Connect an AI key"));
  one.appendChild(make("p", "step-sub", "Anthropic or OpenAI — either one on its own is enough."));
  one.appendChild(buildKeyCard());
  steps.appendChild(one);

  const two = make("li", "step");
  two.appendChild(make("h2", "step-title", "2. Tell it what to print"));
  two.appendChild(
    make("p", "step-sub", "Say what you want in the box below. Slicely finds a free model, checks it, and slices it."),
  );
  const examples = make("div", "examples");
  for (const ex of EXAMPLE_PROMPTS) {
    const b = make("button", "ex", ex);
    b.type = "button";
    b.onclick = () => onExample(ex);
    examples.appendChild(b);
  }
  two.appendChild(examples);
  steps.appendChild(two);

  const three = make("li", "step");
  three.appendChild(make("h2", "step-title", "3. Connect a printer (optional)"));
  three.appendChild(
    make(
      "p",
      "step-sub",
      "Add one in Settings to send finished files straight to it, or just download the G-code. Prints never start on their own — you arm that per printer.",
    ),
  );
  steps.appendChild(three);

  empty.appendChild(steps);
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

// ── Settings → AI / Data / About ─────────────────────────────────────────────

/**
 * Settings → AI. One row per provider: either the connected key with the two
 * things you can do to it, or the card that connects one.
 *
 * Every provider is always listed, connected or not — this is the panel a user
 * opens to find out what they can switch to, and a provider that only appears
 * once you already have its key answers that question backwards.
 */
export function renderAiSection(host: HTMLElement): void {
  host.replaceChildren();
  if (!current.hasKey) {
    host.appendChild(buildKeyCard());
    return;
  }
  const list = make("div", "key-providers");
  for (const h of PROVIDER_HELP) list.appendChild(providerRow(h, host));
  host.appendChild(list);
  for (const p of finePrint()) host.appendChild(p);
}

/** One provider in Settings → AI. */
function providerRow(h: ProviderHelp, host: HTMLElement): HTMLElement {
  const state = providerState(h.id);
  if (!state.hasKey) {
    const slot = make("div", "key-provider-slot");
    slot.appendChild(buildProviderKeyCard(h.id));
    return slot;
  }

  const row = make("div", "key-status");
  row.appendChild(make("span", "key-provider", h.label));
  row.appendChild(make("span", "key-hint", state.keyHint ?? "connected"));
  const replace = make("button", "btn ghost small", "Replace");
  replace.type = "button";
  replace.addEventListener("click", () => {
    row.replaceWith(
      buildProviderKeyCard(h.id, { note: "Paste the new key. The old one is replaced once this succeeds." }),
    );
  });
  const remove = make("button", "btn ghost small danger", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    void (async () => {
      try {
        // The provider goes in the query, not a DELETE body: removing the wrong
        // one would disconnect the key the user meant to keep.
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
  row.append(replace, remove);
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
