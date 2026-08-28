// ─────────────────────────────────────────────────────────────────────────────
// Slicely — zero-install web client. Runs entirely in the browser: no build
// step beyond `tsc -p tsconfig.renderer.json`, no framework, no bundler.
//
// Every import here is `import type` — it names shared TYPES only, and is
// erased at compile time (see tsconfig.renderer.json's header comment). The
// emitted app.js has zero runtime imports, so it's a single self-contained
// file the server can hand the browser with nothing else to resolve.
//
// The chat transcript mirrors src/renderer/renderer.ts's event handling
// (same AgentEvent stream, same visual language) but arrives over
// Server-Sent Events read from a POST `fetch()` body instead of Electron IPC
// — the browser has no IPC, and a plain `EventSource` can't send a POST body,
// so streamSse() below reads the SSE wire format by hand off the response
// stream.
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentEvent, ModelInfo, SliceMetrics, SlicerStatus, UploadResult } from "../shared/types";
import type { PrinterConnection, PrinterStatus } from "../shared/printers";
import type { SearchOutcome, UrlResolution } from "../shared/sourcing";
import type { JobEvent, PrintJob, JobPlate } from "../shared/jobs";

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}

function make(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function makeText(tag: string, className: string, content: string): HTMLElement {
  const e = make(tag, className);
  e.textContent = content;
  return e;
}

// ── element refs ─────────────────────────────────────────────────────────────

const messagesEl = byId<HTMLElement>("messages");
const inputEl = byId<HTMLTextAreaElement>("input");
const sendBtn = byId<HTMLButtonElement>("send");
const stopBtn = byId<HTMLButtonElement>("stop");
const attachBtn = byId<HTMLButtonElement>("attachBtn");
const fileInput = byId<HTMLInputElement>("fileInput");
const attachTray = byId<HTMLElement>("attachTray");
const linkBtn = byId<HTMLButtonElement>("linkBtn");
const linkRow = byId<HTMLElement>("linkRow");
const linkInput = byId<HTMLInputElement>("linkInput");
const linkGo = byId<HTMLButtonElement>("linkGo");
const dropzone = byId<HTMLElement>("dropzone");
const bannerEl = byId<HTMLElement>("banner");
const settingsBtn = byId<HTMLButtonElement>("settingsBtn");
const settingsSheet = byId<HTMLElement>("settingsSheet");
const statusDot = byId<HTMLElement>("statusDot");
const statusText = byId<HTMLElement>("statusText");
const printerPill = byId<HTMLButtonElement>("printerPill");
const printerDot = byId<HTMLElement>("printerDot");
const printerLabel = byId<HTMLElement>("printerLabel");
const goalSelect = byId<HTMLSelectElement>("goalSelect");
const materialSelect = byId<HTMLSelectElement>("materialSelect");
const printerListEl = byId<HTMLElement>("printerList");
const addPrinterBtn = byId<HTMLButtonElement>("addPrinterBtn");
const addPrinterForm = byId<HTMLElement>("addPrinterForm");
const discoverBtn = byId<HTMLButtonElement>("discoverBtn");
const pTransport = byId<HTMLSelectElement>("pTransport");
const pLabel = byId<HTMLInputElement>("pLabel");
const pHost = byId<HTMLInputElement>("pHost");
const pHostRow = byId<HTMLElement>("pHostRow");
const pSecretsFields = byId<HTMLElement>("pSecretsFields");
const pSave = byId<HTMLButtonElement>("pSave");
const multiUserNote = byId<HTMLElement>("multiUserNote");

// ── tiny fetch helpers ───────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error ?? `${url} failed (${resp.status})`);
  return data;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error ?? `${url} failed (${resp.status})`);
  return data;
}

/** Read a `data: {...}\n\n` SSE stream off a POST response body — the
 *  browser's native EventSource can only issue GET requests, so a streamed
 *  chat/job reply is parsed by hand off `fetch()`'s ReadableStream. */
async function streamSse(url: string, body: unknown, onEvent: (data: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const data = await resp.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error((data.error as string) ?? `Request failed (${resp.status})`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw) continue;
      try {
        onEvent(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* a malformed frame is dropped rather than killing the stream */
      }
    }
  }
}

// ── a tiny, dependency-free markdown-lite → DOM renderer ───────────────────
// Deliberately NOT innerHTML anywhere: model text is untrusted, so every run
// of text becomes a real DOM text node and the only elements that exist are
// ones this function creates itself.

function renderMarkdownLite(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const inline = (container: HTMLElement, s: string) => {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > last) container.appendChild(document.createTextNode(s.slice(last, m.index)));
      const token = m[0];
      if (token.startsWith("**")) container.appendChild(makeText("strong", "", token.slice(2, -2)));
      else if (token.startsWith("`")) container.appendChild(makeText("code", "", token.slice(1, -1)));
      else container.appendChild(makeText("em", "", token.slice(1, -1)));
      last = re.lastIndex;
    }
    if (last < s.length) container.appendChild(document.createTextNode(s.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const pre = make("pre");
      pre.appendChild(makeText("code", "", body.join("\n")));
      frag.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const tag = `h${2 + heading[1].length}`;
      const h = make(tag);
      inline(h, heading[2]);
      frag.appendChild(h);
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = make(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const item = make("li");
        inline(item, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        list.appendChild(item);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    const p = make("p");
    inline(p, para.join(" "));
    frag.appendChild(p);
  }

  return frag;
}

// ── chat transcript state ───────────────────────────────────────────────────

let busy = false;
let currentAbort: AbortController | undefined;
let activeBotBubble: HTMLElement | null = null;
let activeBotRaw = "";
let activeThinkingBody: HTMLElement | null = null;
let activeThinkingRaw = "";
let renderFrame = 0;
const activeChips = new Map<string, HTMLElement>();

function clearEmptyState(): void {
  messagesEl.querySelector(".empty")?.remove();
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text: string): void {
  clearEmptyState();
  const wrap = make("div", "msg user enter");
  wrap.appendChild(makeText("div", "bubble", text));
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function appendBotText(delta: string): void {
  finishThinking();
  if (!activeBotBubble) {
    const wrap = make("div", "msg bot enter");
    activeBotBubble = make("div", "bubble streaming md");
    wrap.appendChild(activeBotBubble);
    messagesEl.appendChild(wrap);
    activeBotRaw = "";
  }
  activeBotRaw += delta;
  scheduleRender();
}

function scheduleRender(): void {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    if (activeBotBubble) activeBotBubble.replaceChildren(renderMarkdownLite(activeBotRaw));
    if (activeThinkingBody) activeThinkingBody.replaceChildren(renderMarkdownLite(activeThinkingRaw));
    scrollToBottom();
  });
}

function appendThinking(delta: string): void {
  if (!activeThinkingBody) {
    const details = make("details", "thinking enter") as HTMLDetailsElement;
    const summary = makeText("summary", "", "Thinking…");
    activeThinkingBody = make("div", "think-body md");
    details.appendChild(summary);
    details.appendChild(activeThinkingBody);
    messagesEl.appendChild(details);
    activeThinkingRaw = "";
  }
  activeThinkingRaw += delta;
  scheduleRender();
}

function finishThinking(): void {
  if (activeThinkingBody) {
    const details = activeThinkingBody.closest("details");
    const summary = details?.querySelector("summary");
    if (summary) summary.textContent = "Thought process";
    activeThinkingBody.replaceChildren(renderMarkdownLite(activeThinkingRaw));
    activeThinkingBody = null;
    activeThinkingRaw = "";
  }
}

function finishStreaming(): void {
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (activeBotBubble) activeBotBubble.replaceChildren(renderMarkdownLite(activeBotRaw));
  activeBotBubble?.classList.remove("streaming");
}

function endBotBubble(): void {
  finishThinking();
  finishStreaming();
  activeBotBubble = null;
  activeBotRaw = "";
}

function startToolChip(tool: string, label: string): void {
  endBotBubble();
  const chip = make("div", "tool-chip enter");
  chip.appendChild(make("span", "spin"));
  chip.appendChild(makeText("span", "", label));
  messagesEl.appendChild(chip);
  activeChips.set(tool, chip);
  scrollToBottom();
}

function endToolChip(tool: string, ok: boolean, summary?: string): void {
  const chip = activeChips.get(tool);
  if (!chip) return;
  chip.classList.add("done");
  chip.querySelector(".spin")?.remove();
  const icon = make("span", "ico");
  if (!ok) {
    chip.classList.add("err");
    icon.textContent = "✕";
    const label = chip.querySelector("span:last-child");
    if (label) label.textContent = summary ? `Failed: ${summary}` : "Failed";
  } else {
    icon.textContent = "✓";
  }
  chip.insertBefore(icon, chip.firstChild);
  activeChips.delete(tool);
}

function panelHead(glyph: string, label: string): HTMLElement {
  const head = make("div", "panel-head");
  head.appendChild(makeText("span", "", glyph));
  head.appendChild(makeText("span", "", label));
  return head;
}

function addMetric(grid: HTMLElement, k: string, v: string, accent = false): void {
  const m = make("div", "metric");
  m.appendChild(makeText("span", "k", k));
  m.appendChild(makeText("span", accent ? "v accent" : "v", v));
  grid.appendChild(m);
}

// ── model result cards (v1 ModelResult and v2 SourcedModel share enough
//    shape to render with one function) ──────────────────────────────────
interface CardLike {
  id: string;
  source: string;
  title: string;
  creator?: string;
  thumbnail?: string;
  webUrl: string;
  license?: string;
  downloadable: boolean;
}

function renderCards(models: CardLike[]): void {
  endBotBubble();
  if (models.length === 0) return;
  const wrap = make("div", "cards");
  for (const m of models) wrap.appendChild(buildCard(m));
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function buildCard(m: CardLike): HTMLElement {
  const card = make("div", "card");
  if (m.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = m.thumbnail;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(placeholderThumb());
    card.appendChild(img);
  } else {
    card.appendChild(placeholderThumb());
  }

  const meta = make("div", "meta");
  meta.appendChild(makeText("div", "title", m.title));
  const sub = make("div", "sub");
  sub.appendChild(makeText("span", "", m.source));
  sub.appendChild(makeText("span", "", m.creator ? `by ${m.creator}` : "open-source"));
  meta.appendChild(sub);
  if (m.license) {
    const lic = makeText("div", "lic", m.license);
    lic.title = m.license;
    meta.appendChild(lic);
  }

  const actions = make("div", "actions");
  if (m.downloadable) {
    const importBtn = makeText("button", "btn primary small", "Import") as HTMLButtonElement;
    importBtn.onclick = () =>
      void sendInstruction(
        `Import "${m.title}"`,
        `Import the ${m.source} model id ${m.id} ("${m.title}"), then report its dimensions and recommend optimal slicing settings.`,
      );
    actions.appendChild(importBtn);
  }
  const openBtn = makeText("button", "btn small", m.downloadable ? "View" : "Open in browser") as HTMLButtonElement;
  openBtn.onclick = () => window.open(m.webUrl, "_blank", "noopener,noreferrer");
  actions.appendChild(openBtn);
  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

function placeholderThumb(): HTMLElement {
  return makeText("div", "thumb placeholder", "◆");
}

function renderDownloadNote(source: string, fileName: string): void {
  endBotBubble();
  const chip = make("div", "tool-chip done enter");
  chip.appendChild(makeText("span", "ico", "⬇"));
  chip.appendChild(makeText("span", "", `Downloaded ${fileName} from ${source}`));
  messagesEl.appendChild(chip);
}

const seenInfoPaths = new Set<string>();

function renderInfo(info: ModelInfo): void {
  endBotBubble();
  if (info.filePath) {
    if (seenInfoPaths.has(info.filePath)) return;
    seenInfoPaths.add(info.filePath);
  }
  const panel = make("div", "panel");
  panel.appendChild(panelHead("◳", "Model"));
  const grid = make("div", "metrics");
  addMetric(grid, "Width", `${info.sizeX.toFixed(1)} mm`);
  addMetric(grid, "Depth", `${info.sizeY.toFixed(1)} mm`);
  addMetric(grid, "Height", `${info.sizeZ.toFixed(1)} mm`);
  if (info.volumeMm3 !== undefined) addMetric(grid, "Volume", `${(info.volumeMm3 / 1000).toFixed(1)} cm³`);
  if (info.facets !== undefined) addMetric(grid, "Triangles", info.facets.toLocaleString());
  if (info.manifold !== undefined) addMetric(grid, "Watertight", info.manifold ? "yes" : "no");
  panel.appendChild(grid);
  messagesEl.appendChild(panel);
  scrollToBottom();
}

function renderMetrics(m: SliceMetrics, gcodeId?: string): void {
  endBotBubble();
  const panel = make("div", "panel");
  const title = m.plateCount && m.plateCount > 1 ? `Plate ${m.plateIndex} of ${m.plateCount}` : "Slice result";
  panel.appendChild(panelHead("✦", title));

  const grid = make("div", "metrics");
  if (m.partsOnPlate && m.partsOnPlate > 1) addMetric(grid, "On plate", `${m.partsOnPlate} parts`);
  if (m.estimatedPrintTime) addMetric(grid, "Print time", m.estimatedPrintTime, true);
  if (m.filamentUsedG !== undefined) addMetric(grid, "Filament", `${m.filamentUsedG.toFixed(1)} g`, true);
  if (m.filamentUsedMm !== undefined) addMetric(grid, "Length", `${(m.filamentUsedMm / 1000).toFixed(2)} m`);
  if (m.layerCount !== undefined) addMetric(grid, "Layers", String(m.layerCount));
  if (m.filamentCost !== undefined) addMetric(grid, "Est. cost", m.filamentCost.toFixed(2));
  if (m.supportsGenerated !== undefined) addMetric(grid, "Supports", m.supportsGenerated ? "added" : "none needed");
  panel.appendChild(grid);

  if (m.fixes && m.fixes.length) {
    panel.appendChild(makeText("div", "fix-note", `🔧 ${m.fixes.join(" ")}`));
  }

  const actions = make("div", "actions");
  if (gcodeId) {
    const dl = document.createElement("a") as HTMLAnchorElement;
    dl.className = "btn small";
    dl.textContent = "Download G-code";
    dl.href = `/api/gcode/${encodeURIComponent(gcodeId)}`;
    actions.appendChild(dl);
    const sendBtnEl = makeText("button", "btn primary small", "Send to printer") as HTMLButtonElement;
    sendBtnEl.onclick = () => void sendGcodeToPrinter(gcodeId);
    actions.appendChild(sendBtnEl);
  }
  if (actions.childElementCount > 0) panel.appendChild(actions);

  messagesEl.appendChild(panel);
  scrollToBottom();
}

function renderJobPlates(job: PrintJob): void {
  endBotBubble();
  const panel = make("div", "panel");
  panel.appendChild(panelHead("▤", `Job: ${job.name || job.id} (${job.status})`));
  const list = make("div", "plate-list");
  for (const plate of job.plates as JobPlate[]) {
    list.appendChild(buildPlateRow(plate));
  }
  panel.appendChild(list);
  if (job.notes && job.notes.length) {
    panel.appendChild(makeText("div", "fix-note", job.notes.join(" ")));
  }
  messagesEl.appendChild(panel);
  scrollToBottom();
}

function buildPlateRow(plate: JobPlate & { gcodeId?: string }): HTMLElement {
  const row = make("div", "plate-row");
  const dot = make("span", `status-dot ${plate.status}`);
  row.appendChild(dot);
  const label = make("div", "label");
  label.appendChild(makeText("div", "name", `Plate ${plate.index} — ${plate.parts.length} part(s)`));
  const sub = plate.metrics?.estimatedPrintTime
    ? `${plate.status} · ${plate.metrics.estimatedPrintTime}`
    : plate.error ?? plate.status;
  label.appendChild(makeText("div", "sub", sub));
  row.appendChild(label);
  if (plate.gcodeId) {
    const dl = document.createElement("a") as HTMLAnchorElement;
    dl.className = "btn small";
    dl.textContent = "G-code";
    dl.href = `/api/gcode/${encodeURIComponent(plate.gcodeId)}`;
    row.appendChild(dl);
  }
  return row;
}

function renderError(message: string): void {
  endBotBubble();
  const wrap = make("div", "msg bot enter");
  const bubble = make("div", "bubble");
  bubble.style.color = "#fecaca";
  bubble.textContent = `⚠ ${message}`;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function applyStatus(status: SlicerStatus): void {
  statusDot.className = "dot " + (status.installed ? "ok" : "err");
  statusText.textContent = status.installed ? "PrusaSlicer ready" : "PrusaSlicer not found";
}

// ── AgentEvent handling ──────────────────────────────────────────────────────

function handleAgentEvent(raw: Record<string, unknown>): void {
  const event = raw as AgentEvent & {
    gcodeId?: string;
    outcome?: SearchOutcome;
    resolution?: UrlResolution;
    job?: PrintJob;
    event?: JobEvent;
  };
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
      renderCards(event.models as unknown as CardLike[]);
      break;
    case "search":
      if (event.outcome) renderCards(event.outcome.results as unknown as CardLike[]);
      break;
    case "resolved":
      if (event.resolution) renderResolution(event.resolution);
      break;
    case "download":
      renderDownloadNote(event.model.source, event.result.fileName);
      break;
    case "info":
      renderInfo(event.info);
      break;
    case "metrics":
      renderMetrics(event.metrics, event.gcodeId);
      break;
    case "status":
      applyStatus(event.status);
      break;
    case "job":
      if (event.job) renderJobPlates(event.job);
      break;
    case "error":
      renderError(event.message);
      break;
    case "done":
      endBotBubble();
      setBusy(false);
      seenInfoPaths.clear();
      break;
    default:
      break; // unrecognised v2 event types (sent/orientation/…) — safe to ignore
  }
  scrollToBottom();
}

function renderResolution(resolution: UrlResolution): void {
  endBotBubble();
  const panel = make("div", "panel");
  panel.appendChild(panelHead("🔗", resolution.kind));
  panel.appendChild(makeText("div", "", resolution.message));
  if (resolution.model) {
    const actions = make("div", "actions");
    const importBtn = makeText("button", "btn primary small", "Import") as HTMLButtonElement;
    const modelUrl = resolution.model.webUrl;
    importBtn.onclick = () => void importFromUrl(modelUrl, resolution.model!.title);
    actions.appendChild(importBtn);
    panel.appendChild(actions);
  }
  messagesEl.appendChild(panel);
  scrollToBottom();
}

// ── chat send/cancel ─────────────────────────────────────────────────────────

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.classList.toggle("hidden", b);
  stopBtn.classList.toggle("hidden", !b);
  updateSendEnabled();
}

function updateSendEnabled(): void {
  sendBtn.disabled = busy || inputEl.value.trim().length === 0;
}

/** Build the outgoing instruction text, folding in the quick goal/material
 *  pickers from the settings sheet as a one-line context prefix so the agent
 *  doesn't have to ask when the user has already told it via the UI. */
function withQuickContext(instruction: string): string {
  const bits: string[] = [];
  if (goalSelect.value) bits.push(`print goal: ${goalSelect.value}`);
  if (materialSelect.value) bits.push(`material: ${materialSelect.value}`);
  if (bits.length === 0) return instruction;
  return `(For context — ${bits.join(", ")}.) ${instruction}`;
}

async function runTurn(instruction: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  endBotBubble();
  currentAbort = new AbortController();
  try {
    await streamSse("/api/chat", { message: withQuickContext(instruction) }, handleAgentEvent, currentAbort.signal);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      renderError((err as Error).message || String(err));
    }
  } finally {
    setBusy(false);
    currentAbort = undefined;
  }
}

async function sendInstruction(displayText: string, instruction: string): Promise<void> {
  if (busy) return;
  addUserMessage(displayText);
  await runTurn(instruction);
}

function cancelTurn(): void {
  currentAbort?.abort();
  void fetch("/api/chat/cancel", { method: "POST" }).catch(() => undefined);
}

// ── uploads (drag-and-drop + file picker) ───────────────────────────────────

const stagedFiles: UploadResult[] = [];

function renderAttachTray(): void {
  attachTray.replaceChildren();
  attachTray.classList.toggle("hidden", stagedFiles.length === 0);
  for (const f of stagedFiles) {
    const chip = make("div", "attach-chip");
    chip.appendChild(makeText("span", "name", f.fileName));
    attachTray.appendChild(chip);
  }
}

async function uploadFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  const fd = new FormData();
  for (const f of list) fd.append("files", f, f.name);

  try {
    const resp = await fetch("/api/upload", { method: "POST", body: fd });
    const data = (await resp.json()) as { uploaded?: UploadResult[]; rejected?: string[]; error?: string };
    if (!resp.ok) throw new Error(data.error ?? "Upload failed");
    const uploaded = data.uploaded ?? [];
    const rejected = data.rejected ?? [];
    stagedFiles.push(...uploaded);
    renderAttachTray();
    if (uploaded.length > 0) {
      const names = uploaded.map((u) => u.fileName).join(", ");
      const paths = uploaded.map((u) => u.localPath).join(", ");
      await sendInstruction(
        `Uploaded ${names}`,
        `I uploaded ${uploaded.length} file(s). Their exact path(s) on the server are: ${paths}. Treat these as my active model, inspect them, and recommend slicing settings.`,
      );
    }
    if (rejected.length > 0) {
      renderError(`Not accepted: ${rejected.join(", ")}`);
    }
  } catch (err) {
    renderError((err as Error).message || "Upload failed");
  }
}

// ── paste-a-link ─────────────────────────────────────────────────────────────

async function resolveLink(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;
  endBotBubble();
  clearEmptyState();
  const chip = make("div", "tool-chip enter");
  chip.appendChild(make("span", "spin"));
  chip.appendChild(makeText("span", "", "Resolving link…"));
  messagesEl.appendChild(chip);
  scrollToBottom();
  try {
    const resolution = await postJson<UrlResolution>("/api/resolve", { url: trimmed });
    chip.remove();
    renderResolution(resolution);
    if (!resolution.model && resolution.files.length === 0) {
      // Nothing structured came back — still worth trying an import directly
      // (a raw mesh URL resolves straight to a file with no "model" wrapper).
      await importFromUrl(trimmed, trimmed);
    }
  } catch (err) {
    chip.remove();
    renderError((err as Error).message || "Couldn't resolve that link.");
  }
}

async function importFromUrl(url: string, label: string): Promise<void> {
  try {
    const result = await postJson<{ fileName: string; localPath: string }>("/api/import", { url });
    await sendInstruction(
      `Imported ${label}`,
      `I imported a model from a link. Its exact path on the server is: ${result.localPath}. Treat it as my active model, inspect it, and recommend slicing settings.`,
    );
  } catch (err) {
    renderError((err as Error).message || "Import failed.");
  }
}

// ── printer send ─────────────────────────────────────────────────────────────

let selectedPrinterId: string | undefined;
try {
  selectedPrinterId = localStorage.getItem("slicely:selectedPrinter") ?? undefined;
} catch {
  selectedPrinterId = undefined;
}

async function sendGcodeToPrinter(gcodeId: string): Promise<void> {
  if (!selectedPrinterId) {
    renderError("Pick a printer in Settings first.");
    return;
  }
  try {
    const result = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(selectedPrinterId)}/send`, {
      gcodeId,
    });
    renderError(result.message); // reuse the same subtle inline note style
  } catch (err) {
    renderError((err as Error).message || "Couldn't send to the printer.");
  }
}

// ── printers panel (settings sheet) ─────────────────────────────────────────

let multiUser = false;

async function refreshPrinters(): Promise<void> {
  try {
    const [printers, statuses] = await Promise.all([
      getJson<PrinterConnection[]>("/api/printers"),
      getJson<PrinterStatus[]>("/api/printers/status"),
    ]);
    renderPrinterList(printers, statuses);
    updateHeaderPrinterPill(printers, statuses);
  } catch {
    printerListEl.replaceChildren(makeText("p", "sheet-hint", "Printer connections aren't available on this server yet."));
  }
}

function updateHeaderPrinterPill(printers: PrinterConnection[], statuses: PrinterStatus[]): void {
  const active = printers.find((p) => p.id === selectedPrinterId);
  if (!active) {
    printerDot.className = "dot off";
    printerLabel.textContent = "No printer";
    return;
  }
  const status = statuses.find((s) => s.id === active.id);
  const state = status?.state ?? "unknown";
  printerDot.className = "dot " + (state === "printing" || state === "idle" ? "ok" : state === "error" ? "err" : "warn");
  printerLabel.textContent = active.label;
}

function renderPrinterList(printers: PrinterConnection[], statuses: PrinterStatus[]): void {
  printerListEl.replaceChildren();
  if (printers.length === 0) {
    printerListEl.appendChild(makeText("p", "sheet-hint", "No printers added yet."));
    return;
  }
  for (const p of printers) {
    const status = statuses.find((s) => s.id === p.id);
    const row = make("div", "printer-row");
    const dot = make("span", "dot " + (status?.state === "error" ? "err" : status?.state === "printing" ? "ok" : "warn"));
    row.appendChild(dot);
    const info = make("div", "info");
    info.appendChild(makeText("div", "name", p.label));
    info.appendChild(makeText("div", "meta", `${p.transport} · ${status?.state ?? "unknown"}${p.id === selectedPrinterId ? " · active" : ""}`));
    row.appendChild(info);
    const btns = make("div", "btns");
    const useBtn = makeText("button", "btn small", "Use") as HTMLButtonElement;
    useBtn.onclick = () => void selectPrinter(p.id);
    btns.appendChild(useBtn);
    const testBtn = makeText("button", "btn small", "Test") as HTMLButtonElement;
    testBtn.onclick = () => void testPrinter(p.id);
    btns.appendChild(testBtn);
    row.appendChild(btns);
    printerListEl.appendChild(row);
  }
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

async function testPrinter(id: string): Promise<void> {
  try {
    const result = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(id)}/test`, {});
    renderError(result.message);
  } catch (err) {
    renderError((err as Error).message || "Test failed.");
  }
  await refreshPrinters();
}

interface DriverInfo {
  transport: string;
  label: string;
  defaultPort: number;
  requiredSecrets: string[];
}
let driverCatalog: DriverInfo[] = [];

async function loadDrivers(): Promise<void> {
  try {
    driverCatalog = await getJson<DriverInfo[]>("/api/printers/drivers");
    pTransport.replaceChildren();
    for (const d of driverCatalog) {
      const opt = document.createElement("option");
      opt.value = d.transport;
      opt.textContent = d.label;
      pTransport.appendChild(opt);
    }
    renderSecretFields();
  } catch {
    /* printers subsystem unavailable — the add-printer form stays empty */
  }
}

function renderSecretFields(): void {
  const driver = driverCatalog.find((d) => d.transport === pTransport.value);
  pSecretsFields.replaceChildren();
  const cloudTransports = new Set(["prusa-connect", "bambu-cloud"]);
  pHostRow.classList.toggle("hidden", cloudTransports.has(pTransport.value) || pTransport.value === "file");
  for (const secret of driver?.requiredSecrets ?? []) {
    const row = make("div", "sheet-row");
    row.appendChild(makeText("label", "sheet-label", secret));
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.secretField = secret;
    row.appendChild(input);
    pSecretsFields.appendChild(row);
  }
}

async function savePrinter(): Promise<void> {
  const body: Record<string, unknown> = {
    transport: pTransport.value,
    label: pLabel.value.trim() || pTransport.value,
    host: pHost.value.trim() || undefined,
  };
  for (const input of pSecretsFields.querySelectorAll<HTMLInputElement>("input[data-secret-field]")) {
    const field = input.dataset.secretField;
    if (field && input.value.trim()) body[field] = input.value.trim();
  }
  try {
    await postJson("/api/printers", body);
    addPrinterForm.classList.add("hidden");
    pLabel.value = "";
    pHost.value = "";
    await refreshPrinters();
  } catch (err) {
    renderError((err as Error).message || "Couldn't add that printer.");
  }
}

async function discoverPrinters(): Promise<void> {
  try {
    const found = await getJson<Array<{ label: string; host: string; transport: string }>>("/api/printers/discover");
    if (found.length === 0) {
      renderError("No printers found on the local network.");
    } else {
      renderError(`Found: ${found.map((f) => `${f.label} (${f.host})`).join(", ")}`);
    }
  } catch (err) {
    renderError((err as Error).message || "Discovery unavailable.");
  }
}

// ── settings sheet + status polling ─────────────────────────────────────────

async function loadStatus(): Promise<void> {
  try {
    const status = await getJson<SlicerStatus>("/api/status");
    applyStatus(status);
    bannerEl.classList.add("hidden");
  } catch {
    statusText.textContent = "unknown";
    bannerEl.textContent = "Can't reach the Slicely server right now — check your connection.";
    bannerEl.classList.remove("hidden");
  }
}

async function checkMultiUser(): Promise<void> {
  // /api/printers/discover answers 403 in multi-user mode; probing it (a
  // harmless GET) is the simplest way for the client to learn the mode
  // without a dedicated config endpoint.
  try {
    const resp = await fetch("/api/printers/discover");
    multiUser = resp.status === 403;
  } catch {
    multiUser = false;
  }
  multiUserNote.classList.toggle("hidden", !multiUser);
  discoverBtn.classList.toggle("hidden", multiUser);
}

// ── wiring ───────────────────────────────────────────────────────────────────

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
  updateSendEnabled();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitComposer();
  }
});

sendBtn.addEventListener("click", submitComposer);
stopBtn.addEventListener("click", cancelTurn);

function submitComposer(): void {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  updateSendEnabled();
  void sendInstruction(text, text);
}

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files) void uploadFiles(fileInput.files);
  fileInput.value = "";
});

linkBtn.addEventListener("click", () => {
  linkRow.classList.toggle("hidden");
  if (!linkRow.classList.contains("hidden")) linkInput.focus();
});
linkGo.addEventListener("click", () => {
  void resolveLink(linkInput.value);
  linkInput.value = "";
  linkRow.classList.add("hidden");
});
linkInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") linkGo.click();
});

settingsBtn.addEventListener("click", () => {
  settingsSheet.classList.toggle("hidden");
  if (!settingsSheet.classList.contains("hidden")) void refreshPrinters();
});
// The printer pill in the header is a shortcut into the same settings sheet
// (which is where printers are picked/managed) rather than a second menu.
printerPill.addEventListener("click", () => settingsBtn.click());
addPrinterBtn.addEventListener("click", () => addPrinterForm.classList.toggle("hidden"));
pTransport.addEventListener("change", renderSecretFields);
pSave.addEventListener("click", () => void savePrinter());
discoverBtn.addEventListener("click", () => void discoverPrinters());

// Drag-and-drop across the whole app.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  dropzone.classList.remove("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.add("hidden");
  if (e.dataTransfer?.files.length) void uploadFiles(e.dataTransfer.files);
});

// ── boot ─────────────────────────────────────────────────────────────────────

function showEmptyState(): void {
  const empty = make("div", "empty");
  empty.appendChild(makeText("span", "big", "◆"));
  const p = make("p");
  p.appendChild(document.createTextNode("Find a "));
  p.appendChild(makeText("b", "", "free 3D model"));
  p.appendChild(document.createTextNode(", slice it, and print — right from your phone."));
  empty.appendChild(p);
  const examples = make("div", "examples");
  const prompts = ["Find me a phone stand I can print today", "Slice this for strength, PETG, my Ender 3", "Show me a cable clip for a desk"];
  for (const ex of prompts) {
    const b = makeText("button", "ex", ex) as HTMLButtonElement;
    b.onclick = () => void sendInstruction(ex, ex);
    examples.appendChild(b);
  }
  empty.appendChild(examples);
  messagesEl.appendChild(empty);
}

showEmptyState();
updateSendEnabled();
void loadStatus();
void loadDrivers();
void checkMultiUser();
setInterval(() => void loadStatus(), 15000);
setInterval(() => {
  if (!settingsSheet.classList.contains("hidden")) void refreshPrinters();
}, 6000);
