// ─────────────────────────────────────────────────────────────────────────────
// chat.ts — the transcript and the composer.
//
// This module owns #messages: every other module that wants something on
// screen calls mount() here rather than reaching for the element itself. It
// also owns one turn's lifecycle — the streamed AgentEvents, the activity
// strip, the staged uploads, the paste-a-link row.
//
// The chat stream and the job stream share api.ts's streamSse(); there is no
// second SSE parser anywhere in the client.
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentEvent, ModelInfo, SliceMetrics, SlicerStatus, UploadResult } from "../shared/types";
import type { PrintJob } from "../shared/jobs";
import type { SearchOutcome, UrlResolution } from "../shared/sourcing";
import type { JobPanel, WireJob, WireJobEvent } from "./jobs.js";
import { ApiError, del, getJson, postForm, postJson, streamSse } from "./api.js";
import {
  buildCards,
  buildSourcesNote,
  formatBytes,
  friendlyError,
  panelHead,
  renderInfo,
  renderMetrics,
  resetSeenInfo,
  type CardLike,
  type SendMount,
} from "./cards.js";
import { byId, closeSheets, externalLink, make } from "./ui.js";
import { renderMarkdownLite } from "./markdown.js";

export interface ChatDeps {
  /** Live job panels, owned by jobs.ts and injected so the two transcript
   *  writers don't have to import each other at runtime. */
  jobPanel(id: string, seed?: WireJob): JobPanel;
  /** Plan a multi-part job from the staged files. Resolves true when a job was
   *  planned — only then is the tray cleared. */
  planStagedJob(files: UploadResult[]): Promise<boolean>;
  /** Mount a live "Send to printer" button (printers.ts). */
  mountSend: SendMount;
  /** A `status` AgentEvent arrived — the header/banner belong to app.ts. */
  onStatus(status: SlicerStatus): void;
  /** The transcript's empty state. */
  buildEmptyState(): HTMLElement;
  /** False when there is no Anthropic key yet: chatting is impossible, though
   *  search and paste-a-link still work without one. */
  canChat(): boolean;
  /** Something needs a key — returns the card to drop into the transcript. */
  buildKeyPrompt(code: string): HTMLElement;
}

export interface ChatApi {
  send(text: string): Promise<void>;
  cancel(): void;
  handleAgentEvent(e: AgentEvent): void;
}

let deps: ChatDeps;
let messagesEl: HTMLElement;
let inputEl: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let attachTray: HTMLElement;
let linkRow: HTMLElement;
let linkInput: HTMLInputElement;
let chatsList: HTMLElement;

// ── transcript state ─────────────────────────────────────────────────────────

let busy = false;
let currentAbort: AbortController | undefined;
let activeBotBubble: HTMLElement | null = null;
let activeBotRaw = "";
let activeThinkingBody: HTMLElement | null = null;
let activeThinkingRaw = "";
let renderFrame = 0;

export function clearEmptyState(): void {
  messagesEl.querySelector(".empty")?.remove();
}

export function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Put something in the transcript. The one door into #messages. */
export function mount(el: HTMLElement): void {
  clearEmptyState();
  messagesEl.appendChild(el);
  scrollToBottom();
}

export function showEmptyState(): void {
  messagesEl.appendChild(deps.buildEmptyState());
}

export function addUserMessage(text: string): void {
  clearEmptyState();
  const wrap = make("div", "msg user enter");
  wrap.appendChild(make("div", "bubble", text));
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
    const details = make("details", "thinking enter");
    const summary = make("summary", "", "Thinking…");
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

export function endBotBubble(): void {
  finishThinking();
  finishStreaming();
  activeBotBubble = null;
  activeBotRaw = "";
}

/** Empty the visible transcript. The model's memory is cleared server-side. */
export function clearTranscript(): void {
  messagesEl.replaceChildren();
  activity = undefined;
  resetSeenInfo();
  endBotBubble();
}

// ── the activity strip ───────────────────────────────────────────────────────

/**
 * The running steps of one turn, as a single line.
 *
 * Every step used to append its own chip, so a routine "find something and
 * slice it" left six or seven stacked status lines around the parts the user
 * actually wanted — the models, the numbers, the answer. They now share one
 * strip that shows the current step and folds the finished ones behind a
 * count, which the user can open if they want the detail.
 *
 * Failures are the exception: a step that went wrong is pulled out and left on
 * screen, because that is the one the user needs to see.
 */
interface Activity {
  root: HTMLElement;
  current: HTMLElement;
  steps: HTMLElement;
  toggle: HTMLButtonElement;
  count: number;
}

let activity: Activity | undefined;

function getActivity(): Activity {
  if (activity?.root.isConnected) return activity;
  endBotBubble();
  const root = make("div", "activity enter");
  const line = make("div", "activity-line");
  const spin = make("span", "spin");
  spin.setAttribute("aria-hidden", "true");
  line.appendChild(spin);
  const current = make("span", "activity-current", "Working…");
  const toggle = make("button", "activity-toggle hidden", "");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const steps = make("div", "activity-steps hidden");
  toggle.onclick = () => {
    const collapsed = steps.classList.toggle("hidden");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? `${activity?.count ?? 0} steps` : "hide";
  };
  line.append(current, toggle);
  root.append(line, steps);
  messagesEl.appendChild(root);
  activity = { root, current, steps, toggle, count: 0 };
  return activity;
}

function addActivityStep(icon: string, label: string): void {
  const a = activity?.root.isConnected ? activity : undefined;
  if (!a) return;
  const step = make("div", "activity-step");
  const ico = make("span", "ico", icon);
  ico.setAttribute("aria-hidden", "true");
  step.appendChild(ico);
  step.appendChild(make("span", "", label));
  a.steps.appendChild(step);
  a.count += 1;
  a.toggle.classList.remove("hidden");
  if (a.steps.classList.contains("hidden")) a.toggle.textContent = `${a.count} steps`;
}

function startToolChip(label: string): void {
  getActivity().current.textContent = label;
  scrollToBottom();
}

/** Update the running step's text, so a long tool visibly moves. */
function updateToolChip(label: string): void {
  if (activity?.root.isConnected) activity.current.textContent = label;
}

function endToolChip(ok: boolean, summary?: string): void {
  const a = activity?.root.isConnected ? activity : undefined;
  if (!a) return;
  const label = a.current.textContent ?? "";

  if (!ok) {
    // Keep a failure where the user can see it, with the fix beside it.
    const friendly = summary ? friendlyError(summary) : { what: "That didn't work.", fix: undefined };
    const chip = make("div", "tool-chip done err enter");
    chip.appendChild(make("span", "ico", "✕"));
    chip.appendChild(make("span", "", friendly.fix ? `${friendly.what} ${friendly.fix}` : friendly.what));
    messagesEl.appendChild(chip);
  } else if (label) {
    addActivityStep("✓", label);
  }
  a.current.textContent = "Working…";
}

/** Settle the strip when the turn ends: no spinner, and a plain summary of
 *  what was done rather than a stale "Working…". */
function finishActivity(): void {
  if (!activity?.root.isConnected) {
    activity = undefined;
    return;
  }
  activity.root.querySelector(".spin")?.remove();
  if (activity.count === 0) activity.root.remove();
  else {
    activity.current.textContent = activity.count === 1 ? "Done · 1 step" : `Done · ${activity.count} steps`;
    activity.toggle.textContent = activity.steps.classList.contains("hidden") ? "show" : "hide";
  }
  activity = undefined;
}

// ── failures in the transcript ───────────────────────────────────────────────

export function renderError(message: string): void {
  endBotBubble();
  const wrap = make("div", "msg bot enter");
  const bubble = make("div", "bubble");
  bubble.style.color = "#fecaca";
  bubble.textContent = `⚠ ${message}`;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// ── AgentEvent handling ──────────────────────────────────────────────────────

function renderAgentAction(action: { label: string; kind: string; href?: string; hint?: string }): void {
  endBotBubble();
  if (!action.href) return;
  const row = make("div", "action-row enter");
  const btn = externalLink(action.href, action.label);
  btn.className = "btn primary small";
  if (action.kind === "open-project") {
    // A download, not a navigation — keep the tab the user is working in.
    (btn as HTMLAnchorElement).target = "_self";
    (btn as HTMLAnchorElement).setAttribute("download", "");
  }
  row.appendChild(btn);
  if (action.hint) row.appendChild(make("span", "action-hint", action.hint));
  mount(row);
}

function renderResolution(resolution: UrlResolution): void {
  endBotBubble();
  const panel = make("div", "panel enter");
  panel.appendChild(panelHead("🔗", resolution.kind));
  panel.appendChild(make("div", "", resolution.message));
  if (resolution.model) {
    const actions = make("div", "actions");
    const importBtn = make("button", "btn primary small", "Import");
    importBtn.type = "button";
    const modelUrl = resolution.model.webUrl;
    const modelTitle = resolution.model.title;
    importBtn.onclick = () => void importFromUrl(modelUrl, modelTitle);
    actions.appendChild(importBtn);
    panel.appendChild(actions);
  }
  mount(panel);
}

function showCards(models: CardLike[]): void {
  endBotBubble();
  const row = buildCards(models, (m) =>
    void sendInstruction(
      `Import "${m.title}"`,
      `Import the ${m.source} model id ${m.id} ("${m.title}"), then report its dimensions and recommend optimal slicing settings.`,
    ),
  );
  if (row) mount(row);
}

function showInfo(info: ModelInfo): void {
  endBotBubble();
  const panel = renderInfo(info);
  if (panel) mount(panel);
}

function showMetrics(m: SliceMetrics, gcodeId?: string): void {
  endBotBubble();
  mount(renderMetrics(m, gcodeId, deps.mountSend));
}

function renderDownloadNote(source: string, fileName: string): void {
  const note = `Downloaded ${fileName} from ${source}`;
  // Fold into the turn's activity rather than adding a chip of its own. A
  // multi-part model downloads part after part, and each one used to leave its
  // own line between the user and the result.
  if (activity?.root.isConnected) {
    addActivityStep("⬇", note);
    return;
  }
  endBotBubble();
  const chip = make("div", "tool-chip done enter");
  chip.appendChild(make("span", "ico", "⬇"));
  chip.appendChild(make("span", "", note));
  mount(chip);
}

export function handleAgentEvent(raw: AgentEvent | Record<string, unknown>): void {
  const event = raw as AgentEvent & {
    code?: string;
    gcodeId?: string;
    outcome?: SearchOutcome;
    resolution?: UrlResolution;
    job?: PrintJob;
    event?: unknown;
  };
  switch (event.type) {
    case "text":
      appendBotText(event.text);
      break;
    case "thinking":
      appendThinking(event.text);
      break;
    case "tool_progress":
      updateToolChip(event.label);
      break;
    case "tool_start":
      startToolChip(event.label);
      break;
    case "tool_end":
      endToolChip(event.ok, event.summary);
      break;
    case "models":
      showCards(event.models as unknown as CardLike[]);
      break;
    case "search":
      if (event.outcome) {
        showCards(event.outcome.results as unknown as CardLike[]);
        const note = buildSourcesNote(event.outcome.sources);
        if (note) mount(note);
      }
      break;
    case "resolved":
      if (event.resolution) renderResolution(event.resolution);
      break;
    case "download":
      renderDownloadNote(event.model.source, event.result.fileName);
      break;
    case "info":
      showInfo(event.info);
      break;
    case "metrics":
      showMetrics(event.metrics, event.gcodeId);
      break;
    case "status":
      deps.onStatus(event.status);
      break;
    case "job":
      if (event.job) deps.jobPanel(event.job.id, event.job as WireJob);
      break;
    case "job_progress":
      if (event.event) {
        const ev = event.event as WireJobEvent;
        const id = ev.type === "job_planned" || ev.type === "job_done" ? ev.job.id : ev.jobId;
        deps.jobPanel(id).applyEvent(ev);
      }
      break;
    case "action":
      renderAgentAction(event as unknown as { label: string; kind: string; href?: string; hint?: string });
      break;
    case "error":
      // A key problem is not a message to read and move on from — it is the one
      // thing standing between the user and an answer, so the card comes with it.
      if (event.code === "no_key" || event.code === "key_rejected") promptForKey(event.code, event.message);
      else renderError(event.message);
      break;
    case "done":
      endBotBubble();
      finishActivity();
      setBusy(false);
      resetSeenInfo();
      break;
    default:
      break; // unrecognised v2 event types — safe to ignore
  }
  scrollToBottom();
}

// ── send / cancel ────────────────────────────────────────────────────────────

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.classList.toggle("hidden", b);
  stopBtn.classList.toggle("hidden", !b);
  updateSendEnabled();
}

export function updateSendEnabled(): void {
  sendBtn.disabled = busy || (inputEl.value.trim().length === 0 && stagedFiles.length === 0);
  // Never disabled for want of a key: search and paste-a-link work without one,
  // and a dead button explains nothing. Pressing it opens the key card instead.
  const label = deps.canChat() ? "Send" : "Connect a key to chat";
  sendBtn.title = label;
  sendBtn.setAttribute("aria-label", label);
}

/** Drop the key card into the transcript and point the user at it. */
function promptForKey(code: string, message?: string): void {
  endBotBubble();
  if (message) renderError(message);
  mount(deps.buildKeyPrompt(code));
  messagesEl.querySelector<HTMLInputElement>(".key-prompt .key-input")?.focus();
}

async function runTurn(instruction: string): Promise<void> {
  if (busy) return;
  if (!deps.canChat()) {
    promptForKey("no_key");
    return;
  }
  setBusy(true);
  endBotBubble();
  currentAbort = new AbortController();
  try {
    await streamSse("/api/chat", { message: instruction }, handleAgentEvent, currentAbort.signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      /* the user pressed Stop — nothing to report */
    } else if (err instanceof ApiError && (err.code === "no_key" || err.code === "key_rejected")) {
      promptForKey(err.code, err.message);
    } else {
      renderError((err as Error).message || String(err));
    }
  } finally {
    setBusy(false);
    currentAbort = undefined;
  }
}

export async function sendInstruction(displayText: string, instruction: string): Promise<void> {
  if (busy) return;
  addUserMessage(displayText);
  await runTurn(instruction);
}

function cancelTurn(): void {
  currentAbort?.abort();
  void fetch("/api/chat/cancel", { method: "POST" }).catch(() => undefined);
}

// ── uploads: stage-on-drop, act-on-send ──────────────────────────────────────
// Staged files can go two ways: sent along with the next chat message (a single
// active model, inspected/sliced conversationally), or planned as a multi-part
// JOB via the button that appears in the tray once >=1 file is staged.

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
    chip.appendChild(make("span", "name", f.fileName));
    const rm = make("button", "", "×");
    rm.type = "button";
    rm.title = `Remove ${f.fileName}`;
    rm.setAttribute("aria-label", `Remove ${f.fileName}`);
    rm.onclick = () => removeStaged(f.localPath);
    chip.appendChild(rm);
    chipRow.appendChild(chip);
  }
  attachTray.appendChild(chipRow);

  const planBtn = make(
    "button",
    "btn small primary",
    stagedFiles.length > 1 ? `Plan print job (${stagedFiles.length} parts)` : "Plan print job",
  );
  planBtn.type = "button";
  planBtn.onclick = () => {
    const files = stagedFiles.slice();
    void deps.planStagedJob(files).then((planned) => {
      if (!planned) return;
      stagedFiles.length = 0;
      renderAttachTray();
      updateSendEnabled();
    });
  };
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
    const data = await postForm<{ uploaded?: UploadResult[]; rejected?: string[] }>("/api/upload", fd);
    stageResults(data.uploaded ?? []);
    if (data.rejected && data.rejected.length > 0) {
      renderError(`Not accepted: ${data.rejected.join(", ")}`);
    }
  } catch (err) {
    renderError((err as Error).message || "Upload failed");
  }
}

function renderUploadChip(r: UploadResult): void {
  const chip = make("div", "tool-chip done enter");
  const ico = make("span", "ico", "📦");
  ico.setAttribute("aria-hidden", "true");
  chip.appendChild(ico);
  chip.appendChild(make("span", "", `Added ${r.fileName} (${formatBytes(r.sizeBytes)})`));
  messagesEl.appendChild(chip);
}

/** Compose the message sent to the agent from the user's text + staged files. */
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
  if (!deps.canChat()) {
    promptForKey("no_key");
    return;
  }
  clearEmptyState();

  const display = files.length > 0
    ? text || (files.length === 1 ? `Attached ${files[0].fileName}` : `Attached ${files.length} files`)
    : text;
  addUserMessage(display);
  if (files.length > 0) {
    for (const f of files) renderUploadChip(f);
    stagedFiles.length = 0;
    renderAttachTray();
  }

  inputEl.value = "";
  inputEl.style.height = "auto";
  updateSendEnabled();
  void runTurn(files.length > 0 ? buildAttachmentInstruction(text, files) : text);
}

// ── paste-a-link OR search directly ──────────────────────────────────────────
// One row does both jobs: a URL resolves via /api/resolve, anything else runs a
// direct federated search via GET /api/search (no chat turn, so no key needed).

function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (t.includes(" ")) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^www\./i.test(t)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t);
}

/** A spinner line while a non-chat request runs. */
function pendingChip(label: string): HTMLElement {
  const chip = make("div", "tool-chip enter");
  const spin = make("span", "spin");
  spin.setAttribute("aria-hidden", "true");
  chip.appendChild(spin);
  chip.appendChild(make("span", "", label));
  mount(chip);
  return chip;
}

async function resolveLink(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;
  endBotBubble();
  const chip = pendingChip("Resolving link…");
  try {
    const resolution = await postJson<UrlResolution>("/api/resolve", { url: trimmed });
    chip.remove();
    renderResolution(resolution);
    if (!resolution.model && resolution.files.length === 0) {
      // Nothing structured came back — still worth trying an import directly (a
      // raw mesh URL resolves straight to a file with no "model" wrapper).
      await importFromUrl(trimmed, trimmed);
    }
  } catch (err) {
    chip.remove();
    renderError((err as Error).message || "Couldn't resolve that link.");
  }
}

async function runDirectSearch(query: string): Promise<void> {
  endBotBubble();
  const chip = pendingChip(`Searching for "${query}"…`);
  try {
    const outcome = await getJson<SearchOutcome>(`/api/search?q=${encodeURIComponent(query)}`);
    chip.remove();
    if (outcome.results.length === 0) renderError(`No results for "${query}".`);
    else showCards(outcome.results as unknown as CardLike[]);
    const note = buildSourcesNote(outcome.sources);
    if (note) mount(note);
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

/** Reopen a saved conversation: redraw its turns and continue it. */
export async function openChat(id: string): Promise<void> {
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
    closeSheets();
    scrollToBottom();
  } catch (err) {
    renderError((err as Error).message || "Couldn't open that chat.");
  }
}

// ── the chats sheet (saved conversations) ────────────────────────────────────

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

export async function refreshChats(): Promise<void> {
  chatsList.replaceChildren();
  try {
    const data = await getJson<{ chats: ChatSummary[]; activeId?: string }>("/api/chats");
    if (data.chats.length === 0) {
      chatsList.appendChild(
        make("div", "note", "No saved chats yet. This one will appear here once you send a message."),
      );
      return;
    }
    for (const c of data.chats) {
      const row = make("div", "chat-row");
      if (c.id === data.activeId) row.classList.add("active");
      row.appendChild(make("span", "chat-title", c.title));
      row.appendChild(make("span", "chat-meta", whenLabel(c.updatedAt)));
      const delBtn = make("button", "chat-del", "×");
      delBtn.type = "button";
      delBtn.title = "Delete this chat";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        void deleteChat(c.id);
      };
      row.appendChild(delBtn);
      row.onclick = () => void openChat(c.id);
      chatsList.appendChild(row);
    }
  } catch {
    chatsList.appendChild(make("div", "note", "Couldn't load your chats."));
  }
}

async function deleteChat(id: string): Promise<void> {
  try {
    await del(`/api/chats/${encodeURIComponent(id)}`);
  } catch {
    /* the refresh below shows whether it actually went */
  }
  await refreshChats();
}

async function startNewChat(): Promise<void> {
  try {
    await postJson("/api/chats", {});
    clearTranscript();
    showEmptyState();
    closeSheets();
  } catch {
    renderError("Couldn't start a new chat.");
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function initChat(d: ChatDeps): ChatApi {
  deps = d;
  messagesEl = byId<HTMLElement>("messages");
  inputEl = byId<HTMLTextAreaElement>("input");
  sendBtn = byId<HTMLButtonElement>("send");
  stopBtn = byId<HTMLButtonElement>("stop");
  attachTray = byId<HTMLElement>("attachTray");
  linkRow = byId<HTMLElement>("linkRow");
  linkInput = byId<HTMLInputElement>("linkInput");
  chatsList = byId<HTMLElement>("chatsList");
  const attachBtn = byId<HTMLButtonElement>("attachBtn");
  const fileInput = byId<HTMLInputElement>("fileInput");
  const linkBtn = byId<HTMLButtonElement>("linkBtn");
  const linkGo = byId<HTMLButtonElement>("linkGo");
  const dropzone = byId<HTMLElement>("dropzone");

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
    const opening = linkRow.classList.contains("hidden");
    linkRow.classList.toggle("hidden", !opening);
    linkBtn.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) linkInput.focus();
  });
  linkGo.addEventListener("click", () => void handleLinkGo());
  linkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleLinkGo();
  });

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

  byId<HTMLButtonElement>("newChatBtn").addEventListener("click", () => void startNewChat());

  updateSendEnabled();

  return {
    send: (text: string) => sendInstruction(text, text),
    cancel: cancelTurn,
    handleAgentEvent,
  };
}
