// ─────────────────────────────────────────────────────────────────────────────
// Slicely — zero-install web client. Runs entirely in the browser: no build
// step beyond `tsc -p tsconfig.renderer.json`, no framework, no bundler.
//
// This file is the boot sequence and nothing else: it looks up the shell
// elements (header, banner, sheets), hands each module the few things it needs
// via an init call, and starts the polls. All behaviour lives in the modules —
// api.ts (fetch/SSE), ui.ts (dom, toasts, sheets, menus, dialogs), markdown.ts,
// cards.ts, chat.ts, jobs.ts, printers.ts, settings.ts.
//
// Every `../shared/*` import is `import type` — it names shared TYPES only and
// is erased at compile time (see tsconfig.renderer.json's header comment), so
// the emitted modules import nothing but each other.
// ─────────────────────────────────────────────────────────────────────────────
import type { SlicerStatus } from "../shared/types";
import { ApiError, codeMessage, errorMessage, getJson, onAccountChange } from "./api.js";
import { hasFreeCredit, initAccount, openWaitlist, readAuthErrorFromHash, renderAccountPill } from "./account.js";
import type { SheetId } from "./ui.js";
import { byId, closeSheets, initUi, make, onSheetChange, openSheet, toast, toggleSheet } from "./ui.js";
import {
  clearTranscript,
  initChat,
  refreshChats,
  renderError,
  sendInstruction,
  showEmptyState,
  updateSendEnabled,
} from "./chat.js";
import { getJobPanel, initJobs, loadJobs, planStagedJob } from "./jobs.js";
import { applyMode, attachSendSlot, initPrinters, refreshPrinters } from "./printers.js";
import { initSettings, loadSources, planOptions, renderAccount, renderPreferences } from "./settings.js";
import {
  buildEmptyState,
  config,
  focusFirstConnect,
  hasKey,
  initConsent,
  loadConfig,
  onConfigChange,
  refreshConfig,
} from "./onboarding.js";

// ── shell elements ───────────────────────────────────────────────────────────

const bannerEl = byId<HTMLElement>("banner");
const statusDot = byId<HTMLElement>("statusDot");
const statusText = byId<HTMLElement>("statusText");

// ── PrusaSlicer status + the banner ──────────────────────────────────────────

/** Where to get PrusaSlicer. Slicely cannot slice without it, so a missing
 *  install is the one blocker worth interrupting the user for. */
const PRUSASLICER_DOWNLOAD = "https://www.prusa3d.com/page/prusaslicer_424/";

function showSlicerMissing(): void {
  bannerEl.replaceChildren();
  bannerEl.classList.remove("hidden");
  bannerEl.classList.add("banner-action");
  const text = make(
    "span",
    "",
    "PrusaSlicer isn't installed, so Slicely can't slice yet. Searching and importing still work.",
  );
  const link = make("a", "btn primary small", "Download PrusaSlicer");
  link.href = PRUSASLICER_DOWNLOAD;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  bannerEl.append(text, link);
}

function applyStatus(status: SlicerStatus): void {
  if (!status.installed) {
    statusDot.className = "dot err";
    statusText.textContent = "PrusaSlicer not found";
    // A status pill is easy to miss, and nothing downstream works without it.
    showSlicerMissing();
  } else if (status.running) {
    statusDot.className = "dot busy";
    statusText.textContent = `PrusaSlicer ${status.version ?? ""} · open`.trim();
  } else {
    statusDot.className = "dot ok";
    statusText.textContent = `PrusaSlicer ${status.version ?? "ready"}`.trim();
  }
  if (status.installed && bannerEl.classList.contains("banner-action")) {
    bannerEl.classList.add("hidden");
    bannerEl.classList.remove("banner-action");
    bannerEl.replaceChildren();
  }
}

async function loadStatus(): Promise<void> {
  try {
    const status = await getJson<SlicerStatus>("/api/status");
    applyStatus(status);
    // Only clear a stale connection warning. Blanket-hiding used to wipe the
    // "PrusaSlicer isn't installed" banner applyStatus had just raised, one line
    // earlier — so on first load the one blocker worth interrupting for was
    // shown and hidden in the same frame, and nobody ever saw it.
    if (!bannerEl.classList.contains("banner-action")) bannerEl.classList.add("hidden");
  } catch (err) {
    statusText.textContent = "unknown";
    // AN ANSWER IS NOT AN OUTAGE. The server replying 429 — "too many new
    // sessions from this address", which a shared address or a couple of quick
    // reloads can reach — used to be reported as "Can't reach the Slicely
    // server. Check your connection.", sending the user to debug their own
    // network over something that clears up by waiting a minute. An ApiError
    // means the server answered and said why; only a network-level failure
    // (fetch itself throwing) is an unreachable server.
    bannerEl.textContent =
      err instanceof ApiError
        ? errorMessage(err, "The Slicely server refused that request.")
        : "Can't reach the Slicely server. Check your connection.";
    bannerEl.classList.remove("hidden");
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

// Inside the Mac app the window has no title bar of its own, so our header
// becomes one (see styles.css's body.is-desktop). `window.slicely` is the
// preload bridge and exists nowhere else, which is also how the client decides
// whether "Open in PrusaSlicer" is a thing it can offer.
if ((window as unknown as { slicely?: unknown }).slicely) {
  document.body.classList.add("is-desktop");
}

initUi();

const accounts = initAccount({ openAiSettings });
const settings = initSettings({ onError: renderError, openWaitlist });
initPrinters({ multiUser: () => config().multiUser });
initJobs({ mountSend: attachSendSlot, planOptions });
initChat({
  jobPanel: getJobPanel,
  planStagedJob,
  mountSend: attachSendSlot,
  onStatus: applyStatus,
  buildEmptyState: () =>
    buildEmptyState((prompt) => void sendInstruction(prompt, prompt), {
      onAddKey: openAiSettings,
      onWaitlist: openWaitlist,
    }),
  // A key of their own, OR free credit that hasn't run out. Either one pays for
  // the next message.
  canChat: () => hasKey() || hasFreeCredit(),
  onConnect: openAiSettings,
  openWaitlist,
  // A turn that reported a missing or rejected key knows something this page
  // does not, so the account is re-read rather than guessed at.
  onKeyProblem: () => void refreshConfig(),
});

/** Open Settings on the one section that connects a provider, and put the
 *  keyboard on it — where the composer's "Connect" link goes. */
function openAiSettings(): void {
  openSheet("settings");
  renderAccount();
  renderPreferences();
  void refreshPrinters();
  void loadSources();
  focusFirstConnect(byId<HTMLElement>("aiBody"));
}

// Sheets: one header button each, one close button each.
byId<HTMLButtonElement>("settingsBtn").addEventListener("click", () => {
  if (!toggleSheet("settings")) return;
  renderAccount();
  renderPreferences();
  void refreshPrinters();
  void loadSources();
});
// The printer pill in the header is a shortcut into the same settings sheet
// (which is where printers are picked/managed) rather than a second menu.
byId<HTMLButtonElement>("printerPill").addEventListener("click", () =>
  byId<HTMLButtonElement>("settingsBtn").click(),
);
byId<HTMLButtonElement>("chatsBtn").addEventListener("click", () => {
  if (toggleSheet("chats")) void refreshChats();
});
byId<HTMLButtonElement>("jobsBtn").addEventListener("click", () => {
  if (toggleSheet("jobs")) loadJobs();
});
for (const id of ["settingsClose", "chatsClose", "jobsClose", "waitlistClose"]) {
  byId<HTMLButtonElement>(id).addEventListener("click", () => closeSheets());
}

// Keep each header trigger's aria-expanded honest, whichever way its sheet was
// opened or closed (button, scrim, Escape, or a row inside it).
const SHEET_TRIGGERS: Array<[SheetId, string]> = [
  ["settings", "settingsBtn"],
  ["chats", "chatsBtn"],
  ["jobs", "jobsBtn"],
];
onSheetChange((open) => {
  for (const [sheet, trigger] of SHEET_TRIGGERS) {
    byId<HTMLButtonElement>(trigger).setAttribute("aria-expanded", open === sheet ? "true" : "false");
  }
});

/** True while the transcript is still showing its first screen — the only time
 *  it is safe to redraw it out from under the user. */
function isEmptyStateShowing(): boolean {
  const messages = byId<HTMLElement>("messages");
  return messages.children.length === 0 || messages.querySelector(".empty") !== null;
}

// /api/config decides what the first screen says — three onboarding steps with
// the key card, or the plain invitation to type — so it is read before the empty
// state is drawn.
//
// It is also the call that gives this browser its session cookie, and api.ts now
// makes it exactly once and holds every other request until it answers (see the
// boot gate there). So the three `void` calls at the bottom of this file still
// start here, in this tick, but they no longer RACE the cookie: they queue
// behind it. That is what stopped one page load from minting a workspace per
// boot call.
void (async () => {
  // A sign-in that failed comes back as /#auth_error=<code>, because the OAuth
  // callback has no page of its own to say it on. Said once, then wiped from
  // the URL so a reload doesn't repeat it.
  const authError = readAuthErrorFromHash();
  if (authError) toast(codeMessage(authError) ?? "That sign-in didn't complete. Try again.", "error");

  await loadConfig();
  // WHO before WHAT: the first screen is a different screen for somebody with
  // free credit than for a stranger, so the account is read before anything is
  // drawn — and only on a deploy whose config says accounts exist at all.
  await accounts.refresh();
  renderAccountPill();
  showEmptyState();
  initConsent(byId<HTMLElement>("consent"));
  renderAccount();
  updateSendEnabled();
  applyMode();

  // Signing in, signing out and spending credit all change the same three
  // things: the pill, whether the composer is live, and what the first screen
  // should say.
  onAccountChange(() => {
    renderAccountPill();
    renderAccount();
    updateSendEnabled();
    if (isEmptyStateShowing()) {
      clearTranscript();
      showEmptyState();
    }
  });

  // Connecting or removing a key changes what the first screen should say and
  // what the send button promises, so both are redrawn rather than left stale.
  onConfigChange(() => {
    applyMode();
    renderAccount();
    updateSendEnabled();
    if (isEmptyStateShowing()) {
      clearTranscript();
      showEmptyState();
    }
  });
})();

void loadStatus();
void settings.load();
// The header pill must know about a connected printer on load. Previously
// printers were only fetched while the settings sheet was OPEN, so the header
// read "No printer" until you happened to open settings — even with one
// connected and working.
void refreshPrinters();

setInterval(() => void loadStatus(), 15000);
// The printer poll schedules itself from inside printers.ts, so that it can pick
// its interval per tick from whether the settings sheet is actually open.
