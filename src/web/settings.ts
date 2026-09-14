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
import { del, errorMessage, getJson, patchJson, resetSession } from "./api.js";
import { byId, confirmDialog, errorCard, make, menu, skeleton, toast } from "./ui.js";
import { configLoaded, providerLabel, providersWithKeys, renderAboutSection, renderAiSection } from "./onboarding.js";

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

// Settings → AI: the same model and effort as the composer pills, laid out as a
// grouped select and a segmented control.
let ssModel: HTMLSelectElement;
let ssEffortRow: HTMLElement;
let ssEffort: HTMLElement;

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
// Both are real menus now: ui.ts's menu() builds `role="menuitemradio"` buttons
// (single-choice menus, so the checked state is on the item rather than implied),
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
  // GROUPED BY PROVIDER, and a provider with no key has its models disabled with
  // the missing step as the hint. Letting someone pick a model they cannot pay
  // for would answer with a 409 from PATCH /api/settings and leave them to work
  // out which of two keys was missing.
  const connected = new Set(providersWithKeys());
  menu(
    modelTriggerBtn,
    models.map((m) => {
      const usable = connected.has(m.provider);
      return {
        id: m.id,
        label: m.label,
        group: providerLabel(m.provider),
        hint: usable ? m.blurb : `No ${providerLabel(m.provider)} key connected`,
        disabled: !usable,
        active: m.id === current.model && usable,
      };
    }),
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
      return { id: lvl, label: effortLabel(lvl), disabled, active: lvl === current.effort && !disabled };
    }),
    (id) => void changeSettings({ effort: id as EffortLevel }),
  );
}

/** Plain words for an effort level, so a segmented control never reads
 *  "Xhigh". */
const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function effortLabel(lvl: string): string {
  return EFFORT_LABEL[lvl] ?? cap(lvl);
}

function renderModelEffort(): void {
  if (!settings) return;
  const { current, models } = settings;
  const chosen = models.find((m) => m.id === current.model);
  modelTriggerLabel.textContent = chosen?.label ?? current.model;
  effortTriggerBtn.classList.toggle("hidden", !(chosen?.supportsEffort ?? false));
  effortTriggerLabel.textContent = effortLabel(current.effort);
  renderAiModelFields();
}

/**
 * Settings → AI's model and effort controls.
 *
 * One select grouped by provider rather than a second dropdown menu, because
 * this is a form and the rest of the sheet is made of selects. A provider with
 * no key has its whole group disabled and says why in the group's own label,
 * which is the one place a `<select>` can carry a hint.
 */
function renderAiModelFields(): void {
  if (!settings || !ssModel) return;
  const { current, models, efforts } = settings;
  const connected = new Set(providersWithKeys());

  ssModel.replaceChildren();
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.provider)) continue;
    seen.add(m.provider);
    const usable = connected.has(m.provider);
    const group = document.createElement("optgroup");
    group.label = usable ? providerLabel(m.provider) : `${providerLabel(m.provider)} — no key connected`;
    for (const model of models.filter((x) => x.provider === m.provider)) {
      const opt = make("option", "", model.label);
      opt.value = model.id;
      opt.disabled = !usable;
      if (model.id === current.model) opt.selected = true;
      group.appendChild(opt);
    }
    ssModel.appendChild(group);
  }

  const chosen = models.find((m) => m.id === current.model);
  ssEffortRow.classList.toggle("hidden", !(chosen?.supportsEffort ?? false));
  ssEffort.replaceChildren();
  for (const lvl of efforts) {
    const disabled = effortDisabled(lvl, chosen);
    const b = make("button", "", effortLabel(lvl));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.disabled = disabled;
    const on = lvl === current.effort && !disabled;
    b.setAttribute("aria-checked", on ? "true" : "false");
    if (on) b.classList.add("active");
    b.onclick = () => void changeSettings({ effort: lvl });
    ssEffort.appendChild(b);
  }
}

async function changeSettings(patch: Partial<{ model: string; effort: EffortLevel }>): Promise<void> {
  try {
    settings = await patchJson<SettingsState>("/api/settings", patch);
    renderModelEffort();
  } catch (err) {
    deps.onError(errorMessage(err, "Couldn't change that setting."));
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
    const b = make("button", "", cap(mode));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", mode === current ? "true" : "false");
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
    deps.onError(errorMessage(err, "Couldn't save that preference."));
  }
}

// ── model sources panel ──────────────────────────────────────────────────────

export async function loadSources(): Promise<void> {
  sourcesListEl.replaceChildren(skeleton(3));
  try {
    const sources = await getJson<SourceAvailability[]>("/api/sources");
    renderSources(sources);
  } catch (err) {
    sourcesListEl.replaceChildren(
      errorCard(errorMessage(err, "Couldn't load the model sources."), () => void loadSources()),
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
      "Everything Slicely holds for you lives in one session: your key, chats, printer connections and files.",
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
        // The cookie we were holding now names a session the server has thrown
        // away (hosted) or emptied (desktop), and api.ts caches the boot promise
        // for the life of the page. Without this, the first call after the delete
        // — which on a fast reload is the reload's own — spends a round trip on a
        // 401 `no_session` before recovering.
        resetSession();
        location.reload();
      } catch (err) {
        toast(errorMessage(err, "Couldn't delete your data."), "error");
      }
    })();
  });
  dataBody.appendChild(btn);
}

/** Redraw the three sections that describe the account rather than a slice.
 *
 *  With no /api/config there is nothing truthful to say about a key, so the AI
 *  section stays hidden rather than claiming one is connected. */
export function renderAccount(): void {
  byId<HTMLElement>("aiGroup").classList.toggle("hidden", !configLoaded());
  if (configLoaded()) {
    renderAiSection(aiBody);
    renderAiModelFields();
  }
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
  ssModel = byId<HTMLSelectElement>("ssModel");
  ssEffortRow = byId<HTMLElement>("ssEffortRow");
  ssEffort = byId<HTMLElement>("ssEffort");
  sourcesListEl = byId<HTMLElement>("sourcesList");
  aiBody = byId<HTMLElement>("aiBody");
  dataBody = byId<HTMLElement>("dataBody");
  aboutBody = byId<HTMLElement>("aboutBody");

  // Each trigger opens its own menu; ui.ts's menu() owns closing it (outside
  // click, Escape, Tab) and returning focus.
  ssModel.addEventListener("change", () => void changeSettings({ model: ssModel.value }));

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
