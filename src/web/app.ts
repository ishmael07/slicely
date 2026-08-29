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
// stream. The job-run flow (POST /api/jobs/:id/run) reuses this SAME helper —
// see "Jobs" below — rather than growing a second SSE parser.
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentEvent, ModelInfo, SliceMetrics, SlicerStatus, UploadResult, SettingsState, EffortLevel, PrintPreferences, FeatureMode } from "../shared/types";
import type { PreviewMeshData } from "./viewer.js";
import type { PrinterConnection, PrinterStatus } from "../shared/printers";
import type { SearchOutcome, UrlResolution, SourceAvailability, PrintabilityScore } from "../shared/sourcing";
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
const jobsBtn = byId<HTMLButtonElement>("jobsBtn");
const jobsSheet = byId<HTMLElement>("jobsSheet");
const jobsListEl = byId<HTMLElement>("jobsList");
const jobsRefreshBtn = byId<HTMLButtonElement>("jobsRefreshBtn");
const statusDot = byId<HTMLElement>("statusDot");
const statusText = byId<HTMLElement>("statusText");
const printerPill = byId<HTMLButtonElement>("printerPill");
const printerDot = byId<HTMLElement>("printerDot");
const printerLabel = byId<HTMLElement>("printerLabel");
const printerListEl = byId<HTMLElement>("printerList");
const discoveredEl = byId<HTMLElement>("discovered");
const addPrinterBtn = byId<HTMLButtonElement>("addPrinterBtn");
const addPrinterForm = byId<HTMLElement>("addPrinterForm");
const discoverBtn = byId<HTMLButtonElement>("discoverBtn");
const pTransport = byId<HTMLSelectElement>("pTransport");
const pLabel = byId<HTMLInputElement>("pLabel");
const pHost = byId<HTMLInputElement>("pHost");
const pHostRow = byId<HTMLElement>("pHostRow");
const pSecretsFields = byId<HTMLElement>("pSecretsFields");
const pFolderRow = byId<HTMLElement>("pFolderRow");
const pFolder = byId<HTMLInputElement>("pFolder");
const pTransportHint = byId<HTMLElement>("pTransportHint");
const pSave = byId<HTMLButtonElement>("pSave");
const multiUserNote = byId<HTMLElement>("multiUserNote");
const sourcesListEl = byId<HTMLElement>("sourcesList");
const sourcesRefreshBtn = byId<HTMLButtonElement>("sourcesRefreshBtn");
const toastsEl = byId<HTMLElement>("toasts");

// Model + effort composer dropdowns
const modelTriggerBtn = byId<HTMLButtonElement>("modelTrigger");
const modelTriggerLabel = byId<HTMLElement>("modelTriggerLabel");
const modelMenuEl = byId<HTMLElement>("modelMenu");
const effortTriggerBtn = byId<HTMLButtonElement>("effortTrigger");
const effortTriggerLabel = byId<HTMLElement>("effortTriggerLabel");
const effortMenuEl = byId<HTMLElement>("effortMenu");

// Slice-defaults sheet
const ssPrinter = byId<HTMLSelectElement>("ssPrinter");
const ssCustom = byId<HTMLElement>("ssCustom");
const ssBedX = byId<HTMLInputElement>("ssBedX");
const ssBedY = byId<HTMLInputElement>("ssBedY");
const ssBedZ = byId<HTMLInputElement>("ssBedZ");
const ssNozzle = byId<HTMLInputElement>("ssNozzle");
const ssSaveCustom = byId<HTMLButtonElement>("ssSaveCustom");
const ssMaterial = byId<HTMLSelectElement>("ssMaterial");
const ssGoal = byId<HTMLSelectElement>("ssGoal");
const ssInfill = byId<HTMLInputElement>("ssInfill");
const ssPattern = byId<HTMLSelectElement>("ssPattern");
const ssSupports = byId<HTMLElement>("ssSupports");
const ssStyleRow = byId<HTMLElement>("ssStyleRow");
const ssSupportStyle = byId<HTMLSelectElement>("ssSupportStyle");
const ssBrim = byId<HTMLElement>("ssBrim");
const ssBrimWidth = byId<HTMLInputElement>("ssBrimWidth");

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

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error((data as { error?: string }).error ?? `${url} failed (${resp.status})`);
  return data;
}

/** Read a `data: {...}\n\n` SSE stream off a POST response body — the
 *  browser's native EventSource can only issue GET requests, so a streamed
 *  chat/job reply is parsed by hand off `fetch()`'s ReadableStream. Reused by
 *  BOTH /api/chat and /api/jobs/:id/run — do not write a second parser. */
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

/** Update a running chip's text in place, so a long tool visibly moves. */
function updateToolChip(tool: string, label: string): void {
  const chip = activeChips.get(tool);
  if (!chip) return;
  const text = chip.querySelector("span:last-child");
  if (text) text.textContent = label;
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
    if (label) {
      label.textContent = summary ? friendlyError(summary).what : "That didn't work.";
    }
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMinutes(mins?: number): string {
  if (mins === undefined || !Number.isFinite(mins)) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── toasts (printer send/test feedback) ─────────────────────────────────────

function toast(message: string, kind: "ok" | "err"): void {
  const t = makeText("div", `toast ${kind}`, message);
  toastsEl.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 4000);
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
  printability?: PrintabilityScore;
}

function renderCards(models: CardLike[]): void {
  endBotBubble();
  if (models.length === 0) return;
  const wrap = make("div", "cards");
  for (const m of models) wrap.appendChild(buildCard(m));
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

/**
 * Compact licence code, e.g. "CC BY-NC-SA".
 *
 * What a user needs at a glance is whether they may use it and whether it is
 * commercial — not four dash-separated clauses. The full text stays on hover.
 */
function shortLicence(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes("public domain") || l.includes("cc0")) return "Public domain";
  if (l.includes("creative commons") || l.startsWith("cc")) {
    const parts = ["BY"];
    if (l.includes("noncommercial") || l.includes("non-commercial") || l.includes("-nc")) {
      parts.push("NC");
    }
    if (l.includes("share alike") || l.includes("sharealike") || l.includes("-sa")) parts.push("SA");
    if (l.includes("noderiv") || l.includes("-nd")) parts.push("ND");
    if (!l.includes("attribution") && !l.includes("by")) return "Creative Commons";
    return `CC ${parts.join("-")}`;
  }
  if (l.includes("mit")) return "MIT";
  if (l.includes("gpl")) return "GPL";
  if (l.includes("standard digital file")) return "Standard licence";
  if (l.includes("exclusive")) return "Exclusive licence";
  // Unknown: keep it short rather than letting it wrap the card.
  return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
}

function buildCard(m: CardLike): HTMLElement {
  const card = make("div", "card");
  if (m.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    // Via the server: several sources set Cross-Origin-Resource-Policy, so the
    // browser refuses to paint their images in our page and every card would
    // fall back to a grey placeholder.
    img.src = `/api/thumb?url=${encodeURIComponent(m.thumbnail)}`;
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
  if (m.printability) {
    meta.appendChild(makeText("div", "score", `Printability ${Math.round(m.printability.score)}`));
  }
  if (m.license) {
    // Sources spell licences out in full ("Creative Commons — Attribution —
    // Noncommercial — Share Alike"), which fills a whole card line, truncates,
    // and tells the reader nothing they can act on. The short code does.
    const lic = makeText("div", "lic", shortLicence(m.license));
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

/** Note under a result set naming which sources actually answered — so a
 *  thin result list reads as "MakerWorld timed out", not just "not much here". */
function renderSourcesOutcome(sources: SearchOutcome["sources"] | undefined): void {
  if (!sources || sources.length === 0) return;
  // Summarise rather than dumping every source's raw error into the
  // transcript. Which sources CONTRIBUTED is the useful part; a Cloudflare
  // block is background noise the user can do nothing about, so it collapses
  // to a count and lives on hover.
  const note = make("div", "sources-note");
  const worked = sources.filter((s) => s.ok && s.count > 0);
  const failed = sources.filter((s) => !s.ok);
  const empty = sources.filter((s) => s.ok && s.count === 0);

  const found = worked
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((s) => `${s.id} ${s.count}`)
    .join(" · ");
  note.appendChild(makeText("span", "", found || "no sources returned results"));

  if (failed.length > 0 || empty.length > 0) {
    const quiet = makeText(
      "span",
      "fail",
      ` · ${failed.length + empty.length} source${failed.length + empty.length === 1 ? "" : "s"} had nothing`,
    );
    // Full detail stays available without occupying the transcript.
    quiet.title = [
      ...failed.map((s) => `${s.id}: ${s.error ?? "failed"}`),
      ...empty.map((s) => `${s.id}: no matches`),
    ].join("\n");
    note.appendChild(quiet);
  }
  messagesEl.appendChild(note);
  scrollToBottom();
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
  if (info.filePath) attachViewer(panel, info.filePath);
  messagesEl.appendChild(panel);
  scrollToBottom();
}

/**
 * Add a turning 3D view of the model to a panel.
 *
 * Loaded lazily and failing silently: a preview is a nicety, and a model the
 * viewer cannot read must never take the metrics panel down with it.
 */
function attachViewer(panel: HTMLElement, filePath: string): void {
  const holder = make("div", "viewer");
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  const note = make("div", "viewer-note");
  note.textContent = "Loading preview…";
  holder.appendChild(note);
  panel.appendChild(holder);

  void (async () => {
    try {
      const mesh = await getJson<PreviewMeshData>(
        `/api/preview?path=${encodeURIComponent(filePath)}`,
      );
      if (mesh.triangles === 0) {
        holder.remove();
        return;
      }
      const { ModelViewer } = await import("./viewer.js");
      const viewer = new ModelViewer(canvas);
      viewer.setMesh(mesh);
      note.textContent =
        mesh.triangles < mesh.sourceTriangles
          ? `Simplified to ${mesh.triangles.toLocaleString()} triangles for preview · drag to turn`
          : "Drag to turn";

      // Stop animating once it scrolls out of view. A long transcript would
      // otherwise leave every previous viewer redrawing forever.
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) viewer.start();
            else viewer.stop();
          }
        }).observe(holder);
      }
    } catch {
      holder.remove();
    }
  })();
}

// ── printer send (shared by the single-slice panel AND every job plate) ────
// Mirrors src/renderer/printers.ts's sendAction(): the button reads "Send &
// start" ONLY when the target printer is actually armed for unattended
// auto-start; otherwise it's worded as an upload-and-queue action. Rebuilt
// live via onPrintersChanged() so an existing panel's wording stays correct
// if the user changes printer/arms auto-start after the panel was drawn.

let printersCache: PrinterConnection[] = [];
let selectedPrinterId: string | undefined;
try {
  selectedPrinterId = localStorage.getItem("slicely:selectedPrinter") ?? undefined;
} catch {
  selectedPrinterId = undefined;
}
/** Printers the user has armed for unattended auto-start, mirrored locally
 *  from this browser's own toggle actions (there is no GET for arm state —
 *  see the report). Never assume armed by default. */
const armedPrinters = new Set<string>();

type Listener = () => void;
const printerListeners = new Set<Listener>();
function onPrintersChanged(fn: Listener): () => void {
  printerListeners.add(fn);
  return () => printerListeners.delete(fn);
}
function emitPrintersChanged(): void {
  for (const fn of printerListeners) fn();
}

function activeSendTarget(): PrinterConnection | undefined {
  return printersCache.find((p) => p.id === selectedPrinterId) ?? printersCache[0];
}

function buildSendButton(gcodeId: string, size?: "small"): HTMLButtonElement | null {
  const p = activeSendTarget();
  if (!p) return null;
  const willStart = armedPrinters.has(p.id);
  const cls = size ? `btn primary ${size}` : "btn primary";
  const btn = makeText("button", cls, willStart ? `Send & start → ${p.label}` : `Send to ${p.label}`) as HTMLButtonElement;
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
    const result = await postJson<{ ok: boolean; started: boolean; message: string }>(`/api/printers/${encodeURIComponent(printerId)}/send`, {
      gcodeId,
      opts: { startImmediately: start },
    });
    btn.textContent = result.ok ? (result.started ? "✓ Printing" : "✓ Queued") : "✗ Failed";
    toast(result.message, result.ok ? "ok" : "err");
  } catch (err) {
    btn.textContent = "✗ Failed";
    toast((err as Error).message || "Couldn't send to the printer.", "err");
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 2500);
  }
}

/** Mount a live-updating Send button inside `container`. Subscribes to
 *  printer-state changes and tears itself down once removed from the DOM. */
function attachSendSlot(container: HTMLElement, gcodeId: string, size?: "small"): void {
  const slot = make("span", "send-slot");
  const fill = (): void => {
    slot.replaceChildren();
    const btn = buildSendButton(gcodeId, size);
    if (btn) slot.appendChild(btn);
  };
  fill();
  const unsubscribe = onPrintersChanged(fill);
  const mo = new MutationObserver((_records, obs) => {
    if (!messagesEl.contains(slot)) {
      unsubscribe();
      obs.disconnect();
    }
  });
  mo.observe(messagesEl, { childList: true, subtree: true });
  container.appendChild(slot);
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

  // Send-to-printer is primary (it's the action that actually finishes the
  // job); Download G-code is the secondary, always-available fallback — the
  // web client has no local PrusaSlicer to "open" the result in.
  if (gcodeId) {
    const actions = make("div", "actions");
    attachSendSlot(actions, gcodeId);
    const dl = document.createElement("a");
    dl.className = "btn small";
    dl.textContent = "Download G-code";
    dl.href = `/api/gcode/${encodeURIComponent(gcodeId)}`;
    actions.appendChild(dl);
    panel.appendChild(actions);
  }

  messagesEl.appendChild(panel);
  scrollToBottom();
}

// ── Jobs (multi-part, multi-plate) ──────────────────────────────────────────
// A job panel is created once (from a plan result, a chat "job" snapshot, or
// a /api/jobs/:id lookup) and then mutated in place as JobEvents arrive — via
// the SAME streamSse() helper used for chat — so the plate list, totals, and
// warnings update live instead of spamming a new panel per event.

/** Wire-level widening: routes/jobs.ts attaches a `gcodeId` to each plate (on
 *  job_planned/job_done) or to the event itself (on plate_done) once it has
 *  relocated that plate's G-code into this session's own registry. Chat-driven
 *  "job"/"job_progress" AgentEvents do NOT get this treatment (see the
 *  report) — their plates simply never carry a gcodeId, so no Send/Download
 *  button renders for them. That is deliberate: without an id, the server has
 *  no offline-safe way to name that file. */
type WirePlate = JobPlate & { gcodeId?: string };
type WireJob = Omit<PrintJob, "plates"> & { plates: WirePlate[] };
type WireJobEvent =
  | { type: "job_planned"; job: WireJob }
  | { type: "plate_start"; jobId: string; plateIndex: number }
  | { type: "plate_done"; jobId: string; plateIndex: number; metrics: SliceMetrics; gcodeId?: string }
  | { type: "plate_failed"; jobId: string; plateIndex: number; error: string }
  | { type: "job_done"; job: WireJob }
  | { type: "job_failed"; jobId: string; error: string };

interface JobPanel {
  el: HTMLElement;
  setJob(job: WireJob): void;
  applyEvent(ev: WireJobEvent): void;
}

function placeholderJob(id: string): PrintJob {
  const now = new Date().toISOString();
  return { id, name: id, createdAt: now, updatedAt: now, status: "slicing", plates: [], params: {}, goal: "quality", material: "PLA", notes: [] };
}

/** First-write-wins: routes/jobs.ts's job_done handler redundantly re-adopts
 *  a plate's G-code that plate_done already relocated, and the second
 *  adoption can land on a dead path (the source was already moved by the
 *  first one) — a real server-side quirk verified live. Keeping only the
 *  FIRST gcodeId seen per plate avoids ever downgrading a good, downloadable
 *  id to a later broken one for the same plate. */
function mergeGcodeIds(store: Map<number, string>, job: WireJob): void {
  for (const p of job.plates) {
    if (p.gcodeId && !store.has(p.index)) store.set(p.index, p.gcodeId);
  }
}

function updatePlate(job: PrintJob, index: number, fn: (p: JobPlate) => JobPlate): PrintJob {
  return { ...job, plates: job.plates.map((p) => (p.index === index ? fn(p) : p)) };
}

/**
 * Turn a raw failure into something the reader can act on.
 *
 * Slicer and pipeline errors are written for a log: "Slicing failed: exit -1"
 * tells a user nothing, and the long over-packed message reads as a wall when
 * squeezed into a row. Each case below gives the cause in one line and the fix
 * in the next, and anything unrecognised is passed through rather than hidden.
 */
function friendlyError(raw: string): { what: string; fix?: string } {
  const e = raw.toLowerCase();
  if (e.includes("nothing landed on the bed") || e.includes("over-packed")) {
    return {
      what: "Nothing fit on this plate.",
      fix: "Scale the parts down, print fewer copies, or choose a printer with a bigger bed.",
    };
  }
  if (e.includes("too large") || e.includes("outside the print volume")) {
    return {
      what: "This part is bigger than the printer's bed.",
      fix: "Scale it down or split the model into pieces.",
    };
  }
  if (e.includes("exit -1") || e.includes("slicing failed")) {
    return {
      what: "PrusaSlicer couldn't slice this plate.",
      fix: "Often a mesh problem — try opening it in PrusaSlicer to check for errors.",
    };
  }
  if (e.includes("model file not found") || e.includes("enoent")) {
    return { what: "The model file is missing.", fix: "Re-import or upload it and try again." };
  }
  if (e.includes("not installed") || e.includes("prusaslicer")) {
    return {
      what: "PrusaSlicer isn't available.",
      fix: "Install it, then reload — search and import still work without it.",
    };
  }
  if (e.includes("cancelled")) return { what: "Cancelled." };
  return { what: raw };
}

/** A readable failure block: what happened, then what to do about it. */
function errorBlock(raw: string): HTMLElement {
  const { what, fix } = friendlyError(raw);
  const box = make("div", "err-block");
  box.appendChild(makeText("div", "err-what", what));
  if (fix) box.appendChild(makeText("div", "err-fix", fix));
  return box;
}

function buildPlateRow(plate: JobPlate, gcodeId: string | undefined): HTMLElement {
  const row = make("div", "plate-row");
  row.appendChild(make("span", `status-dot ${plate.status}`));
  const label = make("div", "label");
  label.appendChild(makeText("div", "name", `Plate ${plate.index} — ${plate.parts.length} part(s)`));
  // A failed plate gets its own block below, not a raw error crammed into the
  // one-line summary where it wraps into an unreadable slab.
  const sub = plate.metrics?.estimatedPrintTime
    ? `${plate.status} · ${plate.metrics.estimatedPrintTime}${plate.metrics.filamentUsedG !== undefined ? ` · ${plate.metrics.filamentUsedG.toFixed(1)} g` : ""}`
    : plate.status;
  label.appendChild(makeText("div", "sub", sub));
  if (plate.status === "failed" && plate.error) label.appendChild(errorBlock(plate.error));
  row.appendChild(label);
  if (gcodeId) {
    const btns = make("div", "btns");
    const dl = document.createElement("a");
    dl.className = "btn small";
    dl.textContent = "G-code";
    dl.href = `/api/gcode/${encodeURIComponent(gcodeId)}`;
    btns.appendChild(dl);
    attachSendSlot(btns, gcodeId, "small");
    row.appendChild(btns);
  }
  return row;
}

function createJobPanel(initial: WireJob): JobPanel {
  const gcodeIds = new Map<number, string>();
  let job: PrintJob = initial;
  mergeGcodeIds(gcodeIds, initial);

  const panel = make("div", "panel");

  function render(): void {
    panel.replaceChildren();
    panel.appendChild(panelHead("▤", `${job.name || job.id} — ${job.status}`));

    if (job.totals) {
      const grid = make("div", "metrics");
      addMetric(grid, "Plates", String(job.totals.plateCount));
      addMetric(grid, "Parts", String(job.totals.partCount));
      if (job.totals.estimatedMinutes !== undefined) addMetric(grid, "Print time", formatMinutes(job.totals.estimatedMinutes), true);
      if (job.totals.filamentG !== undefined) addMetric(grid, "Filament", `${job.totals.filamentG.toFixed(1)} g`, true);
      if (job.totals.filamentCost !== undefined) addMetric(grid, "Est. cost", job.totals.filamentCost.toFixed(2));
      if (job.totals.toolChanges !== undefined) addMetric(grid, "Tool changes", String(job.totals.toolChanges));
      panel.appendChild(grid);
    }

    const list = make("div", "plate-list");
    for (const plate of job.plates) list.appendChild(buildPlateRow(plate, gcodeIds.get(plate.index)));
    panel.appendChild(list);

    if (job.colourPlan && job.colourPlan.warnings.length > 0) {
      panel.appendChild(makeText("div", "fix-note", `🎨 ${job.colourPlan.warnings.join(" ")}`));
    }
    if (job.oversized && job.oversized.length > 0) {
      panel.appendChild(
        makeText("div", "job-warn", `⚠ Too large for the bed. Scale down: ${job.oversized.map((p) => p.name).join(", ")}`),
      );
    }
    if (job.notes.length > 0) {
      // One line per note. Joined with spaces these ran together into a wall
      // of text where nothing could be picked out — and per-part orientation
      // notes are exactly the kind of thing a reader scans rather than reads.
      const details = document.createElement("details");
      details.className = "job-notes";
      const summary = document.createElement("summary");
      summary.textContent =
        job.notes.length === 1 ? "1 note" : `${job.notes.length} notes about this plan`;
      details.appendChild(summary);
      const ul = document.createElement("ul");
      for (const note of job.notes) {
        const li = document.createElement("li");
        li.textContent = note;
        ul.appendChild(li);
      }
      details.appendChild(ul);
      panel.appendChild(details);
    }

    if (job.status === "planned" || job.status === "failed") {
      const actions = make("div", "actions");
      const runBtn = makeText("button", "btn primary small", job.status === "failed" ? "Retry job" : "Run job") as HTMLButtonElement;
      runBtn.onclick = () => {
        runBtn.disabled = true;
        runBtn.textContent = "Running…";
        void runJobStream(job.id);
      };
      actions.appendChild(runBtn);
      panel.appendChild(actions);
    }
  }

  function setJob(j: WireJob): void {
    mergeGcodeIds(gcodeIds, j);
    job = j;
    render();
  }

  function applyEvent(ev: WireJobEvent): void {
    switch (ev.type) {
      case "job_planned":
        mergeGcodeIds(gcodeIds, ev.job);
        job = ev.job;
        break;
      case "plate_start":
        job = updatePlate(job, ev.plateIndex, (p) => ({ ...p, status: "slicing" }));
        break;
      case "plate_done":
        if (ev.gcodeId) gcodeIds.set(ev.plateIndex, ev.gcodeId);
        job = updatePlate(job, ev.plateIndex, (p) => ({ ...p, status: "ready", metrics: ev.metrics, gcodePath: ev.metrics.gcodePath }));
        break;
      case "plate_failed":
        job = updatePlate(job, ev.plateIndex, (p) => ({ ...p, status: "failed", error: ev.error }));
        break;
      case "job_done":
        mergeGcodeIds(gcodeIds, ev.job);
        job = ev.job;
        break;
      case "job_failed":
        job = { ...job, status: "failed" };
        break;
    }
    render();
  }

  render();
  return { el: panel, setJob, applyEvent };
}

const jobPanels = new Map<string, JobPanel>();

/** Get (or lazily create) the live panel for a job id, appending it to the
 *  transcript the first time it's seen. Passing `seed` refreshes an existing
 *  panel with a full snapshot (e.g. after GET /api/jobs/:id). */
function getJobPanel(id: string, seed?: WireJob): JobPanel {
  let panel = jobPanels.get(id);
  if (!panel) {
    panel = createJobPanel(seed ?? placeholderJob(id));
    jobPanels.set(id, panel);
    endBotBubble();
    clearEmptyState();
    messagesEl.appendChild(panel.el);
    scrollToBottom();
  } else if (seed) {
    panel.setJob(seed);
  }
  return panel;
}

async function runJobStream(jobId: string): Promise<void> {
  const panel = getJobPanel(jobId);
  try {
    await streamSse(`/api/jobs/${encodeURIComponent(jobId)}/run`, {}, (raw) => {
      panel.applyEvent(raw as unknown as WireJobEvent);
    });
  } catch (err) {
    renderError((err as Error).message || "Job run failed.");
  }
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

async function planJobFromStaged(): Promise<void> {
  if (stagedFiles.length === 0) return;
  clearEmptyState();
  const chip = make("div", "tool-chip enter");
  chip.appendChild(make("span", "spin"));
  chip.appendChild(makeText("span", "", "Planning job…"));
  messagesEl.appendChild(chip);
  scrollToBottom();

  const parts = stagedFiles.map((f) => ({ path: f.localPath }));
  const opts: Record<string, unknown> = { bed: resolveBed(), autoOrient: true };
  if (settings?.preferences.goal) opts.goal = settings.preferences.goal;
  if (settings?.preferences.material) opts.material = settings.preferences.material;

  try {
    const job = await postJson<PrintJob>("/api/jobs", { parts, opts });
    chip.remove();
    stagedFiles.length = 0;
    renderAttachTray();
    updateSendEnabled();
    getJobPanel(job.id, job as WireJob);
  } catch (err) {
    chip.remove();
    renderError((err as Error).message || "Couldn't plan that job.");
  }
}

async function refreshJobsList(): Promise<void> {
  try {
    const jobs = await getJson<PrintJob[]>("/api/jobs");
    renderJobsList(jobs);
  } catch {
    jobsListEl.replaceChildren(makeText("p", "sheet-hint", "Job history isn't available on this server yet."));
  }
}

function renderJobsList(jobs: PrintJob[]): void {
  jobsListEl.replaceChildren();
  if (jobs.length === 0) {
    jobsListEl.appendChild(makeText("p", "sheet-hint", 'No jobs yet. Attach 2 or more files, then use "Plan print job" in the tray.'));
    return;
  }
  for (const j of jobs) {
    const row = make("div", "job-row");
    const info = make("div", "info");
    info.appendChild(makeText("div", "name", j.name || j.id));
    info.appendChild(makeText("div", "meta", `${j.status} · ${j.plates.length} plate(s)`));
    row.appendChild(info);
    const viewBtn = makeText("button", "btn ghost small", "View") as HTMLButtonElement;
    viewBtn.onclick = () => void viewJob(j.id);
    row.appendChild(viewBtn);
    jobsListEl.appendChild(row);
  }
}

async function viewJob(id: string): Promise<void> {
  try {
    const job = await getJson<PrintJob>(`/api/jobs/${encodeURIComponent(id)}`);
    showSheet(null);
    getJobPanel(job.id, job as WireJob);
  } catch (err) {
    renderError((err as Error).message || "Couldn't load that job.");
  }
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

/** Where to get PrusaSlicer. Slicely cannot slice without it, so a missing
 *  install is the one blocker worth interrupting the user for. */
const PRUSASLICER_DOWNLOAD = "https://www.prusa3d.com/page/prusaslicer_424/";

function showSlicerMissing(): void {
  bannerEl.replaceChildren();
  bannerEl.classList.remove("hidden");
  bannerEl.classList.add("banner-action");
  const text = make("span", "");
  text.textContent =
    "PrusaSlicer isn't installed, so Slicely can't slice yet. Searching and importing still work.";
  const link = document.createElement("a");
  link.href = PRUSASLICER_DOWNLOAD;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.className = "btn primary small";
  link.textContent = "Download PrusaSlicer";
  bannerEl.append(text, link);
}

function applyStatus(status: SlicerStatus): void {
  if (!status.installed) {
    statusDot.className = "dot err";
    statusText.textContent = "PrusaSlicer not found";
    // A status pill is easy to miss, and nothing downstream works without it.
    showSlicerMissing();
  } else if (status.running) {
    statusDot.className = "dot busy";
    statusText.textContent = `PrusaSlicer ${status.version ?? ""} · open`.trim();
  } else {
    statusDot.className = "dot ok";
    statusText.textContent = `PrusaSlicer ${status.version ?? "ready"}`.trim();
  }
  if (status.installed && bannerEl.classList.contains("banner-action")) {
    bannerEl.classList.add("hidden");
    bannerEl.classList.remove("banner-action");
    bannerEl.replaceChildren();
  }
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
    case "tool_progress":
      updateToolChip(event.tool, event.label);
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
      if (event.outcome) {
        renderCards(event.outcome.results as unknown as CardLike[]);
        renderSourcesOutcome(event.outcome.sources);
      }
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
      if (event.job) getJobPanel(event.job.id, event.job as WireJob);
      break;
    case "job_progress":
      if (event.event) {
        const ev = event.event as unknown as WireJobEvent;
        const id = ev.type === "job_planned" || ev.type === "job_done" ? ev.job.id : ev.jobId;
        getJobPanel(id).applyEvent(ev);
      }
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
      break; // unrecognised v2 event types — safe to ignore
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
    const modelTitle = resolution.model.title;
    importBtn.onclick = () => void importFromUrl(modelUrl, modelTitle);
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
  sendBtn.disabled = busy || (inputEl.value.trim().length === 0 && stagedFiles.length === 0);
}

async function runTurn(instruction: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  endBotBubble();
  currentAbort = new AbortController();
  try {
    await streamSse("/api/chat", { message: instruction }, handleAgentEvent, currentAbort.signal);
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

// ── uploads (drag-and-drop + file picker): stage-on-drop, act-on-send ──────
// Staged files can go two ways: sent along with the next chat message (a
// single active model, inspected/sliced conversationally), or planned as a
// multi-part JOB via the button that appears in the tray once >=1 file is
// staged (see "Jobs" above).

const stagedFiles: UploadResult[] = [];

function removeStaged(localPath: string): void {
  const idx = stagedFiles.findIndex((f) => f.localPath === localPath);
  if (idx >= 0) stagedFiles.splice(idx, 1);
  renderAttachTray();
  updateSendEnabled();
}

function renderAttachTray(): void {
  attachTray.replaceChildren();
  attachTray.classList.toggle("hidden", stagedFiles.length === 0);
  if (stagedFiles.length === 0) return;

  const chipRow = make("div", "attach-chip-row");
  for (const f of stagedFiles) {
    const chip = make("div", "attach-chip");
    chip.appendChild(makeText("span", "name", f.fileName));
    const rm = makeText("button", "", "×") as HTMLButtonElement;
    rm.title = `Remove ${f.fileName}`;
    rm.onclick = () => removeStaged(f.localPath);
    chip.appendChild(rm);
    chipRow.appendChild(chip);
  }
  attachTray.appendChild(chipRow);

  const planBtn = makeText(
    "button",
    "btn small primary",
    stagedFiles.length > 1 ? `Plan print job (${stagedFiles.length} parts)` : "Plan print job",
  ) as HTMLButtonElement;
  planBtn.onclick = () => void planJobFromStaged();
  attachTray.appendChild(planBtn);
}

function stageResults(results: UploadResult[]): void {
  if (results.length === 0) return;
  for (const r of results) {
    if (!stagedFiles.some((s) => s.localPath === r.localPath)) stagedFiles.push(r);
  }
  renderAttachTray();
  updateSendEnabled();
  inputEl.focus();
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
    stageResults(data.uploaded ?? []);
    if (data.rejected && data.rejected.length > 0) renderError(`Not accepted: ${data.rejected.join(", ")}`);
  } catch (err) {
    renderError((err as Error).message || "Upload failed");
  }
}

function renderUploadChip(r: UploadResult): void {
  const chip = make("div", "tool-chip done enter");
  chip.appendChild(makeText("span", "ico", "📦"));
  chip.appendChild(makeText("span", "", `Added ${r.fileName} (${formatBytes(r.sizeBytes)})`));
  messagesEl.appendChild(chip);
}

/** Compose the message sent to the agent from the user's text + staged files
 *  — mirrors src/renderer/renderer.ts's buildInstruction(). */
function buildAttachmentInstruction(text: string, files: UploadResult[]): string {
  const active = files.find((f) => f.sliceable) ?? files[0];
  const names = files.map((f) => `"${f.fileName}"`).join(", ");
  const context =
    files.length === 1
      ? `The user attached a 3D model file, ${names}, now the active model (server path: ${active.localPath}). `
      : `The user attached ${files.length} files (${names}). The active model is "${active.fileName}" (server path: ${active.localPath}). `;

  if (text) return `${context}\n\nThe user says: ${text}`;
  return active.sliceable
    ? `${context}Inspect it, report its dimensions, recommend optimal slicing settings, and offer to slice it.`
    : `${context}This is a ${active.ext} CAD file that may need converting first. Inspect it if possible and explain next steps.`;
}

function submitComposer(): void {
  if (busy) return;
  const text = inputEl.value.trim();
  const files = stagedFiles.slice();
  if (!text && files.length === 0) return;
  clearEmptyState();

  if (files.length > 0) {
    addUserMessage(text || (files.length === 1 ? `Attached ${files[0].fileName}` : `Attached ${files.length} files`));
    for (const f of files) renderUploadChip(f);
    stagedFiles.length = 0;
    renderAttachTray();
  } else {
    addUserMessage(text);
  }

  inputEl.value = "";
  inputEl.style.height = "auto";
  updateSendEnabled();
  void runTurn(files.length > 0 ? buildAttachmentInstruction(text, files) : text);
}

// ── paste-a-link OR search directly ─────────────────────────────────────────
// One row does both jobs: a URL resolves via /api/resolve, anything else runs
// a direct federated search via GET /api/search (no chat turn needed).

function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (t.includes(" ")) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^www\./i.test(t)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t);
}

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

async function runDirectSearch(query: string): Promise<void> {
  endBotBubble();
  clearEmptyState();
  const chip = make("div", "tool-chip enter");
  chip.appendChild(make("span", "spin"));
  chip.appendChild(makeText("span", "", `Searching for "${query}"…`));
  messagesEl.appendChild(chip);
  scrollToBottom();
  try {
    const outcome = await getJson<SearchOutcome>(`/api/search?q=${encodeURIComponent(query)}`);
    chip.remove();
    if (outcome.results.length === 0) renderError(`No results for "${query}".`);
    else renderCards(outcome.results as unknown as CardLike[]);
    renderSourcesOutcome(outcome.sources);
  } catch (err) {
    chip.remove();
    renderError((err as Error).message || "Search failed.");
  }
}

async function handleLinkGo(): Promise<void> {
  const raw = linkInput.value.trim();
  if (!raw) return;
  linkInput.value = "";
  linkRow.classList.add("hidden");
  if (looksLikeUrl(raw)) await resolveLink(raw);
  else await runDirectSearch(raw);
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

// ── model + effort dropdowns (Cursor-style, mirrors the Electron composer) ──

let settings: SettingsState | null = null;

async function loadSettings(): Promise<void> {
  try {
    settings = await getJson<SettingsState>("/api/settings");
    renderModelEffort();
    renderPreferences();
  } catch {
    /* the dropdowns/sheet just stay at their defaults */
  }
}

function toggleMenu(which: "model" | "effort"): void {
  const menu = which === "model" ? modelMenuEl : effortMenuEl;
  const trigger = which === "model" ? modelTriggerBtn : effortTriggerBtn;
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
    text.appendChild(makeText("div", "mname", m.label));
    text.appendChild(makeText("div", "mblurb", m.blurb));
    item.appendChild(text);
    item.appendChild(makeText("span", "check", "✓"));
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
    text.appendChild(makeText("div", "mname", lvl));
    item.appendChild(text);
    item.appendChild(makeText("span", "check", "✓"));
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
    renderError((err as Error).message || "Couldn't change that setting.");
  }
}

// ── slice-defaults sheet (printer, material, goal, infill, supports, brim) ──

function fillSelect(sel: HTMLSelectElement, options: { value: string; label: string }[], current: string): void {
  sel.replaceChildren();
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderSegment(host: HTMLElement, current: FeatureMode, onPick: (mode: FeatureMode) => void): void {
  host.replaceChildren();
  for (const mode of ["auto", "on", "off"] as FeatureMode[]) {
    const b = makeText("button", "", mode) as HTMLButtonElement;
    if (mode === current) b.classList.add("active");
    b.onclick = () => onPick(mode);
    host.appendChild(b);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderPreferences(): void {
  if (!settings) return;
  const { preferences: p, printers, materials, goals } = settings;

  fillSelect(
    ssPrinter,
    [{ value: "", label: "Not set (ask me)" }, ...printers.map((pr) => ({ value: pr.key, label: pr.label })), { value: "custom", label: "Custom…" }],
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
    [{ value: "", label: "Auto (by goal)" }, ...["gyroid", "grid", "rectilinear", "honeycomb", "cubic", "triangles"].map((v) => ({ value: v, label: cap(v) }))],
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
    renderError((err as Error).message || "Couldn't save that preference.");
  }
}

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
ssSaveCustom.addEventListener("click", () => {
  const x = Number(ssBedX.value);
  const y = Number(ssBedY.value);
  const z = Number(ssBedZ.value);
  const n = Number(ssNozzle.value);
  if (![x, y, z].every((v) => Number.isFinite(v) && v > 0)) {
    renderError("Enter a valid bed size (X, Y, Z in mm) for the custom printer.");
    return;
  }
  void savePref({
    printer: { key: "custom", label: `Custom ${x}×${y}×${z}`, bed: { x, y, z }, nozzleMm: Number.isFinite(n) && n > 0 ? n : 0.4 },
  });
});
ssMaterial.addEventListener("change", () => void savePref({ material: (ssMaterial.value || null) as unknown as PrintPreferences["material"] }));
ssGoal.addEventListener("change", () => void savePref({ goal: (ssGoal.value || null) as unknown as PrintPreferences["goal"] }));
ssInfill.addEventListener("change", () => {
  const v = ssInfill.value.trim();
  void savePref({ fillDensityPct: (v === "" ? null : Number(v)) as unknown as PrintPreferences["fillDensityPct"] });
});
ssPattern.addEventListener("change", () => void savePref({ fillPattern: (ssPattern.value || null) as unknown as PrintPreferences["fillPattern"] }));
ssSupportStyle.addEventListener("change", () =>
  void savePref({ supportStyle: ssSupportStyle.value as unknown as PrintPreferences["supportStyle"] }),
);
ssBrimWidth.addEventListener("change", () => {
  const v = ssBrimWidth.value.trim();
  void savePref({ brimWidthMm: (v === "" ? null : Number(v)) as unknown as PrintPreferences["brimWidthMm"] });
});

// ── printers panel (settings sheet): connect, arm auto-start, control ──────

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

let multiUser = false;

async function refreshPrinters(): Promise<void> {
  try {
    const [printers, statuses] = await Promise.all([getJson<PrinterConnection[]>("/api/printers"), getJson<PrinterStatus[]>("/api/printers/status")]);
    printersCache = printers;
    renderPrinterList(printers, statuses);
    updateHeaderPrinterPill(printers, statuses);
    emitPrintersChanged();
  } catch {
    printerListEl.replaceChildren(makeText("p", "sheet-hint", "Printer connections aren't available on this server yet."));
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
    printerListEl.appendChild(makeText("p", "sheet-hint", "No printers added yet."));
    return;
  }
  for (const p of printers) {
    const status = statuses.find((s) => s.id === p.id);
    const row = make("div", "printer-row");

    const head = make("div", "printer-head");
    head.appendChild(make("span", `dot ${stateClass(status)}`));
    head.appendChild(makeText("span", "name", p.label));
    head.appendChild(makeText("span", "meta", `${p.transport} · ${stateLabel(status)}${p.id === selectedPrinterId ? " · active" : ""}`));
    row.appendChild(head);

    // Auto-start arming: off by default, deliberately worded as a hazard —
    // see buildSendButton() for how this changes the Send button's wording.
    const armRow = make("label", "printer-arm");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = armedPrinters.has(p.id);
    cb.onchange = () => {
      if (cb.checked) armedPrinters.add(p.id);
      else armedPrinters.delete(p.id);
      emitPrintersChanged();
      void postJson(`/api/printers/${encodeURIComponent(p.id)}/autostart`, { armed: cb.checked }).catch(() => undefined);
    };
    armRow.appendChild(cb);
    armRow.appendChild(document.createTextNode("Start prints automatically. Only enable this if you check the bed is clear first."));
    row.appendChild(armRow);

    const btns = make("div", "printer-actions");
    const useBtn = makeText("button", "btn ghost small", "Use") as HTMLButtonElement;
    useBtn.onclick = () => void selectPrinter(p.id);
    btns.appendChild(useBtn);
    const testBtn = makeText("button", "btn ghost small", "Test") as HTMLButtonElement;
    testBtn.onclick = () => void testPrinterAction(p.id, testBtn);
    btns.appendChild(testBtn);
    if (status && (status.state === "printing" || status.state === "paused")) {
      const pauseLabel = status.state === "paused" ? "Resume" : "Pause";
      const resumeAction = status.state === "paused" ? "resume" : "pause";
      const pauseBtn = makeText("button", "btn ghost small", pauseLabel) as HTMLButtonElement;
      pauseBtn.onclick = () => void controlPrinterAction(p.id, resumeAction);
      btns.appendChild(pauseBtn);
      const cancelBtn = makeText("button", "btn ghost small danger", "Cancel") as HTMLButtonElement;
      cancelBtn.onclick = () => void controlPrinterAction(p.id, "cancel");
      btns.appendChild(cancelBtn);
    }
    const rmBtn = makeText("button", "btn ghost small danger", "Remove") as HTMLButtonElement;
    rmBtn.onclick = () => void removePrinterAction(p.id);
    btns.appendChild(rmBtn);
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

async function testPrinterAction(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const original = btn.textContent ?? "Test";
  btn.textContent = "Testing…";
  try {
    const r = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(id)}/test`, {});
    toast(r.message, r.ok ? "ok" : "err");
  } catch (err) {
    toast((err as Error).message || "Test failed.", "err");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    await refreshPrinters();
  }
}

async function controlPrinterAction(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
  try {
    const r = await postJson<{ ok: boolean; message: string }>(`/api/printers/${encodeURIComponent(id)}/control`, { action });
    toast(r.message, r.ok ? "ok" : "err");
  } catch (err) {
    toast((err as Error).message || "Control failed.", "err");
  }
  await refreshPrinters();
}

async function removePrinterAction(id: string): Promise<void> {
  try {
    await fetch(`/api/printers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (selectedPrinterId === id) {
      selectedPrinterId = undefined;
      try {
        localStorage.removeItem("slicely:selectedPrinter");
      } catch {
        /* ignore */
      }
    }
    armedPrinters.delete(id);
  } catch (err) {
    toast((err as Error).message || "Couldn't remove printer.", "err");
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

/** Plain-language note about what each transport needs and can do, so the
 *  user is not left guessing why a printer won't connect. */
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

/**
 * Explain an empty scan. A stock Ender 3 / Ender 5 / most sub-$300 printers
 * have no Wi-Fi or Ethernet whatsoever, so a scan finding nothing is the
 * expected result rather than a fault — and the SD-card route is the real
 * answer for those machines, not a workaround.
 */
function showScanHelp(): void {
  discoveredEl.replaceChildren();
  const box = make("div", "scan-help");
  box.appendChild(makeText("div", "scan-help-title", "No printers answered on this network."));
  const list = document.createElement("ul");
  for (const line of [
    "Most printers have no network hardware, so there is nothing to find. Pick Type \u2192 \u201cFolder / SD card\u201d and print from the card.",
    "OctoPrint or Klipper: check the Pi is powered on and on this Wi-Fi, then add it by IP.",
    "Prusa MK4, XL, or MINI: turn on networking, then add the address from the printer's screen.",
    "Bambu: use Bambu Cloud with your account token, or LAN with the code on the printer's screen.",
  ]) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  box.appendChild(list);
  box.appendChild(
    makeText(
      "div",
      "scan-help-note",
      "Slicely still slices correctly either way. Pick your printer above so the estimates match.",
    ),
  );
  discoveredEl.appendChild(box);
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
    row.appendChild(makeText("label", "", secretLabel(secret)));
    const input = document.createElement("input");
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
    const res = await postJson<{ printer: PrinterConnection; test: { ok: boolean; message: string } }>("/api/printers", body);
    toast(res.test.message, res.test.ok ? "ok" : "err");
    addPrinterForm.classList.add("hidden");
    pLabel.value = "";
    pHost.value = "";
    pFolder.value = "";
    await refreshPrinters();
  } catch (err) {
    toast((err as Error).message || "Couldn't add that printer.", "err");
  } finally {
    pSave.disabled = false;
    pSave.textContent = original;
  }
}

interface DiscoveredPrinterLite {
  transport: string;
  host: string;
  port: number;
  label: string;
  needs?: string;
}

function renderDiscovered(found: DiscoveredPrinterLite[]): void {
  discoveredEl.replaceChildren();
  if (found.length === 0) return;
  discoveredEl.appendChild(makeText("div", "sheet-hint", `Found ${found.length} on your network`));
  for (const d of found) {
    const row = make("div", "printer-row found");
    row.appendChild(makeText("span", "name", d.label));
    row.appendChild(makeText("span", "meta", `${d.transport} · ${d.host}:${d.port}${d.needs ? ` · ${d.needs}` : ""}`));
    const add = makeText("button", "btn primary small", "Add") as HTMLButtonElement;
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
  try {
    const found = await getJson<DiscoveredPrinterLite[]>("/api/printers/discover");
    renderDiscovered(found);
    if (found.length === 0) {
      // "Nothing found" is usually not a failure — most budget printers have no
      // network hardware at all, so there is genuinely nothing to discover.
      // Say what to do next instead of leaving the user stuck.
      showScanHelp();
      toast("No networked printers found. See the note below.", "err");
    }
  } catch (err) {
    toast((err as Error).message || "Discovery unavailable.", "err");
  } finally {
    discoverBtn.textContent = original;
    discoverBtn.disabled = false;
  }
}

// ── model sources panel ─────────────────────────────────────────────────────

async function loadSources(): Promise<void> {
  try {
    const sources = await getJson<SourceAvailability[]>("/api/sources");
    renderSources(sources);
  } catch {
    sourcesListEl.replaceChildren(makeText("p", "sheet-hint", "Model sourcing isn't available on this server yet."));
  }
}

function renderSources(sources: SourceAvailability[]): void {
  sourcesListEl.replaceChildren();
  if (sources.length === 0) {
    sourcesListEl.appendChild(makeText("p", "sheet-hint", "No sources reported."));
    return;
  }
  for (const s of sources) {
    const row = make("div", "source-row");
    const cls = s.searchable && s.downloadable ? "ok" : s.searchable ? "warn" : "off";
    row.appendChild(make("span", `dot ${cls}`));
    const info = make("div", "info");
    const name = make("div", "name");
    name.appendChild(makeText("span", "", s.label));
    if (s.searchable) name.appendChild(makeText("span", "cap", "search"));
    if (s.downloadable) name.appendChild(makeText("span", "cap", "download"));
    info.appendChild(name);
    if (s.blockedReason) {
      const reason = make("div", "reason");
      reason.appendChild(document.createTextNode(`${s.blockedReason} `));
      if (s.setupUrl) {
        const link = document.createElement("a");
        link.href = s.setupUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Get one →";
        reason.appendChild(link);
      }
      info.appendChild(reason);
    }
    row.appendChild(info);
    sourcesListEl.appendChild(row);
  }
}

// ── status polling + config banner ──────────────────────────────────────────

async function loadStatus(): Promise<void> {
  try {
    const status = await getJson<SlicerStatus>("/api/status");
    applyStatus(status);
    bannerEl.classList.add("hidden");
  } catch {
    statusText.textContent = "unknown";
    bannerEl.textContent = "Can't reach the Slicely server. Check your connection.";
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

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files) void uploadFiles(fileInput.files);
  fileInput.value = "";
});

linkBtn.addEventListener("click", () => {
  linkRow.classList.toggle("hidden");
  if (!linkRow.classList.contains("hidden")) linkInput.focus();
});
linkGo.addEventListener("click", () => void handleLinkGo());
linkInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void handleLinkGo();
});

// Model + effort dropdowns: each trigger toggles its own menu; both close on
// outside-click or Escape (mirrors the Electron composer exactly).
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

const scrim = byId<HTMLElement>("scrim");
const chatsSheet = byId<HTMLElement>("chatsSheet");
const chatsList = byId<HTMLElement>("chatsList");

/** Show exactly one sheet (or none), keeping the scrim in step. */
function showSheet(which: "settings" | "jobs" | "chats" | null): void {
  settingsSheet.classList.toggle("hidden", which !== "settings");
  jobsSheet.classList.toggle("hidden", which !== "jobs");
  chatsSheet.classList.toggle("hidden", which !== "chats");
  scrim.classList.toggle("hidden", which === null);
}

scrim.addEventListener("click", () => showSheet(null));

settingsBtn.addEventListener("click", () => {
  const willOpen = settingsSheet.classList.contains("hidden");
  showSheet(willOpen ? "settings" : null);
  if (willOpen) {
    renderPreferences();
    void refreshPrinters();
    void loadSources();
  }
});
// The printer pill in the header is a shortcut into the same settings sheet
// (which is where printers are picked/managed) rather than a second menu.
printerPill.addEventListener("click", () => settingsBtn.click());

// Close buttons on each sheet — a sheet that covers the chat needs an obvious
// way out, not just a second press on the icon that opened it.
interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
}

/** Human-friendly age, so the list reads at a glance. */
function whenLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshChats(): Promise<void> {
  chatsList.replaceChildren();
  try {
    const data = await getJson<{ chats: ChatSummary[]; activeId?: string }>("/api/chats");
    if (data.chats.length === 0) {
      const empty = make("div", "note");
      empty.textContent = "No saved chats yet. This one will appear here once you send a message.";
      chatsList.appendChild(empty);
      return;
    }
    for (const c of data.chats) {
      const row = make("div", "chat-row");
      if (c.id === data.activeId) row.classList.add("active");
      row.appendChild(makeText("span", "chat-title", c.title));
      row.appendChild(makeText("span", "chat-meta", whenLabel(c.updatedAt)));
      const del = document.createElement("button");
      del.className = "chat-del";
      del.textContent = "×";
      del.title = "Delete this chat";
      del.onclick = (e) => {
        e.stopPropagation();
        void fetch(`/api/chats/${encodeURIComponent(c.id)}`, { method: "DELETE" })
          .then(() => refreshChats());
      };
      row.appendChild(del);
      row.onclick = () => void openChat(c.id);
      chatsList.appendChild(row);
    }
  } catch {
    const err = make("div", "note");
    err.textContent = "Couldn't load your chats.";
    chatsList.appendChild(err);
  }
}

/** Reopen a saved conversation: redraw its turns and continue it. */
async function openChat(id: string): Promise<void> {
  try {
    const chat = await getJson<{ id: string; title: string; turns: Array<{ role: string; text: string }> }>(
      `/api/chats/${encodeURIComponent(id)}`,
    );
    clearTranscript();
    for (const t of chat.turns) {
      if (t.role === "user") {
        addUserMessage(t.text);
      } else {
        // Reuse the streaming path so a restored reply gets the same markdown
        // rendering as a live one, then close the bubble.
        appendBotText(t.text);
        endBotBubble();
      }
    }
    showSheet(null);
    scrollToBottom();
  } catch {
    renderError("Couldn't open that chat.");
  }
}

/** Empty the visible transcript. The model's memory is cleared server-side. */
function clearTranscript(): void {
  messagesEl.replaceChildren();
  activeChips.clear();
  seenInfoPaths.clear();
  endBotBubble();
}

byId<HTMLButtonElement>("chatsBtn").addEventListener("click", () => {
  const willOpen = chatsSheet.classList.contains("hidden");
  showSheet(willOpen ? "chats" : null);
  if (willOpen) void refreshChats();
});
byId<HTMLButtonElement>("chatsClose").addEventListener("click", () => showSheet(null));
byId<HTMLButtonElement>("newChatBtn").addEventListener("click", () => {
  void (async () => {
    try {
      await postJson("/api/chats", {});
      clearTranscript();
      showEmptyState();
      showSheet(null);
    } catch {
      renderError("Couldn't start a new chat.");
    }
  })();
});

byId<HTMLButtonElement>("settingsClose").addEventListener("click", () => showSheet(null));
byId<HTMLButtonElement>("jobsClose").addEventListener("click", () => showSheet(null));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  showSheet(null);
});

// "Fine tuning" disclosure. Collapsed by default so the sheet opens as three
// decisions rather than eleven; Slicely derives all of these per model anyway.
const advToggle = byId<HTMLButtonElement>("advToggle");
const advFields = byId<HTMLElement>("advFields");
advToggle.addEventListener("click", () => {
  const open = advFields.classList.toggle("hidden");
  advToggle.setAttribute("aria-expanded", open ? "false" : "true");
});

jobsBtn.addEventListener("click", () => {
  const willOpen = jobsSheet.classList.contains("hidden");
  showSheet(willOpen ? "jobs" : null);
  if (willOpen) void refreshJobsList();
});
jobsRefreshBtn.addEventListener("click", () => void refreshJobsList());

addPrinterBtn.addEventListener("click", () => addPrinterForm.classList.toggle("hidden"));
pTransport.addEventListener("change", renderSecretFields);
pSave.addEventListener("click", () => void connectPrinter());
discoverBtn.addEventListener("click", () => void discoverPrintersAction());
sourcesRefreshBtn.addEventListener("click", () => void loadSources());

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
  p.appendChild(document.createTextNode(", slice it, and print. Right from your phone."));
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
void loadSettings();
// The header pill must know about a connected printer on load. Previously
// printers were only fetched while the settings sheet was OPEN, so the header
// read "No printer" until you happened to open settings — even with one
// connected and working.
void refreshPrinters();
setInterval(() => void loadStatus(), 15000);
setInterval(() => {
  // Poll faster while the printer list is on screen, but keep the header
  // honest either way.
  void refreshPrinters();
}, settingsSheet.classList.contains("hidden") ? 15000 : 6000);
