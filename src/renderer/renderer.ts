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
const settingsBtn = $<HTMLButtonElement>("settingsBtn");
const settingsEl = $<HTMLElement>("settings");
const modelListEl = $<HTMLDivElement>("modelList");
const effortSegEl = $<HTMLDivElement>("effortSeg");
const effortHintEl = $<HTMLParagraphElement>("effortHint");
const attachBtn = $<HTMLButtonElement>("attach");
const dropzoneEl = $<HTMLDivElement>("dropzone");

let busy = false;
/** The bot bubble currently being streamed into (text deltas append here). */
let activeBotBubble: HTMLDivElement | null = null;
/** Active tool chips by tool name, so tool_end can finalize the right one. */
const activeChips = new Map<string, HTMLDivElement>();
/** Path of the most-recently downloaded/sliced model, for action buttons. */
let activeModelPath: string | null = null;
/** Latest settings snapshot (model catalog + current selection). */
let settings: SettingsState | null = null;

// ── Bootstrapping ────────────────────────────────────────────────────────
showEmptyState();
void refreshStatus();
void checkConfig();
void loadSettings();

api.onAgentEvent(handleAgentEvent);

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
sendBtn.addEventListener("click", submit);
stopBtn.addEventListener("click", () => api.cancel());
settingsBtn.addEventListener("click", toggleSettings);
attachBtn.addEventListener("click", pickFiles);

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
  if (paths.length > 0) void uploadPaths(paths);
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

function toggleSettings(): void {
  const open = settingsEl.classList.toggle("hidden") === false;
  settingsBtn.classList.toggle("open", open);
  scheduleResize();
}

function renderSettings(): void {
  if (!settings) return;
  const { current, models, efforts } = settings;

  // Model radio list.
  modelListEl.innerHTML = "";
  for (const m of models) {
    const opt = el("div", `model-opt${m.id === current.model ? " active" : ""}`);
    opt.appendChild(el("div", "radio"));
    const text = el("div", "mtext");
    const name = el("div", "mname");
    name.textContent = m.label;
    const blurb = el("div", "mblurb");
    blurb.textContent = m.blurb;
    text.appendChild(name);
    text.appendChild(blurb);
    opt.appendChild(text);
    opt.onclick = () => void changeSettings({ model: m.id });
    modelListEl.appendChild(opt);
  }

  // Effort segmented control — tiers the chosen model can't use are disabled.
  const chosen = models.find((m) => m.id === current.model);
  effortSegEl.innerHTML = "";
  for (const lvl of efforts) {
    const b = el("button") as HTMLButtonElement;
    b.textContent = lvl;
    const disabled = effortDisabled(lvl, chosen);
    b.disabled = disabled;
    if (lvl === current.effort && !disabled) b.classList.add("active");
    b.onclick = () => {
      if (!b.disabled) void changeSettings({ effort: lvl });
    };
    effortSegEl.appendChild(b);
  }

  effortHintEl.textContent = chosen
    ? chosen.supportsEffort
      ? "Higher effort = better tool decisions, more tokens, slower."
      : `${chosen.label} runs at a fixed speed — effort tiers don't apply.`
    : "";
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

// ── CAD file upload ──────────────────────────────────────────────────────
async function pickFiles(): Promise<void> {
  try {
    const results = await api.pickFile();
    if (results.length > 0) onUploaded(results);
  } catch (err) {
    renderError((err as Error).message ?? "Upload failed.");
  }
}

async function uploadPaths(paths: string[]): Promise<void> {
  try {
    const results = await api.uploadFiles(paths);
    if (results.length > 0) onUploaded(results);
    else
      renderError(
        "That file type isn't supported. Use STL, 3MF, OBJ, AMF, or STEP.",
      );
  } catch (err) {
    renderError((err as Error).message ?? "Upload failed.");
  }
}

/** A file landed in the workspace: show it, set it active, and kick the agent. */
function onUploaded(results: UploadResult[]): void {
  clearEmptyState();
  const active = results.find((r) => r.sliceable) ?? results[0];
  activeModelPath = active.localPath;

  for (const r of results) renderUploadChip(r);

  // Tell the agent — it'll inspect/recommend/slice the active (now-default) file.
  const label =
    results.length === 1
      ? `Uploaded ${active.fileName}`
      : `Uploaded ${results.length} files`;
  addUserMessage(label);
  startTurn();
  const instruction = active.sliceable
    ? `I just uploaded a 3D model file named "${active.fileName}" — it's now the active model. Inspect it, report its dimensions, recommend optimal slicing settings, and offer to slice it.`
    : `I just uploaded "${active.fileName}" (a ${active.ext} CAD file). It's the active model. Note that STEP files should be opened in PrusaSlicer to convert them — offer to open it in the slicer, and inspect it if possible.`;
  void api.sendMessage(instruction);
}

function renderUploadChip(r: UploadResult): void {
  const chip = el("div", "tool-chip done enter") as HTMLDivElement;
  prependIcon(chip, "📦");
  const txt = el("span");
  txt.textContent = `Added ${r.fileName} (${formatBytes(r.sizeBytes)})`;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
  scrollToBottom();
}

// ── Submit / send ──────────────────────────────────────────────────────────
function submit(): void {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  clearEmptyState();
  addUserMessage(text);
  inputEl.value = "";
  autoGrow();
  startTurn();
  void api.sendMessage(text);
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
  activeBotBubble = null;
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.classList.toggle("hidden", b);
  stopBtn.classList.toggle("hidden", !b);
}

// ── Event handling ──────────────────────────────────────────────────────────
function handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text":
      appendBotText(event.text);
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
      finishStreaming();
      setBusy(false);
      activeBotBubble = null;
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
  if (!activeBotBubble) {
    const wrap = el("div", "msg bot enter");
    activeBotBubble = el("div", "bubble streaming") as HTMLDivElement;
    wrap.appendChild(activeBotBubble);
    messagesEl.appendChild(wrap);
  }
  activeBotBubble.textContent = (activeBotBubble.textContent ?? "") + delta;
}

/** Stop the blinking caret on whatever bubble was last streamed. */
function finishStreaming(): void {
  activeBotBubble?.classList.remove("streaming");
}

function startToolChip(tool: string, label: string): void {
  // A new tool call ends the current text bubble so following text starts fresh.
  finishStreaming();
  activeBotBubble = null;
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
  finishStreaming();
  activeBotBubble = null;
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
  finishStreaming();
  activeBotBubble = null;
  const chip = el("div", "tool-chip done enter") as HTMLDivElement;
  prependIcon(chip, "⬇");
  const txt = el("span");
  txt.textContent = `Downloaded ${fileName} from ${model.source}`;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
}

function renderInfo(info: ModelInfo): void {
  finishStreaming();
  activeBotBubble = null;
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
  finishStreaming();
  activeBotBubble = null;
  const panel = el("div", "panel");
  panel.appendChild(panelHead("✦", "Slice result"));

  const grid = el("div", "metrics");
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
  finishStreaming();
  activeBotBubble = null;
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

function scheduleResize(): void {
  // Ask the main process to grow the window when the settings panel opens, so
  // it doesn't steal space from the transcript. rAF lets layout settle first.
  requestAnimationFrame(() => {
    const total = document.getElementById("app")?.scrollHeight ?? 0;
    if (total > 0) api.resizeWindow(total);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
