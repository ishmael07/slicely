// ─────────────────────────────────────────────────────────────────────────────
// printers.ts — connecting a printer, arming auto-start, and sending G-code.
//
// Owns the printer list, the header printer pill, the add-printer form and LAN
// discovery. It also owns the one "Send to printer" button the transcript uses:
// cards.ts and jobs.ts ask for a send slot and this module fills it, so the
// button's wording always reflects the CURRENT target printer and whether that
// printer is actually armed for unattended auto-start.
// ─────────────────────────────────────────────────────────────────────────────
import type { PrinterConnection, PrinterStatus } from "../shared/printers";
import { del, getJson, postJson } from "./api.js";
import { byId, confirmDialog, errorCard, isSheetOpen, make, skeleton, toast } from "./ui.js";

export interface PrintersDeps {
  /** True on a shared server, where LAN discovery is refused outright. */
  multiUser(): boolean;
}

export interface PrintersApi {
  refresh(): Promise<void>;
}

let deps: PrintersDeps;

let printerListEl: HTMLElement;
let discoveredEl: HTMLElement;
let printerDot: HTMLElement;
let printerLabel: HTMLElement;
let addPrinterForm: HTMLElement;
let discoverBtn: HTMLButtonElement;
let pTransport: HTMLSelectElement;
let pLabel: HTMLInputElement;
let pHost: HTMLInputElement;
let pHostRow: HTMLElement;
let pSecretsFields: HTMLElement;
let pFolderRow: HTMLElement;
let pFolder: HTMLInputElement;
let pTransportHint: HTMLElement;
let pSave: HTMLButtonElement;
let multiUserNote: HTMLElement;

let printersCache: PrinterConnection[] = [];
let selectedPrinterId: string | undefined;
try {
  selectedPrinterId = localStorage.getItem("slicely:selectedPrinter") ?? undefined;
} catch {
  selectedPrinterId = undefined;
}

/** Is this printer armed for unattended auto-start?
 *
 *  Read from the server's own record every time, never from a local mirror: a
 *  browser's memory of its own toggles is wrong after a reload, wrong in a
 *  second tab, and wrong after the server refuses the change — and being wrong
 *  about THIS flag means starting a print onto a bed nobody cleared. Absent
 *  means not armed. */
function isArmed(p: PrinterConnection): boolean {
  return p.autoStart === true;
}

type Listener = () => void;
const printerListeners = new Set<Listener>();

function onPrintersChanged(fn: Listener): () => void {
  printerListeners.add(fn);
  return () => printerListeners.delete(fn);
}

function emitPrintersChanged(): void {
  for (const fn of printerListeners) fn();
}

// ── printer state vocabulary ─────────────────────────────────────────────────

function stateLabel(s: PrinterStatus | undefined): string {
  if (!s) return "not connected";
  switch (s.state) {
    case "printing":
      return s.progressPct !== undefined ? `printing ${Math.round(s.progressPct)}%` : "printing";
    case "preparing":
      return "heating";
    case "paused":
      return "paused";
    case "idle":
      return "ready";
    case "finished":
      return "finished";
    case "error":
      return s.message ? `error — ${s.message}` : "error";
    case "offline":
      return "offline";
    default:
      return "unknown";
  }
}

function stateClass(s: PrinterStatus | undefined): string {
  if (!s) return "off";
  if (s.state === "printing" || s.state === "preparing") return "busy";
  if (s.state === "idle" || s.state === "finished") return "ok";
  if (s.state === "error") return "err";
  return "off";
}

// ── the send button ──────────────────────────────────────────────────────────
// The button reads "Send & start" ONLY when the target printer is actually
// armed for unattended auto-start; otherwise it's worded as an upload-and-queue
// action. Rebuilt live via onPrintersChanged() so an existing panel's wording
// stays correct if the user changes printer/arms auto-start afterwards.

function activeSendTarget(): PrinterConnection | undefined {
  return printersCache.find((p) => p.id === selectedPrinterId) ?? printersCache[0];
}

function buildSendButton(gcodeId: string, size?: "small"): HTMLButtonElement | null {
  const p = activeSendTarget();
  if (!p) return null;
  const willStart = isArmed(p);
  const cls = size ? `btn primary ${size}` : "btn primary";
  const btn = make("button", cls, willStart ? `Send & start → ${p.label}` : `Send to ${p.label}`);
  btn.type = "button";
  btn.title = willStart
    ? `Upload and immediately begin printing on ${p.label}. Make sure the bed is clear.`
    : `Upload to ${p.label} and queue it — start it from the printer, or arm auto-start in Settings.`;
  btn.onclick = () => void sendGcode(p.id, gcodeId, willStart, btn);
  return btn;
}

async function sendGcode(printerId: string, gcodeId: string, start: boolean, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent ?? "";
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const result = await postJson<{ ok: boolean; started: boolean; message: string }>(
      `/api/printers/${encodeURIComponent(printerId)}/send`,
      { gcodeId, opts: { startImmediately: start } },
    );
    btn.textContent = result.ok ? (result.started ? "✓ Printing" : "✓ Queued") : "✗ Failed";
    toast(result.message, result.ok ? "success" : "error");
  } catch (err) {
    btn.textContent = "✗ Failed";
    toast((err as Error).message || "Couldn't send to the printer.", "error");
  } finally {
    setTimeout(() => {
      // The panel this button lives in can be replaced while the send is in
      // flight (a job re-render, a new turn). Restoring a detached button is
      // harmless but pointless, and reaching for it by selector would restore
      // the WRONG button — so hold the reference and check it is still on screen.
      if (!btn.isConnected) return;
      btn.disabled = false;
      btn.textContent = original;
    }, 2500);
  }
}

/** Mount a live-updating Send button inside `container`. Subscribes to printer
 *  state changes and tears itself down once removed from the DOM. */
export function attachSendSlot(container: HTMLElement, gcodeId: string, size?: "small"): void {
  const slot = make("span", "send-slot");
  const fill = (): void => {
    slot.replaceChildren();
    const btn = buildSendButton(gcodeId, size);
    if (btn) slot.appendChild(btn);
  };
  fill();
  const unsubscribe = onPrintersChanged(fill);
  const mo = new MutationObserver((_records, obs) => {
    if (!slot.isConnected) {
      unsubscribe();
      obs.disconnect();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  container.appendChild(slot);
}

// ── the printer list ─────────────────────────────────────────────────────────

export async function refreshPrinters(): Promise<void> {
  // Only on the first load: this also runs on a timer, and a skeleton flashing
  // over a list the user is reading every few seconds is worse than no skeleton.
  if (printerListEl.childElementCount === 0) printerListEl.replaceChildren(skeleton(2));
  try {
    const [printers, statuses] = await Promise.all([
      getJson<PrinterConnection[]>("/api/printers"),
      getJson<PrinterStatus[]>("/api/printers/status"),
    ]);
    printersCache = printers;
    renderPrinterList(printers, statuses);
    updateHeaderPrinterPill(printers, statuses);
    emitPrintersChanged();
  } catch (err) {
    printerListEl.replaceChildren(
      errorCard((err as Error).message || "Couldn't load your printers.", () => void refreshPrinters()),
    );
  }
}

function updateHeaderPrinterPill(printers: PrinterConnection[], statuses: PrinterStatus[]): void {
  const active = printers.find((p) => p.id === selectedPrinterId) ?? printers[0];
  if (!active) {
    printerDot.className = "dot off";
    printerLabel.textContent = "No printer";
    return;
  }
  const status = statuses.find((s) => s.id === active.id);
  printerDot.className = `dot ${stateClass(status)}`;
  printerLabel.textContent = `${active.label} · ${stateLabel(status)}`;
}

function renderPrinterList(printers: PrinterConnection[], statuses: PrinterStatus[]): void {
  printerListEl.replaceChildren();
  if (printers.length === 0) {
    printerListEl.appendChild(make("p", "sheet-hint", "No printers added yet."));
    return;
  }
  for (const p of printers) {
    const status = statuses.find((s) => s.id === p.id);
    const row = make("div", "printer-row");

    const head = make("div", "printer-head");
    head.appendChild(make("span", `dot ${stateClass(status)}`));
    head.appendChild(make("span", "name", p.label));
    head.appendChild(
      make("span", "meta", `${p.transport} · ${stateLabel(status)}${p.id === selectedPrinterId ? " · active" : ""}`),
    );
    row.appendChild(head);

    // Auto-start arming: off unless the SERVER says otherwise, deliberately
    // worded as a hazard, and confirmed before arming — see buildSendButton()
    // for how this changes the Send button's wording.
    const armRow = make("label", "printer-arm");
    const cb = make("input");
    cb.type = "checkbox";
    cb.checked = isArmed(p);
    cb.onchange = () => void setArmed(p, cb);
    armRow.appendChild(cb);
    armRow.appendChild(
      document.createTextNode("Start prints automatically. Only enable this if you check the bed is clear first."),
    );
    row.appendChild(armRow);

    const btns = make("div", "printer-actions");
    const useBtn = make("button", "btn ghost small", "Use");
    useBtn.type = "button";
    useBtn.onclick = () => void selectPrinter(p.id);
    btns.appendChild(useBtn);
    const testBtn = make("button", "btn ghost small", "Test");
    testBtn.type = "button";
    testBtn.onclick = () => void testPrinterAction(p.id, testBtn);
    btns.appendChild(testBtn);
    if (status && (status.state === "printing" || status.state === "paused")) {
      const pauseLabel = status.state === "paused" ? "Resume" : "Pause";
      const resumeAction = status.state === "paused" ? "resume" : "pause";
      const pauseBtn = make("button", "btn ghost small", pauseLabel);
      pauseBtn.type = "button";
      pauseBtn.onclick = () => void controlPrinterAction(p.id, resumeAction);
      btns.appendChild(pauseBtn);
      const cancelBtn = make("button", "btn ghost small danger", "Cancel");
      cancelBtn.type = "button";
      cancelBtn.onclick = () => void controlPrinterAction(p.id, "cancel");
      btns.appendChild(cancelBtn);
    }
    const rmBtn = make("button", "btn ghost small danger", "Remove");
    rmBtn.type = "button";
    rmBtn.onclick = () => void removePrinterAction(p);
    btns.appendChild(rmBtn);
    row.appendChild(btns);

    printerListEl.appendChild(row);
  }
}

/**
 * Arm or disarm unattended auto-start.
 *
 * Arming is the one switch in Slicely that can start a machine moving while
 * nobody is looking, so it asks first and says what it means in plain words.
 * Either way the answer comes back from the server — the checkbox is re-read
 * from /api/printers rather than left showing what was clicked.
 */
async function setArmed(printer: PrinterConnection, cb: HTMLInputElement): Promise<void> {
  const armed = cb.checked;
  if (armed) {
    const ok = await confirmDialog({
      title: "Start prints automatically?",
      body: `Prints will start the moment they're sent to ${printer.label}. Only arm this if you always clear the bed. You can disarm at any time.`,
      confirmLabel: "Arm auto-start",
      danger: true,
    });
    if (!ok) {
      cb.checked = false;
      return;
    }
  }
  try {
    await postJson(`/api/printers/${encodeURIComponent(printer.id)}/autostart`, { armed });
  } catch (err) {
    toast((err as Error).message || "Couldn't change auto-start.", "error");
  }
  await refreshPrinters();
}

async function selectPrinter(id: string): Promise<void> {
  selectedPrinterId = id;
  try {
    localStorage.setItem("slicely:selectedPrinter", id);
  } catch {
    /* private browsing / storage disabled — selection just won't persist */
  }
  await postJson("/api/printers/active", { id }).catch(() => undefined);
  await refreshPrinters();
}

async function testPrinterAction(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const original = btn.textContent ?? "Test";
  btn.textContent = "Testing…";
  try {
    const r = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(id)}/test`, {});
    toast(r.message, r.ok ? "success" : "error");
  } catch (err) {
    toast((err as Error).message || "Test failed.", "error");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    await refreshPrinters();
  }
}

async function controlPrinterAction(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
  try {
    const r = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(id)}/control`, {
      action,
    });
    toast(r.message, r.ok ? "success" : "error");
  } catch (err) {
    toast((err as Error).message || "Control failed.", "error");
  }
  await refreshPrinters();
}

async function removePrinterAction(printer: PrinterConnection): Promise<void> {
  const ok = await confirmDialog({
    title: `Remove ${printer.label}?`,
    body: "Its saved credentials are deleted.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  try {
    await del(`/api/printers/${encodeURIComponent(printer.id)}`);
    if (selectedPrinterId === printer.id) {
      selectedPrinterId = undefined;
      try {
        localStorage.removeItem("slicely:selectedPrinter");
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    toast((err as Error).message || "Couldn't remove printer.", "error");
  }
  await refreshPrinters();
}

// ── the add-printer form ─────────────────────────────────────────────────────

interface DriverInfo {
  transport: string;
  label: string;
  defaultPort: number;
  requiredSecrets: string[];
}

let driverCatalog: DriverInfo[] = [];

export async function loadDrivers(): Promise<void> {
  try {
    driverCatalog = await getJson<DriverInfo[]>("/api/printers/drivers");
    pTransport.replaceChildren();
    for (const d of driverCatalog) {
      const opt = make("option", "", d.label);
      opt.value = d.transport;
      pTransport.appendChild(opt);
    }
    renderSecretFields();
  } catch {
    /* printers subsystem unavailable — the add-printer form stays empty */
  }
}

function secretLabel(k: string): string {
  switch (k) {
    case "apiKey":
      return "API key";
    case "accessCode":
      return "Access code";
    case "token":
      return "Account token";
    case "username":
      return "Username";
    case "password":
      return "Password";
    default:
      return k;
  }
}

function secretHint(k: string): string {
  switch (k) {
    case "apiKey":
      return "From the printer's web interface → Settings";
    case "accessCode":
      return "8 characters, shown on the printer's screen";
    case "token":
      return "From your vendor account";
    case "username":
      return "maker";
    case "password":
      return "Printer password";
    default:
      return "";
  }
}

/** Plain-language note about what each transport needs and can do, so the user
 *  is not left guessing why a printer won't connect. */
function transportHint(transport: string): string {
  switch (transport) {
    case "file":
      return "No network needed. Slicely writes the G-code to this folder. Point it at your SD card, then print from the card. Use this for any printer without Wi-Fi, like a stock Ender 3.";
    case "octoprint":
      return "Needs OctoPrint on your network, usually a Raspberry Pi attached to the printer. Find the API key under OctoPrint → Settings → API.";
    case "moonraker":
      return "Needs Klipper with Moonraker (Fluidd or Mainsail). Enter the host's IP address.";
    case "prusalink":
      return "Built into Prusa MK4 / XL / MINI with networking enabled. Find the address and password on the printer's screen.";
    case "prusa-connect":
      return "Works over the internet, so it needs no LAN access. Token comes from your Prusa Connect account.";
    case "bambu-lan":
      return "Access code is on the printer's screen under Settings → Network. Status and control work. Sending files over LAN needs FTPS, which isn't supported yet.";
    case "bambu-cloud":
      return "Works over the internet via your Bambu account.";
    default:
      return "";
  }
}

function renderSecretFields(): void {
  const driver = driverCatalog.find((d) => d.transport === pTransport.value);
  pSecretsFields.replaceChildren();
  const cloudTransports = new Set(["prusa-connect", "bambu-cloud"]);
  const isFile = pTransport.value === "file";
  pHostRow.classList.toggle("hidden", cloudTransports.has(pTransport.value) || isFile);
  // The folder is only meaningful for the file/SD transport.
  pFolderRow.classList.toggle("hidden", !isFile);
  pTransportHint.textContent = transportHint(pTransport.value);
  pSave.textContent = isFile ? "Save folder printer" : "Connect printer";
  for (const secret of driver?.requiredSecrets ?? []) {
    const row = make("div", "field");
    row.appendChild(make("label", "", secretLabel(secret)));
    const input = make("input");
    input.type = secret === "password" || secret === "token" || secret === "apiKey" ? "password" : "text";
    input.placeholder = secretHint(secret);
    input.dataset.secretField = secret;
    row.appendChild(input);
    pSecretsFields.appendChild(row);
  }
}

async function connectPrinter(): Promise<void> {
  const body: Record<string, unknown> = {
    transport: pTransport.value,
    label: pLabel.value.trim() || pTransport.value,
  };
  if (pHost.value.trim()) body.host = pHost.value.trim();
  if (pTransport.value === "file" && pFolder.value.trim()) {
    body.outputDir = pFolder.value.trim();
  }
  for (const input of pSecretsFields.querySelectorAll<HTMLInputElement>("input[data-secret-field]")) {
    const field = input.dataset.secretField;
    if (field && input.value.trim()) body[field] = input.value.trim();
  }
  pSave.disabled = true;
  const original = pSave.textContent ?? "Connect printer";
  pSave.textContent = "Connecting…";
  try {
    const res = await postJson<{ printer: PrinterConnection; test: { ok: boolean; message: string } }>(
      "/api/printers",
      body,
    );
    toast(res.test.message, res.test.ok ? "success" : "error");
    addPrinterForm.classList.add("hidden");
    pLabel.value = "";
    pHost.value = "";
    pFolder.value = "";
    await refreshPrinters();
  } catch (err) {
    toast((err as Error).message || "Couldn't add that printer.", "error");
  } finally {
    pSave.disabled = false;
    pSave.textContent = original;
  }
}

// ── LAN discovery ────────────────────────────────────────────────────────────

interface DiscoveredPrinterLite {
  transport: string;
  host: string;
  port: number;
  label: string;
  needs?: string;
}

/**
 * Explain an empty scan. A stock Ender 3 / Ender 5 / most sub-$300 printers have
 * no Wi-Fi or Ethernet whatsoever, so a scan finding nothing is the expected
 * result rather than a fault — and the SD-card route is the real answer for
 * those machines, not a workaround.
 */
function showScanHelp(): void {
  discoveredEl.replaceChildren();
  const box = make("div", "scan-help");
  box.appendChild(make("div", "scan-help-title", "No printers answered on this network."));
  const list = make("ul");
  for (const line of [
    "Most printers have no network hardware, so there is nothing to find. Pick Type → “Folder / SD card” and print from the card.",
    "OctoPrint or Klipper: check the Pi is powered on and on this Wi-Fi, then add it by IP.",
    "Prusa MK4, XL, or MINI: turn on networking, then add the address from the printer's screen.",
    "Bambu: use Bambu Cloud with your account token, or LAN with the code on the printer's screen.",
  ]) {
    list.appendChild(make("li", "", line));
  }
  box.appendChild(list);
  box.appendChild(
    make(
      "div",
      "scan-help-note",
      "Slicely still slices correctly either way. Pick your printer above so the estimates match.",
    ),
  );
  discoveredEl.appendChild(box);
}

function renderDiscovered(found: DiscoveredPrinterLite[]): void {
  discoveredEl.replaceChildren();
  if (found.length === 0) return;
  discoveredEl.appendChild(make("div", "sheet-hint", `Found ${found.length} on your network`));
  for (const d of found) {
    const row = make("div", "printer-row found");
    row.appendChild(make("span", "name", d.label));
    row.appendChild(make("span", "meta", `${d.transport} · ${d.host}:${d.port}${d.needs ? ` · ${d.needs}` : ""}`));
    const add = make("button", "btn primary small", "Add");
    add.type = "button";
    add.onclick = () => {
      addPrinterForm.classList.remove("hidden");
      pTransport.value = d.transport;
      renderSecretFields();
      pLabel.value = d.label;
      pHost.value = d.host;
      addPrinterForm.scrollIntoView({ behavior: "smooth" });
    };
    row.appendChild(add);
    discoveredEl.appendChild(row);
  }
}

async function discoverPrintersAction(): Promise<void> {
  discoverBtn.disabled = true;
  const original = discoverBtn.textContent ?? "Scan LAN";
  discoverBtn.textContent = "Scanning…";
  discoveredEl.replaceChildren(skeleton(2));
  try {
    const found = await getJson<DiscoveredPrinterLite[]>("/api/printers/discover");
    renderDiscovered(found);
    if (found.length === 0) {
      // "Nothing found" is usually not a failure — most budget printers have no
      // network hardware at all, so there is genuinely nothing to discover. Say
      // what to do next instead of leaving the user stuck.
      showScanHelp();
      toast("No networked printers found. See the note below.", "error");
    }
  } catch (err) {
    const message = (err as Error).message || "Discovery unavailable.";
    discoveredEl.replaceChildren(errorCard(message, () => void discoverPrintersAction()));
    toast(message, "error");
  } finally {
    discoverBtn.textContent = original;
    discoverBtn.disabled = false;
  }
}

/** A shared server cannot reach a printer on the user's LAN, so the scan button
 *  and the explanation swap places. Called again whenever the mode is known. */
export function applyMode(): void {
  const multiUser = deps.multiUser();
  multiUserNote.classList.toggle("hidden", !multiUser);
  discoverBtn.classList.toggle("hidden", multiUser);
}

export function initPrinters(d: PrintersDeps): PrintersApi {
  deps = d;
  printerListEl = byId<HTMLElement>("printerList");
  discoveredEl = byId<HTMLElement>("discovered");
  printerDot = byId<HTMLElement>("printerDot");
  printerLabel = byId<HTMLElement>("printerLabel");
  addPrinterForm = byId<HTMLElement>("addPrinterForm");
  discoverBtn = byId<HTMLButtonElement>("discoverBtn");
  pTransport = byId<HTMLSelectElement>("pTransport");
  pLabel = byId<HTMLInputElement>("pLabel");
  pHost = byId<HTMLInputElement>("pHost");
  pHostRow = byId<HTMLElement>("pHostRow");
  pSecretsFields = byId<HTMLElement>("pSecretsFields");
  pFolderRow = byId<HTMLElement>("pFolderRow");
  pFolder = byId<HTMLInputElement>("pFolder");
  pTransportHint = byId<HTMLElement>("pTransportHint");
  pSave = byId<HTMLButtonElement>("pSave");
  multiUserNote = byId<HTMLElement>("multiUserNote");

  byId<HTMLButtonElement>("addPrinterBtn").addEventListener("click", () =>
    addPrinterForm.classList.toggle("hidden"),
  );
  pTransport.addEventListener("change", renderSecretFields);
  pSave.addEventListener("click", () => void connectPrinter());
  discoverBtn.addEventListener("click", () => void discoverPrintersAction());

  void loadDrivers();
  startPolling();
  return { refresh: refreshPrinters };
}

/**
 * Keep the printer list and the header pill current.
 *
 * The interval is decided INSIDE each tick, not once at boot: opening the
 * settings sheet has to speed the polling up from the next tick onwards, and the
 * old `setInterval(fn, sheetOpen ? 6000 : 15000)` read that condition exactly
 * once — when the sheet was, necessarily, still closed.
 */
function startPolling(): void {
  const next = (): void => {
    setTimeout(() => {
      void refreshPrinters().finally(next);
    }, isSheetOpen("settings") ? 4000 : 15000);
  };
  next();
}
