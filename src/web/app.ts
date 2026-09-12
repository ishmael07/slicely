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
import { byId, closeSheets, initUi, isSheetOpen, make, toggleSheet } from "./ui.js";
import {
  initChat,
  refreshChats,
  renderError,
  sendInstruction,
  showEmptyState,
} from "./chat.js";
import { getJobPanel, initJobs, loadJobs, planStagedJob } from "./jobs.js";
import { applyMode, attachSendSlot, initPrinters, refreshPrinters } from "./printers.js";
import { initSettings, loadSources, planOptions, renderPreferences } from "./settings.js";

// ── shell elements ───────────────────────────────────────────────────────────

const bannerEl = byId<HTMLElement>("banner");
const statusDot = byId<HTMLElement>("statusDot");
const statusText = byId<HTMLElement>("statusText");

// ── the transcript's empty state ─────────────────────────────────────────────

function buildEmptyState(): HTMLElement {
  const empty = make("div", "empty");
  empty.appendChild(make("span", "big", "◆"));
  const p = make("p");
  p.appendChild(document.createTextNode("Find a "));
  p.appendChild(make("b", "", "free 3D model"));
  p.appendChild(document.createTextNode(", slice it, and print. Right from your phone."));
  empty.appendChild(p);
  const examples = make("div", "examples");
  const prompts = [
    "Find me a phone stand I can print today",
    "Slice this for strength, PETG, my Ender 3",
    "Show me a cable clip for a desk",
  ];
  for (const ex of prompts) {
    const b = make("button", "ex", ex);
    b.type = "button";
    b.onclick = () => void sendInstruction(ex, ex);
    examples.appendChild(b);
  }
  empty.appendChild(examples);
  return empty;
}

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

// ── hosted vs desktop ────────────────────────────────────────────────────────

let multiUser = false;

async function checkMultiUser(): Promise<void> {
  // /api/printers/discover answers 403 in multi-user mode; probing it (a
  // harmless GET) is the simplest way for the client to learn the mode without a
  // dedicated config endpoint.
  try {
    const resp = await fetch("/api/printers/discover");
    multiUser = resp.status === 403;
  } catch {
    multiUser = false;
  }
  applyMode();
}

// ── boot ─────────────────────────────────────────────────────────────────────

initUi();

const settings = initSettings({ onError: renderError });
initPrinters({ multiUser: () => multiUser });
initJobs({ mountSend: attachSendSlot, planOptions });
initChat({
  jobPanel: getJobPanel,
  planStagedJob,
  mountSend: attachSendSlot,
  onStatus: applyStatus,
  buildEmptyState,
});

// Sheets: one header button each, one close button each.
byId<HTMLButtonElement>("settingsBtn").addEventListener("click", () => {
  if (!toggleSheet("settings")) return;
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

showEmptyState();
void loadStatus();
void checkMultiUser();
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
