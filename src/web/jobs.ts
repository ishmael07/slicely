// ─────────────────────────────────────────────────────────────────────────────
// jobs.ts — multi-part, multi-plate print jobs.
//
// A job panel is created once (from a plan result, a chat "job" snapshot, or a
// /api/jobs/:id lookup) and then mutated in place as JobEvents arrive — via the
// SAME streamSse() helper used for chat — so the plate list, totals and
// warnings update live instead of spamming a new panel per event.
// ─────────────────────────────────────────────────────────────────────────────
import type { SliceMetrics, UploadResult } from "../shared/types";
import type { JobPlate, PrintJob } from "../shared/jobs";
import { getJson, postJson, streamSse } from "./api.js";
import { addMetric, attachViewer, errorBlock, formatMinutes, panelHead, type SendMount } from "./cards.js";
import { byId, closeSheets, errorCard, make, skeleton } from "./ui.js";
import { clearEmptyState, endBotBubble, mount, renderError, scrollToBottom } from "./chat.js";

/** Wire-level widening: routes/jobs.ts attaches a `gcodeId` to each plate (on
 *  job_planned/job_done) or to the event itself (on plate_done) once it has
 *  relocated that plate's G-code into this session's own registry. Chat-driven
 *  "job"/"job_progress" AgentEvents do NOT get this treatment — their plates
 *  simply never carry a gcodeId, so no Send/Download button renders for them.
 *  That is deliberate: without an id, the server has no offline-safe way to
 *  name that file. */
export type WirePlate = JobPlate & { gcodeId?: string };
export type WireJob = Omit<PrintJob, "plates"> & { plates: WirePlate[] };
export type WireJobEvent =
  | { type: "job_planned"; job: WireJob }
  | { type: "plate_start"; jobId: string; plateIndex: number }
  | { type: "plate_done"; jobId: string; plateIndex: number; metrics: SliceMetrics; gcodeId?: string }
  | { type: "plate_failed"; jobId: string; plateIndex: number; error: string }
  | { type: "job_done"; job: WireJob }
  | { type: "job_failed"; jobId: string; error: string };

export interface JobPanel {
  el: HTMLElement;
  setJob(job: WireJob): void;
  applyEvent(ev: WireJobEvent): void;
}

export interface JobsDeps {
  /** Mounts a live "Send to printer" button (printers.ts). */
  mountSend: SendMount;
  /** The slice defaults a new job is planned with (settings.ts). */
  planOptions(): { bed: { x: number; y: number; z: number }; goal?: string; material?: string };
}

let deps: JobsDeps;
let jobsListEl: HTMLElement;

function placeholderJob(id: string): PrintJob {
  const now = new Date().toISOString();
  return { id, name: id, createdAt: now, updatedAt: now, status: "slicing", plates: [], params: {}, goal: "quality", material: "PLA", notes: [] };
}

/** First-write-wins: routes/jobs.ts's job_done handler redundantly re-adopts a
 *  plate's G-code that plate_done already relocated, and the second adoption
 *  can land on a dead path (the source was already moved by the first one) — a
 *  real server-side quirk verified live. Keeping only the FIRST gcodeId seen
 *  per plate avoids ever downgrading a good, downloadable id to a later broken
 *  one for the same plate. */
function mergeGcodeIds(store: Map<number, string>, job: WireJob, projects?: Map<number, string>): void {
  for (const p of job.plates) {
    if (p.gcodeId && !store.has(p.index)) store.set(p.index, p.gcodeId);
    const projectId = (p as { projectId?: string }).projectId;
    if (projects && projectId && !projects.has(p.index)) projects.set(p.index, projectId);
  }
}

function updatePlate(job: PrintJob, index: number, fn: (p: JobPlate) => JobPlate): PrintJob {
  return { ...job, plates: job.plates.map((p) => (p.index === index ? fn(p) : p)) };
}

function buildPlateRow(plate: JobPlate, gcodeId: string | undefined, projectId?: string): HTMLElement {
  const row = make("div", "plate-row");
  row.appendChild(make("span", `status-dot ${plate.status}`));
  const label = make("div", "label");
  label.appendChild(make("div", "name", `Plate ${plate.index} — ${plate.parts.length} part(s)`));
  // A failed plate gets its own block below, not a raw error crammed into the
  // one-line summary where it wraps into an unreadable slab.
  const sub = plate.metrics?.estimatedPrintTime
    ? `${plate.status} · ${plate.metrics.estimatedPrintTime}${plate.metrics.filamentUsedG !== undefined ? ` · ${plate.metrics.filamentUsedG.toFixed(1)} g` : ""}`
    : plate.status;
  label.appendChild(make("div", "sub", sub));
  // Which filament this plate needs. When colours are grouped one-per-plate,
  // this is the whole point: you have to know what to load before each plate.
  if (plate.colours.length > 0) {
    const swatches = make("div", "plate-colours");
    for (const c of plate.colours) {
      const dot = make("span", "swatch");
      dot.style.background = c;
      dot.title = c;
      swatches.appendChild(dot);
    }
    swatches.appendChild(
      make(
        "span",
        "swatch-label",
        plate.colours.length === 1 ? `load ${plate.colours[0]}` : `${plate.colours.length} colours`,
      ),
    );
    label.appendChild(swatches);
  }
  if (plate.status === "failed" && plate.error) label.appendChild(errorBlock(plate.error));
  row.appendChild(label);
  if (gcodeId) {
    const btns = make("div", "btns");
    const dl = make("a", "btn small", "G-code");
    dl.href = `/api/gcode/${encodeURIComponent(gcodeId)}`;
    btns.appendChild(dl);
    if (projectId) {
      // Opens in PrusaSlicer showing the arrangement, orientations and colours
      // as planned — a browser cannot launch the app, but it can hand over the
      // project that does.
      const proj = make("a", "btn small", "Open in PrusaSlicer");
      proj.title = "Download the .3mf project — arranged, oriented and coloured as planned";
      proj.href = `/api/gcode/${encodeURIComponent(projectId)}`;
      btns.appendChild(proj);
    }
    deps.mountSend(btns, gcodeId, "small");
    row.appendChild(btns);
  }
  return row;
}

function createJobPanel(initial: WireJob): JobPanel {
  const gcodeIds = new Map<number, string>();
  const projectIds = new Map<number, string>();
  let job: PrintJob = initial;
  mergeGcodeIds(gcodeIds, initial, projectIds);

  const panel = make("div", "panel enter");

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

    // Show the PLATE — every part, in the pose and position it will print in. A
    // job that says "Slicing plate 1…" for two minutes with nothing to look at
    // feels stalled, and the arrangement is the thing worth checking before
    // committing hours of printing.
    if (job.plates.length > 0) {
      attachViewer(panel, undefined, `/api/jobs/${encodeURIComponent(job.id)}/plate/1/preview`);
    }

    const list = make("div", "plate-list");
    for (const plate of job.plates) {
      list.appendChild(buildPlateRow(plate, gcodeIds.get(plate.index), projectIds.get(plate.index)));
    }
    panel.appendChild(list);

    if (job.colourPlan && job.colourPlan.warnings.length > 0) {
      panel.appendChild(make("div", "fix-note", `🎨 ${job.colourPlan.warnings.join(" ")}`));
    }
    if (job.oversized && job.oversized.length > 0) {
      panel.appendChild(
        make("div", "job-warn", `⚠ Too large for the bed. Scale down: ${job.oversized.map((p) => p.name).join(", ")}`),
      );
    }
    if (job.notes.length > 0) {
      // One line per note. Joined with spaces these ran together into a wall of
      // text where nothing could be picked out — and per-part orientation notes
      // are exactly the kind of thing a reader scans rather than reads.
      const details = make("details", "job-notes");
      details.appendChild(
        make("summary", "", job.notes.length === 1 ? "1 note" : `${job.notes.length} notes about this plan`),
      );
      const ul = make("ul");
      for (const note of job.notes) ul.appendChild(make("li", "", note));
      details.appendChild(ul);
      panel.appendChild(details);
    }

    // Don't offer "Run job" while it is already running. job.status stays
    // "planned" until the last plate finishes, so the button sat there through
    // the whole slice inviting a second run of the same work.
    const running = job.plates.some((p) => p.status === "slicing");
    if (!running && (job.status === "planned" || job.status === "failed")) {
      const actions = make("div", "actions");
      const runBtn = make("button", "btn primary small", job.status === "failed" ? "Retry job" : "Run job");
      runBtn.type = "button";
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
    mergeGcodeIds(gcodeIds, j, projectIds);
    job = j;
    render();
  }

  function applyEvent(ev: WireJobEvent): void {
    switch (ev.type) {
      case "job_planned":
        mergeGcodeIds(gcodeIds, ev.job, projectIds);
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
        mergeGcodeIds(gcodeIds, ev.job, projectIds);
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
export function getJobPanel(id: string, seed?: WireJob): JobPanel {
  let panel = jobPanels.get(id);
  if (!panel) {
    panel = createJobPanel(seed ?? placeholderJob(id));
    jobPanels.set(id, panel);
    endBotBubble();
    clearEmptyState();
    mount(panel.el);
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

/** Plan a job from the files staged in the composer tray. Resolves true when a
 *  job was actually planned, so the caller knows whether to clear the tray. */
export async function planStagedJob(files: UploadResult[]): Promise<boolean> {
  if (files.length === 0) return false;
  clearEmptyState();
  const chip = make("div", "tool-chip enter");
  chip.appendChild(make("span", "spin"));
  chip.appendChild(make("span", "", "Planning job…"));
  mount(chip);

  const parts = files.map((f) => ({ path: f.localPath }));
  const defaults = deps.planOptions();
  const opts: Record<string, unknown> = { bed: defaults.bed, autoOrient: true };
  if (defaults.goal) opts.goal = defaults.goal;
  if (defaults.material) opts.material = defaults.material;

  try {
    const job = await postJson<PrintJob>("/api/jobs", { parts, opts });
    chip.remove();
    getJobPanel(job.id, job as WireJob);
    return true;
  } catch (err) {
    chip.remove();
    renderError((err as Error).message || "Couldn't plan that job.");
    return false;
  }
}

// ── the jobs sheet ───────────────────────────────────────────────────────────

async function refreshJobsList(): Promise<void> {
  jobsListEl.replaceChildren(skeleton(3));
  try {
    const jobs = await getJson<PrintJob[]>("/api/jobs");
    renderJobsList(jobs);
  } catch (err) {
    jobsListEl.replaceChildren(
      errorCard((err as Error).message || "Couldn't load your print jobs.", () => void refreshJobsList()),
    );
  }
}

function renderJobsList(jobs: PrintJob[]): void {
  jobsListEl.replaceChildren();
  if (jobs.length === 0) {
    jobsListEl.appendChild(
      make("p", "sheet-hint", 'No jobs yet. Attach 2 or more files, then use "Plan print job" in the tray.'),
    );
    return;
  }
  for (const j of jobs) {
    const row = make("div", "job-row");
    const info = make("div", "info");
    info.appendChild(make("div", "name", j.name || j.id));
    info.appendChild(make("div", "meta", `${j.status} · ${j.plates.length} plate(s)`));
    row.appendChild(info);
    const viewBtn = make("button", "btn ghost small", "View");
    viewBtn.type = "button";
    viewBtn.onclick = () => void viewJob(j.id);
    row.appendChild(viewBtn);
    jobsListEl.appendChild(row);
  }
}

async function viewJob(id: string): Promise<void> {
  try {
    const job = await getJson<PrintJob>(`/api/jobs/${encodeURIComponent(id)}`);
    closeSheets();
    getJobPanel(job.id, job as WireJob);
    scrollToBottom();
  } catch (err) {
    renderError((err as Error).message || "Couldn't load that job.");
  }
}

export function initJobs(d: JobsDeps): void {
  deps = d;
  jobsListEl = byId<HTMLElement>("jobsList");
  byId<HTMLButtonElement>("jobsRefreshBtn").addEventListener("click", () => void refreshJobsList());
}

/** Called when the jobs sheet opens. */
export function loadJobs(): void {
  void refreshJobsList();
}
