// ─────────────────────────────────────────────────────────────────────────────
// settings.ts — the model/effort pickers in the composer, the slice defaults in
// the settings sheet, and the model-sources panel.
//
// One SettingsState is fetched from the server and re-rendered after every
// change, so what is on screen is always what the server actually stored rather
// than an optimistic local guess.
// ─────────────────────────────────────────────────────────────────────────────
import type { EffortLevel, FeatureMode, PrintPreferences, SettingsState } from "../shared/types";
import type { SourceAvailability, SourceStatus } from "../shared/sourcing";
import { account, del, errorMessage, getJson, patchJson, resetSession, setAccount } from "./api.js";
import { byId, confirmDialog, errorCard, externalLink, make, menu, skeleton, toast } from "./ui.js";
import {
  config,
  configLoaded,
  freeTier,
  hasKey,
  providerLabel,
  providersWithKeys,
  renderAboutSection,
  renderAiSection,
} from "./onboarding.js";
import { signOut } from "./account.js";

export interface SettingsDeps {
  /** Report a failed change where the user will see it. */
  onError(message: string): void;
  /** The user asked to join the waitlist for a paid plan. */
  openWaitlist(): void;
}

/**
 * Is this session spending Slicely's credit rather than its own key?
 *
 * The one question that decides whether a model can be chosen at all: free
 * credit runs on one model at one effort, so offering the pickers would be
 * offering something the server will refuse. True for anyone already signed
 * in and on credit, but also for a signed-out visitor at an accounts deploy —
 * they are headed for free credit the moment they sign in, so the pickers are
 * just as wrong to offer them before that.
 */
function onFreeCredit(): boolean {
  return !hasKey() && (account().signedIn || config().accountsEnabled);
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

let aiModelFields: HTMLElement;
let freeModelNote: HTMLElement;
let accountGroup: HTMLElement;
let accountBody: HTMLElement;

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
  // On free credit there is one model at one effort, so the two pickers are not
  // a choice — they are two controls that would be refused. They come back the
  // moment a key of their own is connected.
  const onCredit = onFreeCredit();
  modelTriggerBtn.classList.toggle("hidden", onCredit);
  effortTriggerBtn.classList.toggle("hidden", onCredit || !(chosen?.supportsEffort ?? false));
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
/**
 * The one line above Settings → AI's rows, and the model/effort fields below
 * them.
 *
 * Said only to somebody with no key of their own, for whom it is the whole
 * story: this is the model, this is the effort, and a key of your own is how
 * you change either. Returns true when the fields are hidden, so the caller can
 * stop before filling in controls nobody can see.
 */
function renderFreeModelNote(): boolean {
  const free = freeTier();
  const sayFree = Boolean(free) && onFreeCredit();
  freeModelNote.classList.toggle("hidden", !sayFree);
  if (free && sayFree) {
    freeModelNote.textContent = `Free credit runs on ${free.modelLabel} at ${free.effort} effort. Add your own key to choose models.`;
  }
  const onCredit = onFreeCredit();
  aiModelFields.classList.toggle("hidden", onCredit);
  return onCredit;
}

function renderAiModelFields(): void {
  if (!settings || !ssModel) return;
  const { current, models, efforts } = settings;
  const connected = new Set(providersWithKeys());

  if (renderFreeModelNote()) return;

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

/** Dot colour per state. A source that is simply off on this server is not an
 *  error, so it gets the neutral dot rather than the red one. */
const STATUS_DOT: Record<SourceStatus, string> = {
  ready: "ok",
  limited: "warn",
  search_only: "warn",
  off: "",
};

/** The standard sentence for each state, so a server too old to send `note`
 *  still renders plain words instead of nothing. */
const STATUS_NOTE: Record<SourceStatus, string> = {
  ready: "Search and download",
  limited: "Limited on this server",
  search_only: "Search only — downloads open on their site",
  off: "Off on this server",
};

/** What the server said, defaulted for a server that predates `status`. */
function statusOf(s: SourceAvailability): SourceStatus {
  if (s.status) return s.status;
  if (!s.searchable) return "off";
  return s.downloadable ? "ready" : "search_only";
}

/**
 * Settings → Model sources.
 *
 * ONE LINE PER SOURCE, AND NOT A WORD ABOUT .env. What a visitor needs is
 * whether a source works, so each row is a name, a dot and one short sentence.
 * The env-var instructions the server also sends are for whoever runs the
 * server, and only in desktop mode is that the person looking at the screen —
 * so `operatorHint` is rendered there and nowhere else.
 *
 * Sources that are off are not errors and not actionable, so they go under one
 * collapsed line instead of six dead rows between the live ones.
 */
function renderSources(sources: SourceAvailability[]): void {
  sourcesListEl.replaceChildren();
  if (sources.length === 0) {
    sourcesListEl.appendChild(make("p", "sheet-hint", "No sources reported."));
    return;
  }
  const working = sources.filter((s) => statusOf(s) !== "off");
  const off = sources.filter((s) => statusOf(s) === "off");

  if (working.length > 0) {
    const card = make("div", "source-card");
    for (const s of working) card.appendChild(sourceRow(s));
    sourcesListEl.appendChild(card);
  }
  if (off.length === 0) return;

  const offCard = make("div", "source-card off hidden");
  for (const s of off) offCard.appendChild(sourceRow(s));

  const toggle = make("button", "source-more");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.appendChild(
    make(
      "span",
      "",
      off.length === 1 ? "1 source is off on this server" : `${off.length} sources are off on this server`,
    ),
  );
  toggle.appendChild(make("span", "chev", "›"));
  toggle.addEventListener("click", () => {
    const collapsed = offCard.classList.toggle("hidden");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
  sourcesListEl.append(toggle, offCard);
}

function sourceRow(s: SourceAvailability): HTMLElement {
  const status = statusOf(s);
  const row = make("div", "source-row");
  row.appendChild(make("span", `dot ${STATUS_DOT[status]}`.trim()));
  const info = make("div", "info");
  info.appendChild(make("div", "name", s.label));
  info.appendChild(make("div", "note", s.note || STATUS_NOTE[status]));

  // Desktop only: on a machine the user owns, the operator IS the user, so the
  // thing they'd have to change is worth saying. On a shared server it is
  // somebody else's .env and nothing the reader can act on.
  if (config().mode === "desktop" && s.operatorHint) {
    const hint = make("div", "op-hint");
    hint.appendChild(document.createTextNode(s.operatorHint));
    if (s.setupUrl) {
      hint.appendChild(document.createTextNode(" "));
      hint.appendChild(externalLink(s.setupUrl, "Get one"));
    }
    info.appendChild(hint);
  }
  row.appendChild(info);
  return row;
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
  const signedIn = account().signedIn;
  dataBody.replaceChildren();
  dataBody.appendChild(
    make(
      "p",
      "sheet-hint",
      "Everything Slicely holds for you lives in one session: your key, chats, printer connections and files.",
    ),
  );
  // Said before the button, not only in the dialog: deleting is the one action
  // here that cannot be undone, and free credit is not granted twice.
  if (signedIn) {
    dataBody.appendChild(
      make(
        "p",
        "sheet-hint",
        "This also deletes your Slicely account. Free credit isn't granted twice, so signing in again won't give you a new balance.",
      ),
    );
  }
  const btn = make("button", "btn ghost small danger", "Delete my data");
  btn.type = "button";
  btn.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Delete everything?",
        body: signedIn
          ? "Your account, key, chats, printer connections and workspace files are deleted from the server. Free credit isn't granted twice, so signing in again won't give you a new balance. This cannot be undone."
          : "Your key, chats, printer connections and workspace files are deleted from the server. This cannot be undone.",
        confirmLabel: "Delete my data",
        danger: true,
      });
      if (!ok) return;
      try {
        await del("/api/session");
        // The account went with the session, so nothing in this page should
        // still be claiming a balance while the reload happens.
        setAccount({ signedIn: false });
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

// ── Settings → Account ───────────────────────────────────────────────────────

/** One labelled row in the Account section, reusing Settings → AI's row so the
 *  two panels read as one column rather than two designs. */
function accountRow(name: string, value: string, action?: HTMLElement): HTMLElement {
  const row = make("div", "ai-row");
  const head = make("div", "ai-row-head");
  const text = make("div", "ai-text");
  text.append(make("span", "ai-name", name), make("span", "ai-status", value));
  head.appendChild(text);
  if (action) {
    const actions = make("div", "ai-actions");
    actions.appendChild(action);
    head.appendChild(actions);
  }
  row.appendChild(head);
  return row;
}

function ghostButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = make("button", "btn ghost small", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Settings → Account: who you are, what is left, and the two things you can do
 * about it.
 *
 * Hidden outright unless somebody is actually signed in — on desktop, on a
 * BYO-only server, and for a visitor who pasted a key without signing in, there
 * is no account to describe and an empty section would be a lie.
 */
function renderAccountSection(): void {
  const me = account();
  const acct = me.signedIn ? me.account : undefined;
  const show = configLoaded() && config().accountsEnabled && Boolean(acct);
  accountGroup.classList.toggle("hidden", !show);
  accountBody.replaceChildren();
  if (!acct) return;

  const free = freeTier();
  const rows = make("div", "ai-rows");
  rows.append(
    accountRow("Signed in as", acct.email, ghostButton("Sign out", () => void signOut())),
    accountRow("Free credit", `${acct.balanceLabel} left of ${acct.grantedLabel}`),
    accountRow("Chats today", `${acct.chatsToday} of ${acct.chatsPerDay}`),
  );
  if (free) rows.appendChild(accountRow("Running on", `${free.modelLabel}, ${free.effort} effort`));
  rows.appendChild(
    accountRow("Paid plans", "Coming soon", ghostButton("Join the waitlist", () => deps.openWaitlist())),
  );
  accountBody.appendChild(rows);
}

/** Redraw the sections that describe the account rather than a slice.
 *
 *  With no /api/config there is nothing truthful to say about a key, so the AI
 *  section stays hidden rather than claiming one is connected. */
export function renderAccount(): void {
  renderAccountSection();
  byId<HTMLElement>("aiGroup").classList.toggle("hidden", !configLoaded());
  if (configLoaded()) {
    renderAiSection(aiBody);
    renderFreeModelNote();
    // The composer's pickers answer to the same question this panel does — is
    // this session spending its own key or Slicely's credit — so they are
    // repainted here too, not only when settings are fetched.
    renderModelEffort();
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
  aiModelFields = byId<HTMLElement>("aiModelFields");
  freeModelNote = byId<HTMLElement>("freeModelNote");
  accountGroup = byId<HTMLElement>("accountGroup");
  accountBody = byId<HTMLElement>("accountBody");
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
