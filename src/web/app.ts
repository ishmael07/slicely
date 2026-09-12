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
import { getJson } from "./api.js";
import type { SheetId } from "./ui.js";
import { byId, closeSheets, initUi, isSheetOpen, make, onSheetChange, toggleSheet } from "./ui.js";
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
  buildKeyPrompt,
  config,
  hasKey,
  initConsent,
  loadConfig,
  onConfigChange,
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
  } catch {
    statusText.textContent = "unknown";
    bannerEl.textContent = "Can't reach the Slicely server. Check your connection.";
    bannerEl.classList.remove("hidden");
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

initUi();

const settings = initSettings({ onError: renderError });
initPrinters({ multiUser: () => config().multiUser });
initJobs({ mountSend: attachSendSlot, planOptions });
initChat({
  jobPanel: getJobPanel,
  planStagedJob,
  mountSend: attachSendSlot,
  onStatus: applyStatus,
  buildEmptyState: () => buildEmptyState((prompt) => void sendInstruction(prompt, prompt)),
  canChat: hasKey,
  buildKeyPrompt,
});

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
for (const id of ["settingsClose", "chatsClose", "jobsClose"]) {
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
// the key card, or the plain invitation to type — so it is fetched before the
// empty state is drawn. Everything else loads in parallel behind it.
void (async () => {
  await loadConfig();
  showEmptyState();
  initConsent(byId<HTMLElement>("consent"));
  renderAccount();
  updateSendEnabled();
  applyMode();

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
setInterval(() => {
  // Poll faster while the printer list is on screen, but keep the header honest
  // either way.
  void refreshPrinters();
}, isSheetOpen("settings") ? 6000 : 15000);
