// ─────────────────────────────────────────────────────────────────────────────
// cards.ts — the visual vocabulary of a transcript: model result cards, the
// model-info panel, the slice-metrics panel, the 3D preview, and the two ways a
// failure is written down.
//
// Every function here BUILDS and returns an element. Nothing in this module
// appends to the transcript or touches another module's DOM — the caller
// (chat.ts, jobs.ts) decides where a card goes, which is what keeps the two
// transcript owners from fighting over it.
// ─────────────────────────────────────────────────────────────────────────────
import type { ModelInfo, SliceMetrics } from "../shared/types";
import type { PrintabilityScore, SearchOutcome } from "../shared/sourcing";
import type { PreviewMeshData } from "./viewer.js";
import { getJson } from "./api.js";
import { make } from "./ui.js";

/** v1 ModelResult and v2 SourcedModel share enough shape to render with one
 *  function. */
export interface CardLike {
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

/** Mounts a live-updating "Send to printer" button. Supplied by printers.ts so
 *  this module never needs to know the printer list. */
export type SendMount = (container: HTMLElement, gcodeId: string, size?: "small") => void;

// ── small shared bits ────────────────────────────────────────────────────────

export function panelHead(glyph: string, label: string): HTMLElement {
  const head = make("div", "panel-head");
  const ico = make("span", "", glyph);
  ico.setAttribute("aria-hidden", "true");
  head.appendChild(ico);
  head.appendChild(make("span", "", label));
  return head;
}

export function addMetric(grid: HTMLElement, k: string, v: string, accent = false): void {
  const m = make("div", "metric");
  m.appendChild(make("span", "k", k));
  m.appendChild(make("span", accent ? "v accent" : "v", v));
  grid.appendChild(m);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMinutes(mins?: number): string {
  if (mins === undefined || !Number.isFinite(mins)) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Turn a raw failure into something the reader can act on.
 *
 * Slicer and pipeline errors are written for a log: "Slicing failed: exit -1"
 * tells a user nothing, and the long over-packed message reads as a wall when
 * squeezed into a row. Each case below gives the cause in one line and the fix
 * in the next, and anything unrecognised is passed through rather than hidden.
 */
export function friendlyError(raw: string): { what: string; fix?: string } {
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
export function errorBlock(raw: string): HTMLElement {
  const { what, fix } = friendlyError(raw);
  const box = make("div", "err-block");
  box.appendChild(make("div", "err-what", what));
  if (fix) box.appendChild(make("div", "err-fix", fix));
  return box;
}

// ── model result cards ───────────────────────────────────────────────────────

export function placeholderThumb(alt?: string): HTMLElement {
  const el = make("div", "thumb placeholder", "◆");
  if (alt) el.setAttribute("aria-label", alt);
  else el.setAttribute("aria-hidden", "true");
  el.setAttribute("role", alt ? "img" : "presentation");
  return el;
}

/**
 * Compact licence code, e.g. "CC BY-NC-SA".
 *
 * What a user needs at a glance is whether they may use it and whether it is
 * commercial — not four dash-separated clauses. The full text stays on hover.
 */
export function shortLicence(raw: string): string {
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

export function buildCard(m: CardLike, onImport: (m: CardLike) => void): HTMLElement {
  const card = make("div", "card");
  if (m.thumbnail) {
    const img = make("img", "thumb");
    // Via the server: several sources set Cross-Origin-Resource-Policy, so the
    // browser refuses to paint their images in our page and every card would
    // fall back to a grey placeholder.
    img.src = `/api/thumb?url=${encodeURIComponent(m.thumbnail)}`;
    // The model's own title: a card whose picture is its whole identity is
    // useless to a screen reader without it.
    img.alt = m.title;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(placeholderThumb(m.title));
    card.appendChild(img);
  } else {
    card.appendChild(placeholderThumb(m.title));
  }

  const meta = make("div", "meta");
  meta.appendChild(make("div", "title", m.title));
  const sub = make("div", "sub");
  sub.appendChild(make("span", "", m.source));
  sub.appendChild(make("span", "", m.creator ? `by ${m.creator}` : "open-source"));
  meta.appendChild(sub);
  if (m.printability) {
    meta.appendChild(make("div", "score", `Printability ${Math.round(m.printability.score)}`));
  }
  if (m.license) {
    // Sources spell licences out in full ("Creative Commons — Attribution —
    // Noncommercial — Share Alike"), which fills a whole card line, truncates,
    // and tells the reader nothing they can act on. The short code does.
    const lic = make("div", "lic", shortLicence(m.license));
    lic.title = m.license;
    meta.appendChild(lic);
  }

  const actions = make("div", "actions");
  if (m.downloadable) {
    const importBtn = make("button", "btn primary small", "Import");
    importBtn.type = "button";
    // "Import" nine times in a row tells a screen-reader user nothing about
    // which model each button belongs to.
    importBtn.setAttribute("aria-label", `Import ${m.title}`);
    importBtn.onclick = () => onImport(m);
    actions.appendChild(importBtn);
  }
  const openBtn = make("button", "btn small", m.downloadable ? "View" : "Open in browser");
  openBtn.type = "button";
  openBtn.setAttribute("aria-label", `${m.downloadable ? "View" : "Open"} ${m.title} on ${m.source}`);
  openBtn.onclick = () => window.open(m.webUrl, "_blank", "noopener,noreferrer");
  actions.appendChild(openBtn);
  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

/** A row of result cards, or null when there is nothing to show. */
export function buildCards(models: CardLike[], onImport: (m: CardLike) => void): HTMLElement | null {
  if (models.length === 0) return null;
  const wrap = make("div", "cards");
  for (const m of models) wrap.appendChild(buildCard(m, onImport));
  return wrap;
}

/** Note under a result set naming which sources actually answered — so a thin
 *  result list reads as "MakerWorld timed out", not just "not much here". */
export function buildSourcesNote(sources: SearchOutcome["sources"] | undefined): HTMLElement | null {
  if (!sources || sources.length === 0) return null;
  // Summarise rather than dumping every source's raw error into the transcript.
  // Which sources CONTRIBUTED is the useful part; a Cloudflare block is
  // background noise the user can do nothing about, so it collapses to a count
  // and lives on hover.
  const note = make("div", "sources-note");
  const worked = sources.filter((s) => s.ok && s.count > 0);
  const failed = sources.filter((s) => !s.ok);
  const empty = sources.filter((s) => s.ok && s.count === 0);

  const found = worked
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((s) => `${s.id} ${s.count}`)
    .join(" · ");
  note.appendChild(make("span", "", found || "no sources returned results"));

  if (failed.length > 0 || empty.length > 0) {
    const quiet = make(
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
  return note;
}

// ── model info panel + 3D preview ────────────────────────────────────────────

const seenInfoPaths = new Set<string>();

/** Forget which models have already been described. Called when a turn ends or
 *  the transcript is cleared. */
export function resetSeenInfo(): void {
  seenInfoPaths.clear();
}

/** The dimensions/volume panel for one model, or null if this exact file has
 *  already been described in this turn. */
export function renderInfo(info: ModelInfo): HTMLElement | null {
  if (info.filePath) {
    if (seenInfoPaths.has(info.filePath)) return null;
    seenInfoPaths.add(info.filePath);
  }
  const panel = make("div", "panel enter");
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
  return panel;
}

/**
 * Add a turning 3D view of the model to a panel.
 *
 * Loaded lazily and failing silently: a preview is a nicety, and a model the
 * viewer cannot read must never take the metrics panel down with it.
 */
export function attachViewer(panel: HTMLElement, filePath?: string, url?: string): void {
  const holder = make("div", "viewer");
  const canvas = make("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Rotating 3D preview of the model");
  holder.appendChild(canvas);
  const note = make("div", "viewer-note", "Loading preview…");
  holder.appendChild(note);
  panel.appendChild(holder);

  void (async () => {
    try {
      const mesh = await getJson<PreviewMeshData>(
        url ?? `/api/preview?path=${encodeURIComponent(filePath ?? "")}`,
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

// ── slice metrics panel ──────────────────────────────────────────────────────

/**
 * The result of one slice.
 *
 * Send-to-printer is primary (it's the action that actually finishes the job);
 * Download G-code is the secondary, always-available fallback — the web client
 * has no local PrusaSlicer to "open" the result in.
 */
export function renderMetrics(m: SliceMetrics, gcodeId: string | undefined, mountSend: SendMount): HTMLElement {
  const panel = make("div", "panel enter");
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
    panel.appendChild(make("div", "fix-note", `🔧 ${m.fixes.join(" ")}`));
  }

  if (gcodeId) {
    const actions = make("div", "actions");
    mountSend(actions, gcodeId);
    const dl = make("a", "btn small", "Download G-code");
    dl.href = `/api/gcode/${encodeURIComponent(gcodeId)}`;
    actions.appendChild(dl);
    // Only in the Mac app: there the file is on THIS machine, so PrusaSlicer and
    // Finder can be pointed at it. `window.slicely` exists nowhere else, and the
    // bridge takes the same opaque token — never a path (Task E2).
    const native = window.slicely;
    if (native) {
      const open = make("button", "btn small", "Open in PrusaSlicer");
      open.type = "button";
      open.onclick = () => void native.openGcode(gcodeId);
      actions.appendChild(open);

      const reveal = make("button", "btn small", "Reveal in Finder");
      reveal.type = "button";
      reveal.onclick = () => void native.revealGcode(gcodeId);
      actions.appendChild(reveal);
    }
    panel.appendChild(actions);
  }

  return panel;
}
