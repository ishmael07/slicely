// Slicely's printer surface: the titlebar pill, the printer menu, the manage
// panel in the settings sheet, and the "Send to printer" action that turns a
// finished slice into an actual print.
//
// This is the module that closes Slicely's loop. Everything else in the app
// ends at a .gcode file on disk; this is where a file becomes a print.
//
// Lives apart from renderer.ts on purpose — that file is already large, and
// printer management is a genuinely separate concern with its own state.
import type {
  SlicelyApi,
  PrinterConnection,
  PrinterStatus,
  PrinterTransport,
  DiscoveredPrinter,
} from "../shared/types";

const api: SlicelyApi = window.slicely;

/** Cached view of the printer world, refreshed by pushed events + polling. */
let printers: PrinterConnection[] = [];
let statuses = new Map<string, PrinterStatus>();
let activeId: string | undefined;
/** Auto-start arming, mirrored locally so the toggle renders without a round trip. */
const armed = new Set<string>();
let catalog: Array<{
  transport: PrinterTransport;
  label: string;
  defaultPort: number;
  requiredSecrets: string[];
}> = [];

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to printer-state changes (used to re-render Send buttons in place). */
export function onPrintersChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function e(tag: string, className = "", text = ""): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

// ── State ────────────────────────────────────────────────────────────────────

export function activePrinter(): PrinterConnection | undefined {
  return printers.find((p) => p.id === activeId) ?? printers[0];
}

export function statusOf(id: string): PrinterStatus | undefined {
  return statuses.get(id);
}

/** True when the user has armed unattended auto-start for this printer. */
export function isArmed(id: string): boolean {
  return armed.has(id);
}

async function refresh(): Promise<void> {
  try {
    const [list, stats] = await Promise.all([
      api.listPrinters(),
      api.printerStatuses(),
    ]);
    printers = list;
    statuses = new Map(stats.map((s) => [s.id, s]));
    if (!activeId || !printers.some((p) => p.id === activeId)) {
      activeId = printers[0]?.id;
    }
    emit();
  } catch {
    // A failed refresh must never break the chat UI — leave the last known state.
  }
}

// ── Titlebar pill ────────────────────────────────────────────────────────────

/** Human-readable one-liner for a printer's live state. */
function stateLabel(s: PrinterStatus | undefined): string {
  if (!s) return "not connected";
  switch (s.state) {
    case "printing":
      return s.progressPct !== undefined
        ? `printing ${Math.round(s.progressPct)}%`
        : "printing";
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

function renderPill(): void {
  const pill = document.getElementById("printerPill");
  const dot = document.getElementById("printerDot");
  const label = document.getElementById("printerLabel");
  if (!pill || !dot || !label) return;

  const p = activePrinter();
  if (!p) {
    label.textContent = "No printer";
    dot.className = "dot off";
    pill.title = "Connect a 3D printer so Slicely can send prints to it";
    return;
  }
  const s = statuses.get(p.id);
  label.textContent = `${p.label} · ${stateLabel(s)}`;
  dot.className = `dot ${stateClass(s)}`;
  pill.title = `${p.label} (${p.transport}) — ${stateLabel(s)}`;
}

// ── Printer menu (click the pill) ────────────────────────────────────────────

function renderMenu(): void {
  const menu = document.getElementById("printerMenu");
  if (!menu) return;
  menu.replaceChildren();

  if (!printers.length) {
    const empty = e("div", "picker-empty", "No printers connected yet.");
    menu.appendChild(empty);
  }

  for (const p of printers) {
    const s = statuses.get(p.id);
    const item = e("button", "picker-item") as HTMLButtonElement;
    if (p.id === activeId) item.classList.add("selected");
    const dot = e("span", `dot ${stateClass(s)}`);
    const body = e("div", "picker-body");
    body.appendChild(e("div", "picker-label", p.label));
    body.appendChild(e("div", "picker-blurb", `${p.transport} · ${stateLabel(s)}`));
    item.append(dot, body);
    item.onclick = async () => {
      activeId = p.id;
      await api.setActivePrinter(p.id);
      renderAll();
      menu.classList.add("hidden");
    };
    menu.appendChild(item);
  }

  const manage = e("button", "picker-item manage") as HTMLButtonElement;
  manage.textContent = printers.length ? "Manage printers…" : "Connect a printer…";
  manage.onclick = () => {
    menu.classList.add("hidden");
    document.getElementById("settingsBtn")?.click();
    document.getElementById("printerManage")?.scrollIntoView({ behavior: "smooth" });
  };
  menu.appendChild(manage);
}

// ── Manage panel (inside the settings sheet) ─────────────────────────────────

function renderManage(): void {
  const root = document.getElementById("printerManage");
  if (!root) return;
  root.replaceChildren();

  root.appendChild(e("div", "ss-label", "Connected printers"));

  if (!printers.length) {
    root.appendChild(
      e(
        "div",
        "ss-hint",
        "None yet. Scan your network, or add one manually — Slicely can then send finished slices straight to it.",
      ),
    );
  }

  for (const p of printers) {
    const s = statuses.get(p.id);
    const row = e("div", "printer-row");

    const head = e("div", "printer-head");
    head.appendChild(e("span", `dot ${stateClass(s)}`));
    head.appendChild(e("span", "printer-name", p.label));
    head.appendChild(e("span", "printer-meta", `${p.transport} · ${stateLabel(s)}`));
    row.appendChild(head);

    // Auto-start arming. Off by default and deliberately worded as a hazard:
    // a print started on a bed that still holds the last part wrecks the
    // printer, and no consumer FDM machine reliably senses a clear bed.
    const armRow = e("label", "printer-arm");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = armed.has(p.id);
    cb.onchange = async () => {
      if (cb.checked) armed.add(p.id);
      else armed.delete(p.id);
      await api.setAutoStart(p.id, cb.checked);
      renderAll();
    };
    armRow.appendChild(cb);
    armRow.appendChild(
      e(
        "span",
        "",
        "Start prints automatically (only with a clear bed — you are responsible for checking)",
      ),
    );
    row.appendChild(armRow);

    const acts = e("div", "printer-actions");

    const testBtn = e("button", "btn ghost small", "Test") as HTMLButtonElement;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
      const r = await api.testPrinter(p.id);
      testBtn.textContent = r.ok ? "✓ Reachable" : "✗ Failed";
      toast(r.message, r.ok ? "ok" : "err");
      setTimeout(() => {
        testBtn.textContent = "Test";
        testBtn.disabled = false;
      }, 2500);
      void refresh();
    };
    acts.appendChild(testBtn);

    if (s && (s.state === "printing" || s.state === "paused")) {
      const pauseBtn = e(
        "button",
        "btn ghost small",
        s.state === "paused" ? "Resume" : "Pause",
      ) as HTMLButtonElement;
      pauseBtn.onclick = async () => {
        const r = await api.controlPrinter(
          p.id,
          s.state === "paused" ? "resume" : "pause",
        );
        toast(r.message, r.ok ? "ok" : "err");
        void refresh();
      };
      const cancelBtn = e("button", "btn ghost small danger", "Cancel") as HTMLButtonElement;
      cancelBtn.onclick = async () => {
        const r = await api.controlPrinter(p.id, "cancel");
        toast(r.message, r.ok ? "ok" : "err");
        void refresh();
      };
      acts.append(pauseBtn, cancelBtn);
    }

    const rm = e("button", "btn ghost small danger", "Remove") as HTMLButtonElement;
    rm.onclick = async () => {
      await api.removePrinter(p.id);
      await refresh();
      renderAll();
    };
    acts.appendChild(rm);

    row.appendChild(acts);
    root.appendChild(row);
  }

  const tools = e("div", "printer-tools");

  const scan = e("button", "btn ghost small", "Scan network") as HTMLButtonElement;
  scan.onclick = async () => {
    scan.disabled = true;
    scan.textContent = "Scanning…";
    try {
      const found = await api.discoverPrinters(6000);
      renderDiscovered(found);
      if (!found.length) toast("No printers found on this network.", "err");
    } finally {
      scan.textContent = "Scan network";
      scan.disabled = false;
    }
  };
  tools.appendChild(scan);

  const addBtn = e("button", "btn ghost small", "Add manually") as HTMLButtonElement;
  addBtn.onclick = () => {
    const form = document.getElementById("printerForm");
    form?.classList.toggle("hidden");
  };
  tools.appendChild(addBtn);

  root.appendChild(tools);
  root.appendChild(discoveredEl);
  root.appendChild(buildAddForm());
}

const discoveredEl = e("div", "discovered");

function renderDiscovered(found: DiscoveredPrinter[]): void {
  discoveredEl.replaceChildren();
  if (!found.length) return;
  discoveredEl.appendChild(e("div", "ss-label", `Found ${found.length} on your network`));
  for (const d of found) {
    const row = e("div", "printer-row found");
    row.appendChild(e("span", "printer-name", d.label));
    row.appendChild(
      e("span", "printer-meta", `${d.transport} · ${d.host}:${d.port}${d.needs ? ` · ${d.needs}` : ""}`),
    );
    const add = e("button", "btn primary small", "Add") as HTMLButtonElement;
    add.onclick = () => {
      const form = buildAddForm();
      form.classList.remove("hidden");
      prefill(d);
      form.scrollIntoView({ behavior: "smooth" });
    };
    row.appendChild(add);
    discoveredEl.appendChild(row);
  }
}

let formEl: HTMLElement | null = null;

function prefill(d: DiscoveredPrinter): void {
  if (!formEl) return;
  (formEl.querySelector("#pfLabel") as HTMLInputElement).value = d.label;
  (formEl.querySelector("#pfTransport") as HTMLSelectElement).value = d.transport;
  (formEl.querySelector("#pfHost") as HTMLInputElement).value = d.host;
  (formEl.querySelector("#pfPort") as HTMLInputElement).value = String(d.port);
  renderSecretFields();
}

/** Credential fields depend on the chosen transport, so they're rebuilt on change. */
function renderSecretFields(): void {
  if (!formEl) return;
  const sel = formEl.querySelector("#pfTransport") as HTMLSelectElement;
  const box = formEl.querySelector("#pfSecrets") as HTMLElement;
  box.replaceChildren();
  const entry = catalog.find((c) => c.transport === sel.value);
  for (const key of entry?.requiredSecrets ?? []) {
    const label = e("label", "pf-field");
    label.appendChild(e("span", "", secretLabel(key)));
    const input = document.createElement("input");
    input.id = `pf_${key}`;
    input.type = key === "password" || key === "token" || key === "apiKey" ? "password" : "text";
    input.placeholder = secretHint(key);
    label.appendChild(input);
    box.appendChild(label);
  }
  const hostRow = formEl.querySelector("#pfHostRow") as HTMLElement;
  // Cloud transports reach the printer over the internet — no LAN address.
  const isCloud = sel.value === "bambu-cloud" || sel.value === "prusa-connect";
  hostRow.classList.toggle("hidden", isCloud);
}

function secretLabel(k: string): string {
  switch (k) {
    case "apiKey": return "API key";
    case "accessCode": return "Access code";
    case "token": return "Account token";
    case "username": return "Username";
    case "password": return "Password";
    default: return k;
  }
}

function secretHint(k: string): string {
  switch (k) {
    case "apiKey": return "From the printer's web interface → Settings";
    case "accessCode": return "8 characters, shown on the printer's screen";
    case "token": return "From your vendor account";
    case "username": return "maker";
    case "password": return "Printer password";
    default: return "";
  }
}

function buildAddForm(): HTMLElement {
  if (formEl) return formEl;
  const form = e("div", "printer-form hidden");
  form.id = "printerForm";

  const nameRow = e("label", "pf-field");
  nameRow.appendChild(e("span", "", "Name"));
  const name = document.createElement("input");
  name.id = "pfLabel";
  name.placeholder = "Workshop MK4";
  nameRow.appendChild(name);
  form.appendChild(nameRow);

  const tRow = e("label", "pf-field");
  tRow.appendChild(e("span", "", "Type"));
  const sel = document.createElement("select");
  sel.id = "pfTransport";
  for (const c of catalog) {
    const o = document.createElement("option");
    o.value = c.transport;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  sel.onchange = renderSecretFields;
  tRow.appendChild(sel);
  form.appendChild(tRow);

  const hostRow = e("div", "pf-row");
  hostRow.id = "pfHostRow";
  const hl = e("label", "pf-field");
  hl.appendChild(e("span", "", "Host / IP"));
  const host = document.createElement("input");
  host.id = "pfHost";
  host.placeholder = "192.168.1.42";
  hl.appendChild(host);
  const pl = e("label", "pf-field narrow");
  pl.appendChild(e("span", "", "Port"));
  const port = document.createElement("input");
  port.id = "pfPort";
  port.type = "number";
  pl.appendChild(port);
  hostRow.append(hl, pl);
  form.appendChild(hostRow);

  const secrets = e("div", "pf-secrets");
  secrets.id = "pfSecrets";
  form.appendChild(secrets);

  const save = e("button", "btn primary ss-save", "Connect printer") as HTMLButtonElement;
  save.onclick = async () => {
    const transport = sel.value as PrinterTransport;
    const payload: Record<string, unknown> = {
      label: name.value.trim() || "Printer",
      transport,
      enabled: true,
    };
    if (host.value.trim()) payload.host = host.value.trim();
    if (port.value) payload.port = Number(port.value);
    const entry = catalog.find((c) => c.transport === transport);
    for (const key of entry?.requiredSecrets ?? []) {
      const input = form.querySelector(`#pf_${key}`) as HTMLInputElement | null;
      if (input?.value) payload[key] = input.value;
    }

    save.disabled = true;
    save.textContent = "Connecting…";
    try {
      const res = await api.addPrinter(
        payload as unknown as Parameters<SlicelyApi["addPrinter"]>[0],
      );
      toast(res.test.message, res.test.ok ? "ok" : "err");
      await refresh();
      renderAll();
      form.classList.add("hidden");
    } catch (err) {
      toast((err as Error).message, "err");
    } finally {
      save.disabled = false;
      save.textContent = "Connect printer";
    }
  };
  form.appendChild(save);

  formEl = form;
  renderSecretFields();
  return form;
}

// ── "Send to printer" — the action that closes the loop ──────────────────────

/**
 * Build the Send button for a slice-metrics panel. Returns null when no printer
 * is connected, so the panel simply doesn't offer it.
 *
 * The button never silently starts a print: it says "Send" unless the user has
 * armed auto-start for that printer, in which case it says "Send & start".
 */
export function sendAction(gcodePath: string): HTMLButtonElement | null {
  const p = activePrinter();
  if (!p) return null;

  const btn = document.createElement("button");
  btn.className = "btn primary";
  const willStart = armed.has(p.id);
  btn.textContent = willStart ? `Send & start → ${p.label}` : `Send to ${p.label}`;
  btn.title = willStart
    ? `Upload and immediately begin printing on ${p.label}. Make sure the bed is clear.`
    : `Upload to ${p.label} and queue it. Start it from the printer, or arm auto-start in settings.`;

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const r = await api.sendToPrinter(p.id, gcodePath, willStart);
      btn.textContent = r.ok ? (r.started ? "✓ Printing" : "✓ Queued") : "✗ Failed";
      toast(r.message, r.ok ? "ok" : "err");
    } catch (err) {
      btn.textContent = "✗ Failed";
      toast((err as Error).message, "err");
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        const still = activePrinter();
        if (still) {
          btn.textContent = armed.has(still.id)
            ? `Send & start → ${still.label}`
            : `Send to ${still.label}`;
        }
      }, 3000);
      void refresh();
    }
  };
  return btn;
}

// ── Toast ────────────────────────────────────────────────────────────────────

function toast(message: string, kind: "ok" | "err"): void {
  const host = document.getElementById("toasts") ?? document.body;
  const t = e("div", `toast ${kind}`, message);
  host.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 5000);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function renderAll(): void {
  renderPill();
  renderMenu();
  renderManage();
  emit();
}

/** Mount the printer UI and start tracking printer state. */
export async function initPrinters(): Promise<void> {
  try {
    catalog = await api.driverCatalog();
  } catch {
    catalog = [];
  }

  const pill = document.getElementById("printerPill");
  const menu = document.getElementById("printerMenu");
  if (pill && menu) {
    pill.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => menu.classList.add("hidden"));
    menu.addEventListener("click", (ev) => ev.stopPropagation());
  }

  api.onPrinterEvent((payload) => {
    printers = payload.printers;
    statuses = new Map(payload.statuses.map((s) => [s.id, s]));
    renderAll();
  });

  await refresh();
  renderAll();

  // Poll as a safety net: pushed events are the primary path, but a dropped
  // MQTT connection or a sleeping laptop shouldn't leave the pill stale.
  setInterval(() => void refresh().then(renderAll), 15_000);
}
