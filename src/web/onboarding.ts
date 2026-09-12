// ─────────────────────────────────────────────────────────────────────────────
// onboarding.ts — what a first-time visitor sees, and the one place that knows
// about the user's Anthropic key.
//
// Slicely is bring-your-own-key: the server never has an AI key of its own, so
// until the user connects one there is nothing to chat with. That is stated
// plainly rather than discovered by pressing Send and getting an error, and the
// same card is used in the empty state, in Settings → AI, and in the transcript
// when a turn comes back with `no_key`.
//
// The client only ever sees `{ hasKey, keyHint }` — the key itself goes out in
// one PUT body and is never read back, never logged, never in a URL.
// ─────────────────────────────────────────────────────────────────────────────
import { ApiError, del, getJson, putJson } from "./api.js";
import { externalLink, make, toast } from "./ui.js";

export interface AppConfig {
  mode: "hosted" | "desktop";
  hasKey: boolean;
  keyHint?: string;
  multiUser: boolean;
  slicerAvailable: boolean;
  sourceCommit: string;
  version: string;
  repoUrl: string;
  termsUrl: string;
  privacyUrl: string;
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
  multiUser: false,
  slicerAvailable: true,
  sourceCommit: "",
  version: "",
  repoUrl: "",
  termsUrl: "/terms",
  privacyUrl: "/privacy",
};

let current: AppConfig = ASSUMED;
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

export async function loadConfig(): Promise<AppConfig> {
  try {
    current = await getJson<AppConfig>("/api/config");
  } catch {
    current = ASSUMED;
  }
  emit();
  return current;
}

// ── the key card ─────────────────────────────────────────────────────────────

const KEY_PARAGRAPHS: Array<Array<string | { bold: string }>> = [
  [
    { bold: "Use your own AI account." },
    " Slicely runs on your own Anthropic API key. Usage is billed by Anthropic directly to you at their standard API rates; Slicely never pays for or resells AI usage.",
  ],
  [
    "Paste a key from console.anthropic.com → Settings → API keys. We suggest a personal key with an expiry. Your key is encrypted on the server and only ever sent to Anthropic.",
  ],
  [
    "Claude Pro/Max subscriptions can't be used here — Anthropic allows subscription logins only in its own apps. An API account is separate and pay-as-you-go.",
  ],
];

const FORMAT_MESSAGE = "That doesn't look like an Anthropic API key — they start with sk-ant-.";
const REJECTED_MESSAGE = "Anthropic rejected that key";

let keyFieldSeq = 0;

/**
 * The "connect your key" card.
 *
 * `note` is the reason it is on screen (e.g. the key was rejected mid-turn), so
 * the same component can introduce itself or explain itself.
 */
export function buildKeyCard(opts: { note?: string } = {}): HTMLElement {
  const card = make("div", "key-card");
  const seq = ++keyFieldSeq;
  const inputId = `apiKeyInput${seq}`;

  for (const parts of KEY_PARAGRAPHS) {
    const p = make("p", "key-copy");
    for (const part of parts) {
      if (typeof part === "string") p.appendChild(document.createTextNode(part));
      else p.appendChild(make("strong", "", part.bold));
    }
    card.appendChild(p);
  }

  if (opts.note) card.appendChild(make("p", "key-note", opts.note));

  const form = make("form", "key-form");
  const label = make("label", "key-label", "Anthropic API key");
  label.htmlFor = inputId;
  const row = make("div", "key-row");
  const input = make("input", "key-input");
  input.id = inputId;
  input.type = "password";
  input.name = "apiKey";
  input.placeholder = "sk-ant-…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  const reveal = make("button", "btn ghost small key-reveal", "Show");
  reveal.type = "button";
  reveal.setAttribute("aria-label", "Show the key");
  reveal.addEventListener("click", () => {
    const shown = input.type === "password";
    input.type = shown ? "text" : "password";
    reveal.textContent = shown ? "Hide" : "Show";
    reveal.setAttribute("aria-label", shown ? "Hide the key" : "Show the key");
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
      fail("Paste your key first.");
      return;
    }
    submit.disabled = true;
    const original = submit.textContent ?? "Connect key";
    submit.textContent = "Checking…";
    void (async () => {
      try {
        const result = await putJson<{ hasKey: true; keyHint: string }>("/api/key", { apiKey });
        input.value = "";
        current = { ...current, hasKey: true, keyHint: result.keyHint };
        toast(`Key connected · ${result.keyHint}`, "success");
        card.replaceChildren(make("p", "key-copy", `Connected key: ${result.keyHint}`));
        emit();
      } catch (err) {
        const api = err instanceof ApiError ? err : undefined;
        if (api?.code === "key_invalid_format" || api?.status === 400) fail(api?.message || FORMAT_MESSAGE);
        else if (api?.code === "key_rejected" || api?.status === 401) fail(REJECTED_MESSAGE);
        else fail((err as Error).message || "Couldn't reach Anthropic to check that key.");
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    })();
  });

  return card;
}

/** The card as it appears mid-conversation, when a turn found no usable key. */
export function buildKeyPrompt(code: string): HTMLElement {
  const wrap = make("div", "key-prompt enter");
  wrap.appendChild(
    buildKeyCard({
      note:
        code === "key_rejected"
          ? "Anthropic rejected the key on file. Paste a new one to carry on."
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
  one.appendChild(make("h2", "step-title", "1. Connect your Claude key"));
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

/** Settings → AI. Either the connected key with the two things you can do to
 *  it, or the card that connects one. */
export function renderAiSection(host: HTMLElement): void {
  host.replaceChildren();
  if (!current.hasKey) {
    host.appendChild(buildKeyCard());
    return;
  }
  const row = make("div", "key-status");
  row.appendChild(make("span", "key-hint", `Connected key: ${current.keyHint ?? "connected"}`));
  const replace = make("button", "btn ghost small", "Replace");
  replace.type = "button";
  replace.addEventListener("click", () => {
    host.replaceChildren(buildKeyCard({ note: "Paste the new key. The old one is replaced once this succeeds." }));
  });
  const remove = make("button", "btn ghost small danger", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    void (async () => {
      try {
        await del("/api/key");
        current = { ...current, hasKey: false, keyHint: undefined };
        toast("Key removed.", "info");
        emit();
        renderAiSection(host);
      } catch (err) {
        toast((err as Error).message || "Couldn't remove the key.", "error");
      }
    })();
  });
  row.append(replace, remove);
  host.appendChild(row);
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
