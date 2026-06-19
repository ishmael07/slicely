// Slicely renderer. Talks to the main process exclusively through the typed
// `window.slicely` bridge exposed by preload.ts. Renders the chat transcript,
// model cards, and slice-metric panels from streamed agent events.
import type {
  AgentEvent,
  ModelResult,
  ModelInfo,
  SliceMetrics,
  SlicerStatus,
  ConfigState,
  SlicelyApi,
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

let busy = false;
/** The bot bubble currently being streamed into (text deltas append here). */
let activeBotBubble: HTMLDivElement | null = null;
/** Active tool chips by tool name, so tool_end can finalize the right one. */
const activeChips = new Map<string, HTMLDivElement>();

// ── Bootstrapping ────────────────────────────────────────────────────────
showEmptyState();
void refreshStatus();
void checkConfig();

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
      "No THINGIVERSE_APP_TOKEN — search still works via Printables/MakerWorld, but in-app downloads need a (free) Thingiverse token.",
    );
  }
  if (warnings.length > 0) {
    bannerEl.textContent = warnings.join(" ");
    bannerEl.classList.remove("hidden");
  }
}

async function refreshStatus(): Promise<void> {
  let s: SlicerStatus;
  try {
    s = await api.getStatus();
  } catch {
    return;
  }
  if (!s.installed) {
    statusDot.className = "dot err";
    statusText.textContent = "PrusaSlicer not found";
  } else if (s.running) {
    statusDot.className = "dot ok";
    statusText.textContent = `PrusaSlicer ${s.version ?? ""} · running`;
  } else {
    statusDot.className = "dot warn";
    statusText.textContent = `PrusaSlicer ${s.version ?? "ready"}`;
  }
}

// ── Submit / send ──────────────────────────────────────────────────────────
function submit(): void {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  clearEmptyState();
  addUserMessage(text);
  inputEl.value = "";
  autoGrow();
  setBusy(true);
  activeBotBubble = null;
  void api.sendMessage(text);
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.classList.toggle("hidden", b);
  stopBtn.classList.toggle("hidden", !b);
  inputEl.disabled = false; // allow typing the next message while streaming
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
      renderDownloadNote(event.model, event.result.fileName);
      break;
    case "info":
      renderInfo(event.info);
      break;
    case "metrics":
      renderMetrics(event.metrics);
      break;
    case "status":
      void refreshStatus();
      break;
    case "error":
      renderError(event.message);
      break;
    case "done":
      setBusy(false);
      activeBotBubble = null;
      void refreshStatus();
      break;
  }
  scrollToBottom();
}

// ── Rendering helpers ────────────────────────────────────────────────────────
function addUserMessage(text: string): void {
  const wrap = el("div", "msg user");
  const bubble = el("div", "bubble");
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
}

function appendBotText(delta: string): void {
  if (!activeBotBubble) {
    const wrap = el("div", "msg bot");
    activeBotBubble = el("div", "bubble") as HTMLDivElement;
    wrap.appendChild(activeBotBubble);
    messagesEl.appendChild(wrap);
  }
  activeBotBubble.textContent = (activeBotBubble.textContent ?? "") + delta;
}

function startToolChip(tool: string, label: string): void {
  // A new tool call ends the current text bubble so following text starts fresh.
  activeBotBubble = null;
  const chip = el("div", "tool-chip") as HTMLDivElement;
  chip.appendChild(el("span", "spin"));
  const txt = el("span");
  txt.textContent = label;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
  activeChips.set(tool, chip);
}

function endToolChip(tool: string, ok: boolean, summary?: string): void {
  const chip = activeChips.get(tool);
  if (!chip) return;
  chip.classList.add("done");
  if (!ok) {
    chip.classList.add("err");
    const txt = chip.querySelector("span:last-child");
    if (txt) txt.textContent = summary ? `Failed: ${summary}` : "Failed";
  } else {
    chip.querySelector(".spin")?.remove();
    const check = el("span");
    check.textContent = "✓";
    chip.insertBefore(check, chip.firstChild);
  }
  activeChips.delete(tool);
}

function renderCards(models: ModelResult[]): void {
  activeBotBubble = null;
  if (models.length === 0) return;
  const wrap = el("div", "cards");
  for (const m of models) {
    wrap.appendChild(buildCard(m));
  }
  messagesEl.appendChild(wrap);
}

function buildCard(m: ModelResult): HTMLDivElement {
  const card = el("div", "card") as HTMLDivElement;

  if (m.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = m.thumbnail;
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      img.replaceWith(placeholderThumb());
    };
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
  sub.appendChild(
    document.createTextNode(
      m.creator ? `by ${m.creator}` : "open-source model",
    ),
  );
  meta.appendChild(sub);

  if (m.license) {
    const lic = el("div", "sub");
    lic.textContent = m.license;
    meta.appendChild(lic);
  }

  const actions = el("div", "actions");
  if (m.downloadable) {
    const importBtn = el("button", "primary") as HTMLButtonElement;
    importBtn.textContent = "Import";
    importBtn.onclick = () => {
      // Ask the agent to import — keeps the conversation coherent and reuses
      // the same import → inspect → slice flow.
      if (busy) return;
      clearEmptyState();
      addUserMessage(`Import "${m.title}"`);
      setBusy(true);
      activeBotBubble = null;
      void api.sendMessage(
        `Import the ${m.source} model id ${m.id} ("${m.title}"), then tell me its dimensions and recommend slicing settings.`,
      );
    };
    actions.appendChild(importBtn);
  }

  const openBtn = el("button") as HTMLButtonElement;
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
  activeBotBubble = null;
  const chip = el("div", "tool-chip done") as HTMLDivElement;
  const check = el("span");
  check.textContent = "⬇";
  chip.appendChild(check);
  const txt = el("span");
  txt.textContent = `Downloaded ${fileName} from ${model.source}`;
  chip.appendChild(txt);
  messagesEl.appendChild(chip);
}

function renderInfo(info: ModelInfo): void {
  activeBotBubble = null;
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
  messagesEl.appendChild(grid);
}

function renderMetrics(m: SliceMetrics): void {
  activeBotBubble = null;
  const grid = el("div", "metrics");
  if (m.estimatedPrintTime) {
    addMetric(grid, "Print time", m.estimatedPrintTime, true, true);
  }
  if (m.filamentUsedG !== undefined) {
    addMetric(grid, "Filament", `${m.filamentUsedG.toFixed(1)} g`, true);
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
  messagesEl.appendChild(grid);
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
  activeBotBubble = null;
  const chip = el("div", "tool-chip err done") as HTMLDivElement;
  const x = el("span");
  x.textContent = "⚠";
  chip.appendChild(x);
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
    '<span class="big">◆</span>Hi, I\'m <b>Slicely</b>.<br/>Tell me what you want to 3D print and I\'ll find free models and slice them in PrusaSlicer.';
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
