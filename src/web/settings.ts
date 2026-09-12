// ─────────────────────────────────────────────────────────────────────────────
// settings.ts — the model/effort pickers in the composer, the slice defaults in
// the settings sheet, and the model-sources panel.
//
// One SettingsState is fetched from the server and re-rendered after every
// change, so what is on screen is always what the server actually stored rather
// than an optimistic local guess.
// ─────────────────────────────────────────────────────────────────────────────
import type { EffortLevel, FeatureMode, PrintPreferences, SettingsState } from "../shared/types";
import type { SourceAvailability } from "../shared/sourcing";
import { del, getJson, patchJson } from "./api.js";
import { byId, confirmDialog, make, menu, toast } from "./ui.js";
import { renderAboutSection, renderAiSection } from "./onboarding.js";

export interface SettingsDeps {
  /** Report a failed change where the user will see it. */
  onError(message: string): void;
}

export interface SettingsApi {
  load(): Promise<void>;
}

let deps: SettingsDeps;
let settings: SettingsState | null = null;

// Model + effort composer dropdowns
let modelTriggerBtn: HTMLButtonElement;
let modelTriggerLabel: HTMLElement;
let effortTriggerBtn: HTMLButtonElement;
let effortTriggerLabel: HTMLElement;

// Slice-defaults sheet
let ssPrinter: HTMLSelectElement;
let ssCustom: HTMLElement;
let ssBedX: HTMLInputElement;
let ssBedY: HTMLInputElement;
let ssBedZ: HTMLInputElement;
let ssNozzle: HTMLInputElement;
let ssMaterial: HTMLSelectElement;
let ssGoal: HTMLSelectElement;
let ssInfill: HTMLInputElement;
let ssPattern: HTMLSelectElement;
let ssSupports: HTMLElement;
let ssStyleRow: HTMLElement;
let ssSupportStyle: HTMLSelectElement;
let ssBrim: HTMLElement;
let ssBrimWidth: HTMLInputElement;

let sourcesListEl: HTMLElement;
let aiBody: HTMLElement;
let dataBody: HTMLElement;
let aboutBody: HTMLElement;

// ── loading ──────────────────────────────────────────────────────────────────

export async function loadSettings(): Promise<void> {
  try {
    settings = await getJson<SettingsState>("/api/settings");
    renderModelEffort();
    renderPreferences();
  } catch {
    /* the dropdowns/sheet just stay at their defaults */
  }
}

/** The slice defaults a new print job should be planned with. */
export function planOptions(): { bed: { x: number; y: number; z: number }; goal?: string; material?: string } {
  return {
    bed: resolveBed(),
    goal: settings?.preferences.goal ?? undefined,
    material: settings?.preferences.material ?? undefined,
  };
}

function resolveBed(): { x: number; y: number; z: number } {
  const pref = settings?.preferences.printer;
  if (pref?.key === "custom" && pref.bed) return pref.bed;
  if (pref?.key) {
    const known = settings?.printers.find((p) => p.key === pref.key);
    if (known) return known.bed;
  }
  return { x: 250, y: 210, z: 210 };
}

// ── model + effort dropdowns ─────────────────────────────────────────────────
// Both are real menus now: ui.ts's menu() builds `role="menuitem"` buttons,
// wires the arrow keys and Escape, and hands focus back to the trigger. The
// items are built at open time from the settings just fetched, so the menu can
// never show a stale model list.

function effortDisabled(lvl: EffortLevel, m: SettingsState["models"][number] | undefined): boolean {
  if (!m) return false;
  if (!m.supportsEffort) return true;
  if (lvl === "xhigh" && !m.supportsXHigh) return true;
  if (lvl === "max" && !m.supportsMax) return true;
  return false;
}

function openModelMenu(): void {
  if (!settings) return;
  const { current, models } = settings;
  menu(
    modelTriggerBtn,
    models.map((m) => ({ id: m.id, label: m.label, hint: m.blurb, active: m.id === current.model })),
    (id) => void changeSettings({ model: id }),
  );
}

function openEffortMenu(): void {
  if (!settings) return;
  const { current, models, efforts } = settings;
  const chosen = models.find((m) => m.id === current.model);
  menu(
    effortTriggerBtn,
    efforts.map((lvl) => {
      const disabled = effortDisabled(lvl, chosen);
      return { id: lvl, label: cap(lvl), disabled, active: lvl === current.effort && !disabled };
    }),
    (id) => void changeSettings({ effort: id as EffortLevel }),
  );
}

function renderModelEffort(): void {
  if (!settings) return;
  const { current, models } = settings;
  const chosen = models.find((m) => m.id === current.model);
  modelTriggerLabel.textContent = chosen?.label ?? current.model;
  effortTriggerBtn.classList.toggle("hidden", !(chosen?.supportsEffort ?? false));
  effortTriggerLabel.textContent = current.effort;
}

async function changeSettings(patch: Partial<{ model: string; effort: EffortLevel }>): Promise<void> {
  try {
    settings = await patchJson<SettingsState>("/api/settings", patch);
    renderModelEffort();
  } catch (err) {
    deps.onError((err as Error).message || "Couldn't change that setting.");
  }
}

// ── slice defaults (printer, material, goal, infill, supports, brim) ─────────

function fillSelect(sel: HTMLSelectElement, options: { value: string; label: string }[], current: string): void {
  sel.replaceChildren();
  for (const o of options) {
    const opt = make("option", "", o.label);
    opt.value = o.value;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderSegment(host: HTMLElement, current: FeatureMode, onPick: (mode: FeatureMode) => void): void {
  host.replaceChildren();
  for (const mode of ["auto", "on", "off"] as FeatureMode[]) {
    const b = make("button", "", mode);
    b.type = "button";
    if (mode === current) b.classList.add("active");
    b.onclick = () => onPick(mode);
    host.appendChild(b);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function renderPreferences(): void {
  if (!settings) return;
  const { preferences: p, printers, materials, goals } = settings;

  fillSelect(
    ssPrinter,
    [
      { value: "", label: "Not set (ask me)" },
      ...printers.map((pr) => ({ value: pr.key, label: pr.label })),
      { value: "custom", label: "Custom…" },
    ],
    p.printer?.key ?? "",
  );
  const isCustom = p.printer?.key === "custom";
  ssCustom.classList.toggle("hidden", !isCustom);
  if (isCustom && p.printer?.bed) {
    ssBedX.value = String(p.printer.bed.x);
    ssBedY.value = String(p.printer.bed.y);
    ssBedZ.value = String(p.printer.bed.z);
    ssNozzle.value = String(p.printer.nozzleMm ?? 0.4);
  }

  fillSelect(ssMaterial, [{ value: "", label: "Default (PLA)" }, ...materials.map((m) => ({ value: m, label: m }))], p.material ?? "");
  fillSelect(ssGoal, [{ value: "", label: "Ask me / quality" }, ...goals.map((g) => ({ value: g, label: cap(g) }))], p.goal ?? "");
  ssInfill.value = p.fillDensityPct !== undefined ? String(p.fillDensityPct) : "";
  fillSelect(
    ssPattern,
    [
      { value: "", label: "Auto (by goal)" },
      ...["gyroid", "grid", "rectilinear", "honeycomb", "cubic", "triangles"].map((v) => ({ value: v, label: cap(v) })),
    ],
    p.fillPattern ?? "",
  );

  renderSegment(ssSupports, p.supports ?? "auto", (mode) => void savePref({ supports: mode }));
  ssStyleRow.classList.toggle("hidden", (p.supports ?? "auto") === "off");
  fillSelect(
    ssSupportStyle,
    [
      { value: "grid", label: "Grid (classic)" },
      { value: "organic", label: "Organic (tree)" },
      { value: "snug", label: "Snug" },
    ],
    p.supportStyle ?? "grid",
  );
  renderSegment(ssBrim, p.brim ?? "auto", (mode) => void savePref({ brim: mode }));
  ssBrimWidth.value = p.brimWidthMm !== undefined ? String(p.brimWidthMm) : "";
}

async function savePref(patch: Partial<PrintPreferences>): Promise<void> {
  try {
    settings = await patchJson<SettingsState>("/api/preferences", patch);
    renderPreferences();
  } catch (err) {
    deps.onError((err as Error).message || "Couldn't save that preference.");
  }
}

// ── model sources panel ──────────────────────────────────────────────────────

export async function loadSources(): Promise<void> {
  try {
    const sources = await getJson<SourceAvailability[]>("/api/sources");
    renderSources(sources);
  } catch {
    sourcesListEl.replaceChildren(
      make("p", "sheet-hint", "Model sourcing isn't available on this server yet."),
    );
  }
}

function renderSources(sources: SourceAvailability[]): void {
  sourcesListEl.replaceChildren();
  if (sources.length === 0) {
    sourcesListEl.appendChild(make("p", "sheet-hint", "No sources reported."));
    return;
  }
  for (const s of sources) {
    const row = make("div", "source-row");
    const cls = s.searchable && s.downloadable ? "ok" : s.searchable ? "warn" : "off";
    row.appendChild(make("span", `dot ${cls}`));
    const info = make("div", "info");
    const name = make("div", "name");
    name.appendChild(make("span", "", s.label));
    if (s.searchable) name.appendChild(make("span", "cap", "search"));
    if (s.downloadable) name.appendChild(make("span", "cap", "download"));
    info.appendChild(name);
    if (s.blockedReason) {
      const reason = make("div", "reason");
      reason.appendChild(document.createTextNode(`${s.blockedReason} `));
      if (s.setupUrl) {
        const link = make("a", "", "Get one →");
        link.href = s.setupUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        reason.appendChild(link);
      }
      info.appendChild(reason);
    }
    row.appendChild(info);
    sourcesListEl.appendChild(row);
  }
}

// ── AI / Data / About ────────────────────────────────────────────────────────

/**
 * Settings → Data.
 *
 * One button, because there is exactly one thing to delete: the session holding
 * the key, the chats, the printers and the workspace files. It asks first and
 * then reloads into a clean one.
 */
function renderDataSection(): void {
  dataBody.replaceChildren();
  dataBody.appendChild(
    make(
      "p",
      "sheet-hint",
      "Deletes your session: the connected key, saved chats, printer connections and every file in your workspace.",
    ),
  );
  const btn = make("button", "btn ghost small danger", "Delete my data");
  btn.type = "button";
  btn.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Delete everything?",
        body: "Your key, chats, printer connections and workspace files are deleted from the server. This cannot be undone.",
        confirmLabel: "Delete my data",
        danger: true,
      });
      if (!ok) return;
      try {
        await del("/api/session");
        location.reload();
      } catch (err) {
        toast((err as Error).message || "Couldn't delete your data.", "error");
      }
    })();
  });
  dataBody.appendChild(btn);
}

/** Redraw the three sections that describe the account rather than a slice. */
export function renderAccount(): void {
  renderAiSection(aiBody);
  renderDataSection();
  renderAboutSection(aboutBody);
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function initSettings(d: SettingsDeps): SettingsApi {
  deps = d;
  modelTriggerBtn = byId<HTMLButtonElement>("modelTrigger");
  modelTriggerLabel = byId<HTMLElement>("modelTriggerLabel");
  effortTriggerBtn = byId<HTMLButtonElement>("effortTrigger");
  effortTriggerLabel = byId<HTMLElement>("effortTriggerLabel");

  ssPrinter = byId<HTMLSelectElement>("ssPrinter");
  ssCustom = byId<HTMLElement>("ssCustom");
  ssBedX = byId<HTMLInputElement>("ssBedX");
  ssBedY = byId<HTMLInputElement>("ssBedY");
  ssBedZ = byId<HTMLInputElement>("ssBedZ");
  ssNozzle = byId<HTMLInputElement>("ssNozzle");
  ssMaterial = byId<HTMLSelectElement>("ssMaterial");
  ssGoal = byId<HTMLSelectElement>("ssGoal");
  ssInfill = byId<HTMLInputElement>("ssInfill");
  ssPattern = byId<HTMLSelectElement>("ssPattern");
  ssSupports = byId<HTMLElement>("ssSupports");
  ssStyleRow = byId<HTMLElement>("ssStyleRow");
  ssSupportStyle = byId<HTMLSelectElement>("ssSupportStyle");
  ssBrim = byId<HTMLElement>("ssBrim");
  ssBrimWidth = byId<HTMLInputElement>("ssBrimWidth");
  sourcesListEl = byId<HTMLElement>("sourcesList");
  aiBody = byId<HTMLElement>("aiBody");
  dataBody = byId<HTMLElement>("dataBody");
  aboutBody = byId<HTMLElement>("aboutBody");

  // Each trigger opens its own menu; ui.ts's menu() owns closing it (outside
  // click, Escape, Tab) and returning focus.
  modelTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModelMenu();
  });
  effortTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEffortMenu();
  });

  ssPrinter.addEventListener("change", () => {
    const key = ssPrinter.value;
    if (key === "") {
      void savePref({ printer: null as unknown as PrintPreferences["printer"] });
    } else if (key === "custom") {
      ssCustom.classList.remove("hidden");
    } else {
      const pr = settings?.printers.find((x) => x.key === key);
      void savePref({ printer: { key, label: pr?.label } });
    }
  });
  byId<HTMLButtonElement>("ssSaveCustom").addEventListener("click", () => {
    const x = Number(ssBedX.value);
    const y = Number(ssBedY.value);
    const z = Number(ssBedZ.value);
    const n = Number(ssNozzle.value);
    if (![x, y, z].every((v) => Number.isFinite(v) && v > 0)) {
      deps.onError("Enter a valid bed size (X, Y, Z in mm) for the custom printer.");
      return;
    }
    void savePref({
      printer: {
        key: "custom",
        label: `Custom ${x}×${y}×${z}`,
        bed: { x, y, z },
        nozzleMm: Number.isFinite(n) && n > 0 ? n : 0.4,
      },
    });
  });
  ssMaterial.addEventListener("change", () =>
    void savePref({ material: (ssMaterial.value || null) as unknown as PrintPreferences["material"] }),
  );
  ssGoal.addEventListener("change", () =>
    void savePref({ goal: (ssGoal.value || null) as unknown as PrintPreferences["goal"] }),
  );
  ssInfill.addEventListener("change", () => {
    const v = ssInfill.value.trim();
    void savePref({ fillDensityPct: (v === "" ? null : Number(v)) as unknown as PrintPreferences["fillDensityPct"] });
  });
  ssPattern.addEventListener("change", () =>
    void savePref({ fillPattern: (ssPattern.value || null) as unknown as PrintPreferences["fillPattern"] }),
  );
  ssSupportStyle.addEventListener("change", () =>
    void savePref({ supportStyle: ssSupportStyle.value as unknown as PrintPreferences["supportStyle"] }),
  );
  ssBrimWidth.addEventListener("change", () => {
    const v = ssBrimWidth.value.trim();
    void savePref({ brimWidthMm: (v === "" ? null : Number(v)) as unknown as PrintPreferences["brimWidthMm"] });
  });

  byId<HTMLButtonElement>("sourcesRefreshBtn").addEventListener("click", () => void loadSources());

  // "Fine tuning" disclosure. Collapsed by default so the sheet opens as three
  // decisions rather than eleven; Slicely derives all of these per model anyway.
  const advToggle = byId<HTMLButtonElement>("advToggle");
  const advFields = byId<HTMLElement>("advFields");
  advToggle.addEventListener("click", () => {
    const collapsed = advFields.classList.toggle("hidden");
    advToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });

  return { load: loadSettings };
}
