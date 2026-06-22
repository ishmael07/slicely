// Slicely renderer. Talks to the main process exclusively through the typed
// `window.slicely` bridge exposed by preload.ts. Renders the chat transcript,
// model cards, and slice-metric panels from streamed agent events — with
// entrance animations, a live streaming caret, and a live PrusaSlicer status
// pill driven by pushed status events.
import type {
  AgentEvent,
  ModelResult,
  ModelInfo,
  SliceMetrics,
  SlicerStatus,
  ConfigState,
  SlicelyApi,
  SettingsState,
  EffortLevel,
  UploadResult,
} from "../shared/types";
// NOTE: explicit ".js" — the renderer is native browser ESM (no bundler), so
// the import specifier must match the emitted filename exactly.
import { renderMarkdown } from "./markdown.js";

declare global {
  interface Window {
    slicely: SlicelyApi;
  }
}

const api = window.slicely;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const messagesEl = $<HTMLDivElement>("messages");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const bannerEl = $<HTMLDivElement>("banner");
const statusDot = $<HTMLSpanElement>("statusDot");
const statusText = $<HTMLSpanElement>("statusText");
const modelTriggerBtn = $<HTMLButtonElement>("modelTrigger");
const modelTriggerLabel = $<HTMLSpanElement>("modelTriggerLabel");
const modelMenuEl = $<HTMLDivElement>("modelMenu");
const effortTriggerBtn = $<HTMLButtonElement>("effortTrigger");
const effortTriggerLabel = $<HTMLSpanElement>("effortTriggerLabel");
const effortMenuEl = $<HTMLDivElement>("effortMenu");
const attachBtn = $<HTMLButtonElement>("attach");
const attachTrayEl = $<HTMLDivElement>("attachTray");
const dropzoneEl = $<HTMLDivElement>("dropzone");

let busy = false;
/** The bot bubble currently being streamed into (markdown re-rendered per delta). */
let activeBotBubble: HTMLDivElement | null = null;
/** Raw (unparsed) markdown accumulated for the active bubble. */
let activeBotRaw = "";
/** The collapsible reasoning block + its raw text for the current turn. */
let activeThinkingBody: HTMLElement | null = null;
let activeThinkingRaw = "";
/** Pending rAF handle for throttled markdown re-render. */
let renderFrame = 0;
/** Active tool chips by tool name, so tool_end can finalize the right one. */
const activeChips = new Map<string, HTMLDivElement>();
/** Path of the most-recently downloaded/sliced model, for action buttons. */
let activeModelPath: string | null = null;
/** Latest settings snapshot (model catalog + current selection). */
let settings: SettingsState | null = null;
/** Files staged in the composer tray, awaiting send (stage-on-drop, slice-on-send). */
let stagedFiles: UploadResult[] = [];

// ── Bootstrapping ────────────────────────────────────────────────────────
showEmptyState();
updateSendState();
void refreshStatus();
void checkConfig();
void loadSettings();

api.onAgentEvent(handleAgentEvent);

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("input", updateSendState);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
sendBtn.addEventListener("click", submit);
stopBtn.addEventListener("click", () => api.cancel());
attachBtn.addEventListener("click", pickFiles);

// Model + effort dropdowns: each trigger toggles its own menu (only one open
// at a time); both close on outside-click or Escape.
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
  if (!t) return closeMenus();
  if (modelMenuEl.contains(t) || modelTriggerBtn.contains(t)) return;
  if (effortMenuEl.contains(t) || effortTriggerBtn.contains(t)) return;
  closeMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

// ── Drag-and-drop CAD upload ─────────────────────────────────────────────
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropzoneEl.classList.remove("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzoneEl.classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzoneEl.classList.add("hidden");
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  // Electron exposes the real filesystem path on dropped File objects.
  const paths: string[] = [];
  for (const f of Array.from(files)) {
    const p = (f as File & { path?: string }).path;
    if (p) paths.push(p);
  }
  if (paths.length > 0) void stagePaths(paths);
});

// ── Config & status ───────────────────────────────────────────────────────
async function checkConfig(): Promise<void> {
  let cfg: ConfigState;
  try {
    cfg = await api.getConfigState();
  } catch {
    return;
  }
  const warnings: string[] = [];
  if (!cfg.hasAnthropicKey) {
    warnings.push(
      "ANTHROPIC_API_KEY is missing — add it to your .env to chat with Slicely.",
    );
  }
  if (!cfg.hasThingiverseToken) {
    warnings.push(
      "No Thingiverse token — search still works, but in-app downloads need a free THINGIVERSE_APP_TOKEN.",
    );
  }
  if (warnings.length > 0) {
    bannerEl.textContent = warnings.join("  ·  ");
    bannerEl.classList.remove("hidden");
  } else {
    bannerEl.classList.add("hidden");
  }
}

async function refreshStatus(): Promise<void> {
  try {
    applyStatus(await api.getStatus());
  } catch {
    /* poller will retry */
  }
}

function applyStatus(s: SlicerStatus): void {
  if (!s.installed) {
    statusDot.className = "dot err";
    statusText.textContent = "PrusaSlicer not found";
  } else if (s.running) {
    statusDot.className = "dot ok";
    statusText.textContent = `PrusaSlicer ${s.version ?? ""} · open`.trim();
  } else {
    statusDot.className = "dot warn";
    statusText.textContent = `PrusaSlicer ${s.version ?? "ready"}`.trim();
  }
}

// ── Settings panel (model + effort) ──────────────────────────────────────
async function loadSettings(): Promise<void> {
  try {
    settings = await api.getSettings();
    renderSettings();
  } catch {
    /* settings panel just stays empty */
  }
}

/** Open one menu (closing the other), or close it if it's already open. */
function toggleMenu(which: "model" | "effort"): void {
  const isModel = which === "model";
  const menu = isModel ? modelMenuEl : effortMenuEl;
  const trigger = isModel ? modelTriggerBtn : effortTriggerBtn;
  const willOpen = menu.classList.contains("hidden");
  closeMenus();
  if (willOpen) {
    menu.classList.remove("hidden");
    trigger.classList.add("open");
  }
}

function closeMenus(): void {
  modelMenuEl.classList.add("hidden");
  effortMenuEl.classList.add("hidden");
  modelTriggerBtn.classList.remove("open");
  effortTriggerBtn.classList.remove("open");
}

function renderSettings(): void {
  if (!settings) return;
  const { current, models, efforts } = settings;
  const chosen = models.find((m) => m.id === current.model);

  // Model trigger shows the chosen model's name.
  modelTriggerLabel.textContent = chosen?.label ?? current.model;

  // Effort trigger shows the current tier — hidden for fixed-speed models.
  const supportsEffort = chosen?.supportsEffort ?? false;
  effortTriggerBtn.classList.toggle("hidden", !supportsEffort);
  effortTriggerLabel.textContent = current.effort;

  // Model menu — name + blurb, checkmark on the selected row.
  modelMenuEl.innerHTML = "";
  for (const m of models) {
    const active = m.id === current.model;
    const item = el("div", `menu-item${active ? " active" : ""}`);
    const text = el("div", "mtext");
    const name = el("div", "mname");
    name.textContent = m.label;
    const blurb = el("div", "mblurb");
    blurb.textContent = m.blurb;
    text.appendChild(name);
    text.appendChild(blurb);
    item.appendChild(text);
    const check = el("span", "check");
    check.textContent = "✓";
    item.appendChild(check);
    item.onclick = () => {
      closeMenus();
      void changeSettings({ model: m.id });
    };
    modelMenuEl.appendChild(item);
  }

  // Effort menu — one row per tier; unsupported tiers shown disabled.
  effortMenuEl.innerHTML = "";
  for (const lvl of efforts) {
    const disabled = effortDisabled(lvl, chosen);
    const active = lvl === current.effort && !disabled;
    const item = el(
      "div",
      `menu-item effort${active ? " active" : ""}${disabled ? " disabled" : ""}`,
    );
    const text = el("div", "mtext");
    const name = el("div", "mname");
    name.textContent = lvl;
    text.appendChild(name);
    item.appendChild(text);
    const check = el("span", "check");
    check.textContent = "✓";
    item.appendChild(check);
    item.onclick = () => {
      if (disabled) return;
      closeMenus();
      void changeSettings({ effort: lvl });
    };
    effortMenuEl.appendChild(item);
  }
}

function effortDisabled(
  lvl: EffortLevel,
  m: SettingsState["models"][number] | undefined,
): boolean {
  if (!m) return false;
  if (!m.supportsEffort) return true;
  if (lvl === "xhigh" && !m.supportsXHigh) return true;
  if (lvl === "max" && !m.supportsMax) return true;
  return false;
}

async function changeSettings(
  patch: Partial<{ model: string; effort: EffortLevel }>,
): Promise<void> {
  try {
    settings = await api.updateSettings(patch);
    renderSettings();
  } catch {
    /* ignore */
  }
}

// ── CAD file staging (stage-on-drop, slice-on-send) ──────────────────────
async function pickFiles(): Promise<void> {
  try {
    stageResults(await api.pickFile());
  } catch (err) {
    renderError((err as Error).message ?? "Upload failed.");
  }
}

/** Copy dropped paths into the workspace, then stage them in the tray. */
async function stagePaths(paths: string[]): Promise<void> {
  try {
    const results = await api.uploadFiles(paths);
    if (results.length > 0) stageResults(results);
    else
      renderError(
        "That file type isn't supported. Use STL, 3MF, OBJ, AMF, or STEP.",
      );
  } catch (err) {
    renderError((err as Error).message ?? "Upload failed.");
  }
}

/** Add accepted files to the staging tray (de-duped by workspace path). */
function stageResults(results: UploadResult[]): void {
  if (results.length === 0) return;
  for (const r of results) {
    if (!stagedFiles.some((s) => s.localPath === r.localPath)) {
      stagedFiles.push(r);
    }
  }
  renderAttachTray();
  updateSendState();
  inputEl.focus();
}

function removeStaged(localPath: string): void {
  stagedFiles = stagedFiles.filter((s) => s.localPath !== localPath);
  renderAttachTray();
  updateSendState();
}

/** Render the composer tray of staged files, each with a remove ×. */
function renderAttachTray(): void {
  attachTrayEl.innerHTML = "";
  attachTrayEl.classList.toggle("hidden", stagedFiles.length === 0);
  for (const f of stagedFiles) {
    const chip = el("div", "attach-chip") as HTMLDivElement;

    const badge = el("span", "ac-badge");
    badge.textContent = f.ext.replace(".", "").toUpperCase();
    chip.appendChild(badge);

    const meta = el("div", "ac-meta");
    const name = el("div", "ac-name");
    name.textContent = f.fileName;
    name.title = f.fileName;
    const sub = el("div", "ac-sub");
    sub.textContent = formatBytes(f.sizeBytes);
    if (!f.sliceable) {
      const tag = el("span", "warn");
      tag.textContent = " · needs convert";
      sub.appendChild(tag);
    }
    meta.appendChild(name);
    meta.appendChild(sub);
    chip.appendChild(meta);

    const rm = el("button", "ac-remove") as HTMLButtonElement;
    rm.textContent = "×";
    rm.title = `Remove ${f.fileName}`;
    rm.onclick = () => removeStaged(f.localPath);
    chip.appendChild(rm);

    attachTrayEl.appendChild(chip);
  }
}

/** A committed (sent) attachment, recorded in the transcript. */
function renderUploadChip(r: UploadResult): void {
  const chip = el("div", "tool-chip done enter") as HTMLDivElement;
  prependIcon(chip, "📦");
  const txt = el("span");
  txt.textContent = `Added ${r.fileName} (${formatBytes(r.sizeBytes)})`;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
  scrollToBottom();
}

/** Enable send when there's text or at least one staged file (and not busy). */
function updateSendState(): void {
  sendBtn.disabled =
    busy || (inputEl.value.trim() === "" && stagedFiles.length === 0);
}

// ── Submit / send ──────────────────────────────────────────────────────────
function submit(): void {
  if (busy) return;
  const text = inputEl.value.trim();
  const files = stagedFiles;
  if (!text && files.length === 0) return;
  clearEmptyState();

  if (files.length > 0) {
    submitWithAttachments(text, files);
  } else {
    addUserMessage(text);
  }

  inputEl.value = "";
  autoGrow();
  startTurn();
  void api.sendMessage(buildInstruction(text, files));
}

/** Record the user's message + attachment chips, set the active model, and
 *  clear the tray. The agent instruction is built separately. */
function submitWithAttachments(text: string, files: UploadResult[]): void {
  const active = files.find((f) => f.sliceable) ?? files[0];
  activeModelPath = active.localPath;

  addUserMessage(
    text ||
      (files.length === 1
        ? `Attached ${active.fileName}`
        : `Attached ${files.length} files`),
  );
  for (const f of files) renderUploadChip(f);

  stagedFiles = [];
  renderAttachTray();
}

/** Compose the message sent to the agent from the user's text + staged files. */
function buildInstruction(text: string, files: UploadResult[]): string {
  if (files.length === 0) return text;

  const active = files.find((f) => f.sliceable) ?? files[0];
  const names = files.map((f) => `"${f.fileName}"`).join(", ");
  const context =
    files.length === 1
      ? `The user attached a 3D model file, ${names}, now the active model. `
      : `The user attached ${files.length} files (${names}). The active model is "${active.fileName}". `;

  if (text) return `${context}\n\nThe user says: ${text}`;
  return active.sliceable
    ? `${context}Inspect it, report its dimensions, recommend optimal slicing settings, and offer to slice it.`
    : `${context}This is a ${active.ext} CAD file — STEP files must be opened in PrusaSlicer to convert. Offer to open it in the slicer, and inspect it if possible.`;
}

/** Send a synthesized instruction (from a card button) as if the user asked. */
function sendInstruction(displayText: string, instruction: string): void {
  if (busy) return;
  clearEmptyState();
  addUserMessage(displayText);
  startTurn();
  void api.sendMessage(instruction);
}

function startTurn(): void {
  setBusy(true);
  endBotBubble();
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.classList.toggle("hidden", b);
  stopBtn.classList.toggle("hidden", !b);
  updateSendState();
}

// ── Event handling ──────────────────────────────────────────────────────────
function handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text":
      appendBotText(event.text);
      break;
    case "thinking":
      appendThinking(event.text);
      break;
    case "tool_start":
      startToolChip(event.tool, event.label);
      break;
    case "tool_end":
      endToolChip(event.tool, event.ok, event.summary);
      break;
    case "models":
      renderCards(event.models);
      break;
    case "download":
      activeModelPath = event.result.localPath;
      renderDownloadNote(event.model, event.result.fileName);
      break;
    case "info":
      renderInfo(event.info);
      break;
    case "metrics":
      renderMetrics(event.metrics);
      break;
    case "status":
      applyStatus(event.status);
      break;
    case "error":
      renderError(event.message);
      break;
    case "done":
      endBotBubble();
      setBusy(false);
      break;
  }
  scrollToBottom();
}

// ── Rendering helpers ────────────────────────────────────────────────────────
function addUserMessage(text: string): void {
  const wrap = el("div", "msg user enter");
  const bubble = el("div", "bubble");
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
}

function appendBotText(delta: string): void {
  // A new answer ends any reasoning block for this turn.
  finishThinking();
  if (!activeBotBubble) {
    const wrap = el("div", "msg bot enter");
    activeBotBubble = el("div", "bubble streaming md") as HTMLDivElement;
    wrap.appendChild(activeBotBubble);
    messagesEl.appendChild(wrap);
    activeBotRaw = "";
  }
  activeBotRaw += delta;
  scheduleMarkdownRender();
}

/** Throttle markdown re-parse to ~1 per animation frame regardless of token
 *  rate (re-parsing the whole accumulated string each delta is wasteful). */
function scheduleMarkdownRender(): void {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    if (activeBotBubble) renderMarkdownInto(activeBotBubble, activeBotRaw);
    if (activeThinkingBody) renderMarkdownInto(activeThinkingBody, activeThinkingRaw);
    scrollToBottom();
  });
}

function renderMarkdownInto(target: HTMLElement, raw: string): void {
  target.replaceChildren(renderMarkdown(raw));
}

/** Reasoning deltas → a collapsed <details> block above the answer. */
function appendThinking(delta: string): void {
  if (!activeThinkingBody) {
    const details = el("details", "thinking enter") as HTMLDetailsElement;
    const summary = el("summary");
    summary.textContent = "Thinking…";
    activeThinkingBody = el("div", "think-body md");
    details.appendChild(summary);
    details.appendChild(activeThinkingBody);
    messagesEl.appendChild(details);
    activeThinkingRaw = "";
  }
  activeThinkingRaw += delta;
  scheduleMarkdownRender();
}

/** Finalize the reasoning block (relabel summary, stop accumulating). */
function finishThinking(): void {
  if (activeThinkingBody) {
    const details = activeThinkingBody.closest("details");
    const summary = details?.querySelector("summary");
    if (summary) summary.textContent = "Thought process";
    renderMarkdownInto(activeThinkingBody, activeThinkingRaw);
    activeThinkingBody = null;
    activeThinkingRaw = "";
  }
}

/** Stop the blinking caret and flush the final markdown for the active bubble. */
function finishStreaming(): void {
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (activeBotBubble) renderMarkdownInto(activeBotBubble, activeBotRaw);
  activeBotBubble?.classList.remove("streaming");
}

/** End the current bot bubble + reasoning block (used between segments). */
function endBotBubble(): void {
  finishThinking();
  finishStreaming();
  activeBotBubble = null;
  activeBotRaw = "";
}

function startToolChip(tool: string, label: string): void {
  // A new tool call ends the current text bubble so following text starts fresh.
  endBotBubble();
  const chip = el("div", "tool-chip enter") as HTMLDivElement;
  chip.appendChild(el("span", "spin"));
  const txt = el("span");
  txt.textContent = label;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
  // If the same tool fires twice, keep only the latest reference.
  activeChips.set(tool, chip);
}

function endToolChip(tool: string, ok: boolean, summary?: string): void {
  const chip = activeChips.get(tool);
  if (!chip) return;
  chip.classList.add("done");
  chip.querySelector(".spin")?.remove();
  if (!ok) {
    chip.classList.add("err");
    const txt = chip.querySelector("span:last-child");
    if (txt) txt.textContent = summary ? `Failed: ${summary}` : "Failed";
    prependIcon(chip, "✕");
  } else {
    prependIcon(chip, "✓");
  }
  activeChips.delete(tool);
}

function prependIcon(chip: HTMLDivElement, glyph: string): void {
  const ico = el("span", "ico");
  ico.textContent = glyph;
  chip.insertBefore(ico, chip.firstChild);
}

function renderCards(models: ModelResult[]): void {
  endBotBubble();
  if (models.length === 0) return;
  const wrap = el("div", "cards");
  for (const m of models) wrap.appendChild(buildCard(m));
  messagesEl.appendChild(wrap);
}

function buildCard(m: ModelResult): HTMLDivElement {
  const card = el("div", "card") as HTMLDivElement;

  if (m.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = m.thumbnail;
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.onerror = () => img.replaceWith(placeholderThumb());
    card.appendChild(img);
  } else {
    card.appendChild(placeholderThumb());
  }

  const meta = el("div", "meta");
  const title = el("div", "title");
  title.textContent = m.title;
  meta.appendChild(title);

  const sub = el("div", "sub");
  const src = el("span", "src");
  src.textContent = m.source;
  sub.appendChild(src);
  const by = el("span");
  by.textContent = m.creator ? `by ${m.creator}` : "open-source";
  sub.appendChild(by);
  meta.appendChild(sub);

  if (m.license) {
    const lic = el("div", "lic");
    lic.textContent = m.license;
    lic.title = m.license;
    meta.appendChild(lic);
  }

  const actions = el("div", "actions");
  if (m.downloadable) {
    const importBtn = el("button", "btn primary") as HTMLButtonElement;
    importBtn.textContent = "Import & analyze";
    importBtn.onclick = () =>
      sendInstruction(
        `Import "${m.title}"`,
        `Import the ${m.source} model id ${m.id} ("${m.title}"), then report its dimensions and recommend optimal slicing settings.`,
      );
    actions.appendChild(importBtn);
  }

  const openBtn = el("button", "btn") as HTMLButtonElement;
  openBtn.textContent = m.downloadable ? "View page" : "Open in browser";
  openBtn.onclick = () => void api.openExternal(m.webUrl);
  actions.appendChild(openBtn);

  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

function placeholderThumb(): HTMLDivElement {
  const ph = el("div", "thumb placeholder") as HTMLDivElement;
  ph.textContent = "◆";
  return ph;
}

function renderDownloadNote(model: ModelResult, fileName: string): void {
  endBotBubble();
  const chip = el("div", "tool-chip done enter") as HTMLDivElement;
  prependIcon(chip, "⬇");
  const txt = el("span");
  txt.textContent = `Downloaded ${fileName} from ${model.source}`;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
}

function renderInfo(info: ModelInfo): void {
  endBotBubble();
  if (info.filePath) activeModelPath = info.filePath;

  const panel = el("div", "panel");
  panel.appendChild(panelHead("◳", "Model"));
  const grid = el("div", "metrics");
  addMetric(grid, "Width", `${info.sizeX.toFixed(1)} mm`);
  addMetric(grid, "Depth", `${info.sizeY.toFixed(1)} mm`);
  addMetric(grid, "Height", `${info.sizeZ.toFixed(1)} mm`);
  if (info.volumeMm3 !== undefined) {
    addMetric(grid, "Volume", `${(info.volumeMm3 / 1000).toFixed(1)} cm³`);
  }
  if (info.facets !== undefined) {
    addMetric(grid, "Triangles", info.facets.toLocaleString());
  }
  if (info.manifold !== undefined) {
    addMetric(grid, "Watertight", info.manifold ? "yes" : "no");
  }
  panel.appendChild(grid);
  messagesEl.appendChild(panel);
}

function renderMetrics(m: SliceMetrics): void {
  endBotBubble();
  const panel = el("div", "panel");
  const title =
    m.plateCount && m.plateCount > 1
      ? `Plate ${m.plateIndex} of ${m.plateCount}`
      : "Slice result";
  panel.appendChild(panelHead("✦", title));

  const grid = el("div", "metrics");
  if (m.partsOnPlate && m.partsOnPlate > 1) {
    addMetric(grid, "On plate", `${m.partsOnPlate} parts`);
  }
  if (m.estimatedPrintTime) {
    addMetric(grid, "Print time", m.estimatedPrintTime, true, true);
  }
  if (m.filamentUsedG !== undefined) {
    addMetric(grid, "Filament", `${m.filamentUsedG.toFixed(1)} g`, false, true);
  }
  if (m.filamentUsedMm !== undefined) {
    addMetric(grid, "Length", `${(m.filamentUsedMm / 1000).toFixed(2)} m`);
  }
  if (m.layerCount !== undefined) {
    addMetric(grid, "Layers", String(m.layerCount));
  }
  if (m.filamentCost !== undefined) {
    addMetric(grid, "Est. cost", m.filamentCost.toFixed(2));
  }
  panel.appendChild(grid);

  // Action row: open the sliced result / reveal the G-code file.
  const actions = el("div", "actions");
  const openBtn = el("button", "btn primary") as HTMLButtonElement;
  openBtn.textContent = "Open in PrusaSlicer";
  openBtn.onclick = () => {
    const p = activeModelPath ?? m.gcodePath;
    void api.openSlicer(p);
  };
  actions.appendChild(openBtn);

  const revealBtn = el("button", "btn") as HTMLButtonElement;
  revealBtn.textContent = "Reveal G-code";
  revealBtn.onclick = () => void api.revealPath(m.gcodePath);
  actions.appendChild(revealBtn);

  panel.appendChild(actions);
  messagesEl.appendChild(panel);
}

function panelHead(icon: string, label: string): HTMLDivElement {
  const head = el("div", "panel-head") as HTMLDivElement;
  const pico = el("span", "pico");
  pico.textContent = icon;
  head.appendChild(pico);
  const t = el("span");
  t.textContent = label;
  head.appendChild(t);
  return head;
}

function addMetric(
  grid: HTMLElement,
  k: string,
  v: string,
  full = false,
  accent = false,
): void {
  const row = el("div", `row${full ? " full" : ""}`);
  const ke = el("div", "k");
  ke.textContent = k;
  const ve = el("div", `v${accent ? " accent" : ""}`);
  ve.textContent = v;
  row.appendChild(ke);
  row.appendChild(ve);
  grid.appendChild(row);
}

function renderError(message: string): void {
  endBotBubble();
  const chip = el("div", "tool-chip err done enter") as HTMLDivElement;
  prependIcon(chip, "⚠");
  const txt = el("span");
  txt.textContent = message;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
}

// ── Empty state ──────────────────────────────────────────────────────────────
function showEmptyState(): void {
  const empty = el("div", "empty");
  empty.id = "emptyState";
  empty.innerHTML =
    '<span class="big">◆</span>Hi, I\'m <b>Slicely</b>.<br/>Tell me what you want to 3D print — I\'ll find free models and slice them in PrusaSlicer.';
  const examples = el("div", "examples");
  for (const ex of [
    "I want to 3D print a model car",
    "Find me an articulated dragon",
    "A phone stand I can print tonight",
  ]) {
    const b = el("div", "ex");
    b.textContent = ex;
    b.onclick = () => {
      inputEl.value = ex;
      autoGrow();
      submit();
    };
    examples.appendChild(b);
  }
  empty.appendChild(examples);
  messagesEl.appendChild(empty);
}

function clearEmptyState(): void {
  document.getElementById("emptyState")?.remove();
}

// ── Utilities ────────────────────────────────────────────────────────────────
function el(tag: string, className = ""): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function autoGrow(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

function scrollToBottom(): void {
  // rAF so layout settles (animations/images) before we measure scrollHeight.
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
