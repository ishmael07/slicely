// ─────────────────────────────────────────────────────────────────────────────
// P2 — Model sourcing contracts.
//
// Slicely's job here is narrow and concrete: given what the user wants, find
// real models across as many sources as possible and ACTUALLY GET THE FILE.
// Slicely does not model or generate geometry — it finds, downloads, slices,
// and prints what already exists.
//
// Three ways a mesh enters the workspace:
//   1. search()   — federated search across every provider
//   2. resolve()  — paste ANY url (model page, raw file, git repo, zip)
//   3. upload     — the user's own file (already handled by uploads.ts)
//
// Dependency-free. No Node, no Electron.
// ─────────────────────────────────────────────────────────────────────────────

/** Every source Slicely can search. Widening this union is how a source is
 *  added; `ModelSource` in types.ts re-exports it for backward compatibility. */
export type SourceId =
  // ── Direct-download capable ───────────────────────────────────────────────
  | "thingiverse"        // app token; full API + direct file download
  | "printables"         // search open; download via the user's own OAuth login
  | "myminifactory"      // public API key; free objects download directly
  | "nih3d"              // NIH 3D Print Exchange — fully open, no auth
  | "smithsonian"        // Smithsonian Open Access — fully open, no auth
  | "nasa"               // NASA 3D Resources — fully open, no auth
  | "github"             // code search for mesh files; raw download
  // ── Search / discovery only (hand off or resolve per-result) ──────────────
  | "makerworld"         // Bambu; gated download, mostly non-open licences
  | "thangs"             // aggregator with its own index
  | "yeggi"              // meta-search engine spanning dozens of sites
  | "stlfinder"          // meta-search engine spanning dozens of sites
  // ── Pseudo-sources ────────────────────────────────────────────────────────
  | "url"                // resolved from a pasted link
  | "upload";            // the user's own file

/** Sources that can put a file on disk without leaving Slicely. */
export const DIRECT_DOWNLOAD_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>([
  "thingiverse",
  "printables",
  "myminifactory",
  "nih3d",
  "smithsonian",
  "nasa",
  "github",
  "url",
  "upload",
]);

/** How confident Slicely is that this file will print without babysitting. */
export interface PrintabilityScore {
  /** 0–100. Composite; see `reasons` for the breakdown. */
  score: number;
  /** Plain-language contributors, best first. */
  reasons: string[];
  flags: {
    /** Geometry implies overhangs that need support. */
    needsSupports?: boolean;
    /** Larger than the active printer's bed. */
    oversized?: boolean;
    /** Small enough that detail will be lost at the chosen layer height. */
    tiny?: boolean;
    /** Mesh is not watertight — slicing may produce artifacts. */
    nonManifold?: boolean;
    /** Ships as several files that must be arranged together. */
    multiPart?: boolean;
    /** Licence forbids commercial use or redistribution. */
    restrictiveLicence?: boolean;
  };
}

/** Popularity/quality signals a source reports. Used for cross-source ranking. */
export interface SourceSignals {
  downloads?: number;
  likes?: number;
  makes?: number;
  comments?: number;
  /** ISO date the model was published. */
  publishedAt?: string;
  /** Number of distinct mesh files the model ships. */
  fileCount?: number;
}

/**
 * A search hit, enriched beyond the v1 `ModelResult`. Field names match
 * `ModelResult` where they overlap so existing renderer code keeps working.
 */
export interface SourcedModel {
  id: string;
  source: SourceId;
  title: string;
  creator?: string;
  thumbnail?: string;
  webUrl: string;
  license?: string;
  /** True when Slicely can put the mesh on disk without a browser hand-off. */
  downloadable: boolean;
  /** Short description, when the source provides one. */
  summary?: string;
  signals?: SourceSignals;
  printability?: PrintabilityScore;
  /** 0–1 fused relevance used to order results across sources. */
  relevance?: number;
  /** A direct mesh URL, when the source exposes one at search time — lets the
   *  downloader skip a second round-trip. */
  directUrl?: string;
}

/** One downloadable file belonging to a model. */
export interface SourcedFile {
  id: string;
  name: string;
  ext: string;
  sizeBytes?: number;
  /** Direct URL, when known without another API call. */
  url?: string;
  /** True for the file the downloader should pick by default. */
  preferred?: boolean;
}

/** Why a source is unusable right now — surfaced so the user can fix it. */
export interface SourceAvailability {
  id: SourceId;
  label: string;
  searchable: boolean;
  downloadable: boolean;
  /** Present when unavailable: what the user must do, e.g. "Add an API key". */
  blockedReason?: string;
  /** Where to get the credential, when one is needed. */
  setupUrl?: string;
}

/** A source Slicely can search. */
export interface SourcePlugin {
  readonly id: SourceId;
  readonly label: string;
  /** False for meta-search engines whose results always need resolving. */
  readonly canDownload: boolean;
  /** Reports readiness + why not, instead of a bare boolean. */
  availability(): SourceAvailability;
  search(query: string, limit: number): Promise<SourcedModel[]>;
  /** List the model's files. Only meaningful when canDownload. */
  listFiles?(modelId: string): Promise<SourcedFile[]>;
  /** Resolve a file to a direct, fetchable URL (+ any auth headers). */
  fileUrl?(modelId: string, fileId?: string): Promise<ResolvedFileUrl>;
}

/** A URL the downloader can GET, plus whatever headers it needs. */
export interface ResolvedFileUrl {
  url: string;
  headers?: Record<string, string>;
  /** Suggested filename, when the URL itself doesn't carry one. */
  fileName?: string;
}

// ── Universal URL resolution ─────────────────────────────────────────────────

/** What a pasted URL turned out to be. */
export type ResolvedKind =
  | "direct-mesh"   // the URL is itself an .stl/.3mf/.obj/…
  | "archive"       // a .zip of meshes
  | "model-page"    // a known marketplace page → handled by its provider
  | "git-repo"      // a GitHub/GitLab repo or tree containing meshes
  | "scraped-page"  // an unknown page with mesh links found in the HTML
  | "unsupported";

/** Outcome of resolving a pasted URL to something downloadable. */
export interface UrlResolution {
  kind: ResolvedKind;
  /** Present unless kind is "unsupported". */
  model?: SourcedModel;
  /** Candidate files, best first. Empty when nothing downloadable was found. */
  files: SourcedFile[];
  /** Plain-language explanation, always set — especially for "unsupported". */
  message: string;
}

// ── Federated search ─────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Restrict to these sources. Empty/undefined = every available source. */
  sources?: SourceId[];
  /** Extra phrasings to search alongside the query, pooled and ranked with it.
   *  Model sites match keywords, not meaning, so a quality like "buff" only
   *  finds titles that literally say it. */
  alternates?: string[];
  /** Max results returned overall (after fusion). Default 12. */
  limit?: number;
  /** Per-source fetch budget. Default 10. */
  perSource?: number;
  /** Drop results Slicely can't download. Default false. */
  downloadableOnly?: boolean;
  /** Bed size used to flag oversized results. */
  bed?: { x: number; y: number; z: number };
  /** Abort in-flight provider calls. */
  signal?: AbortSignal;
}

export interface SearchOutcome {
  results: SourcedModel[];
  /** Per-source outcome, so the UI can say "MakerWorld timed out". */
  sources: Array<{
    id: SourceId;
    ok: boolean;
    count: number;
    ms: number;
    error?: string;
    /** Set when this source returned nothing for the original query and was
     *  retried with a narrower one (some sources AND every term together, so
     *  one extra word yields zero). Carries the query that actually worked. */
    narrowedTo?: string;
  }>;
}
