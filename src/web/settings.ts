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
import { getJson, patchJson } from "./api.js";
import { byId, make } from "./ui.js";

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
let modelMenuEl: HTMLElement;
let effortTriggerBtn: HTMLButtonElement;
let effortTriggerLabel: HTMLElement;
let effortMenuEl: HTMLElement;

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

function toggleMenu(which: "model" | "effort"): void {
  const menuEl = which === "model" ? modelMenuEl : effortMenuEl;
  const trigger = which === "model" ? modelTriggerBtn : effortTriggerBtn;
  const willOpen = menuEl.classList.contains("hidden");
  closeMenus();
  if (willOpen) {
    menuEl.classList.remove("hidden");
    trigger.classList.add("open");
  }
}

export function closeMenus(): void {
  modelMenuEl.classList.add("hidden");
  effortMenuEl.classList.add("hidden");
  modelTriggerBtn.classList.remove("open");
  effortTriggerBtn.classList.remove("open");
}

function effortDisabled(lvl: EffortLevel, m: SettingsState["models"][number] | undefined): boolean {
  if (!m) return false;
  if (!m.supportsEffort) return true;
  if (lvl === "xhigh" && !m.supportsXHigh) return true;
  if (lvl === "max" && !m.supportsMax) return true;
  return false;
}

function renderModelEffort(): void {
  if (!settings) return;
  const { current, models, efforts } = settings;
  const chosen = models.find((m) => m.id === current.model);

  modelTriggerLabel.textContent = chosen?.label ?? current.model;
  const supportsEffort = chosen?.supportsEffort ?? false;
  effortTriggerBtn.classList.toggle("hidden", !supportsEffort);
  effortTriggerLabel.textContent = current.effort;

  modelMenuEl.replaceChildren();
  for (const m of models) {
    const active = m.id === current.model;
    const item = make("div", `menu-item${active ? " active" : ""}`);
    const text = make("div", "mtext");
    text.appendChild(make("div", "mname", m.label));
    text.appendChild(make("div", "mblurb", m.blurb));
    item.appendChild(text);
    item.appendChild(make("span", "check", "✓"));
    item.onclick = () => {
      closeMenus();
      void changeSettings({ model: m.id });
    };
    modelMenuEl.appendChild(item);
  }

  effortMenuEl.replaceChildren();
  for (const lvl of efforts) {
    const disabled = effortDisabled(lvl, chosen);
    const active = lvl === current.effort && !disabled;
    const item = make("div", `menu-item effort${active ? " active" : ""}${disabled ? " disabled" : ""}`);
    const text = make("div", "mtext");
    text.appendChild(make("div", "mname", lvl));
    item.appendChild(text);
    item.appendChild(make("span", "check", "✓"));
    item.onclick = () => {
      if (disabled) return;
      closeMenus();
      void changeSettings({ effort: lvl });
    };
    effortMenuEl.appendChild(item);
  }
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

// ── wiring ───────────────────────────────────────────────────────────────────

export function initSettings(d: SettingsDeps): SettingsApi {
  deps = d;
  modelTriggerBtn = byId<HTMLButtonElement>("modelTrigger");
  modelTriggerLabel = byId<HTMLElement>("modelTriggerLabel");
  modelMenuEl = byId<HTMLElement>("modelMenu");
  effortTriggerBtn = byId<HTMLButtonElement>("effortTrigger");
  effortTriggerLabel = byId<HTMLElement>("effortTriggerLabel");
  effortMenuEl = byId<HTMLElement>("effortMenu");

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

  // Model + effort dropdowns: each trigger toggles its own menu; both close on
  // outside-click or Escape.
  modelTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("model");
  });
  effortTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("effort");
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) {
      closeMenus();
      return;
    }
    if (modelMenuEl.contains(t) || modelTriggerBtn.contains(t)) return;
    if (effortMenuEl.contains(t) || effortTriggerBtn.contains(t)) return;
    closeMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
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
