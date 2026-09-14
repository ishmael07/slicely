// NIH 3D Print Exchange (3d.nih.gov) — fully open, no auth. Public-domain and
// CC-licensed bioscientific/medical models, all guaranteed downloadable
// (files sit on an open, public-read S3 bucket).
//
// Verified live 2026-08-27 by direct probing (the site was fully rebuilt on
// Next.js since the old REST API documented at niaid.github.io/3dpx_api was
// written — that old API, and its old domain 3dprint.nih.gov, are dead: both
// now 301/307-redirect straight into the new Next.js app, and the old REST
// paths 404 on it):
//   • GET https://3d.nih.gov/api/entries/{id}  — VERIFIED. Accepts EITHER the
//     numeric entryId (e.g. "21858") or the public "3DPX-021858" id, case-
//     insensitively. Returns full entry detail: title, license, description,
//     keywords, and one `submissions[]` entry per published version, each
//     with `inputFiles[]`/`submissions[].outputFiles[]` — every file object
//     has a working, unauthenticated `s3Location` on
//     persist-3d-media.s3.amazonaws.com (fetched one directly: 200 OK, no
//     auth, Content-Length matched the API's own fileSize exactly).
//   • Entry detail pages (https://3d.nih.gov/entries/{id}) are server-
//     rendered with this same data embedded — confirms `/api/entries/{id}`
//     is the real backing route, not a coincidence.
//
// NOT FOUND despite substantial effort (this is the one honest gap on this
// source): the free-text SEARCH endpoint the `/discover` page itself calls.
// It renders with zero results embedded in the initial HTML (pure
// client-side fetch after hydration) and none of the following were it:
// `/api/discover`, `/api/entries/search`, `/api/entries?q=`, `/graphql`,
// `/api/trpc/*`, a sitemap, or an Algolia/Meilisearch/Typesense key baked
// into any of the ~40 shared JS chunks the page loads (grepped all of them
// for API-looking strings and known search-vendor hostnames — nothing).
// `/api/entries/search` and `/api/entries/search?...` DO return JSON (not
// Next's HTML 404 page) but with `{"error":"Request failed with status code
// 404"}` — that is axios's own default error string, meaning it's just the
// `[id]` dynamic route treating the literal word "search" as an id and
// 404ing upstream, not a real search route.
//
// So: `search()` here is an honest ID/URL lookup, not a text search — if the
// query looks like a 3DPX id, a bare entry id, or a 3d.nih.gov entry URL, it
// resolves that one exact entry (a genuinely useful shortcut for a pasted
// link or id); anything else returns no results rather than pretending to
// search NIH's full catalog. `listFiles`/`fileUrl`/download are fully
// verified and unconditionally open.
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { fetchWithUA } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const BASE = "https://3d.nih.gov";

interface Nih3dFile {
  fileId: number;
  s3Location: string;
  name: string;
  fileSize?: number;
  fileType?: string;
  fileFormat?: string | null;
}

interface Nih3dSubmission {
  submissionId: number;
  submissionStatus?: string;
  metadata?: { title?: string; license?: string; description?: string };
  inputFiles?: Nih3dFile[];
  outputFiles?: Nih3dFile[];
}

interface Nih3dEntry {
  entryId: number;
  threedpxId: string;
  category?: string;
  keywords?: string[];
  submissions?: Nih3dSubmission[];
}

/** Recognize a query that IS an id/URL rather than free text. */
function extractEntryRef(query: string): string | undefined {
  const trimmed = query.trim();
  const urlMatch = /3d\.nih\.gov\/entries\/([a-z0-9-]+)/i.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  if (/^3DPX-\d+$/i.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return undefined;
}

async function fetchEntry(id: string): Promise<Nih3dEntry | null> {
  const res = await fetchWithUA(`${BASE}/api/entries/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as Nih3dEntry;
}

/** The published (or latest) submission — the one worth showing/downloading. */
function bestSubmission(entry: Nih3dEntry): Nih3dSubmission | undefined {
  const subs = entry.submissions ?? [];
  return subs.find((s) => s.submissionStatus === "Published") ?? subs[subs.length - 1];
}

function toSourcedModel(entry: Nih3dEntry): SourcedModel {
  const sub = bestSubmission(entry);
  const outputMeshCount = (sub?.outputFiles ?? []).filter((f) => isMeshExt(extOf(f.name))).length;
  return {
    id: String(entry.entryId),
    source: "nih3d",
    title: sub?.metadata?.title ?? entry.threedpxId,
    webUrl: `${BASE}/entries/${entry.threedpxId}`,
    license: sub?.metadata?.license,
    downloadable: outputMeshCount > 0,
    summary: sub?.metadata?.description?.replace(/<[^>]+>/g, "").slice(0, 300),
    signals: { fileCount: outputMeshCount },
  };
}

export const nih3dProvider: SourcePlugin = {
  id: "nih3d",
  label: "NIH 3D Print Exchange",
  canDownload: true,

  availability(): SourceAvailability {
    return sourceState({
      id: "nih3d",
      label: "NIH 3D Print Exchange",
      status: "ready",
      searchable: true,
      downloadable: true,
    });
  },

  async search(query: string, _limit: number): Promise<SourcedModel[]> {
    const ref = extractEntryRef(query);
    if (!ref) return []; // see header comment — no free-text search endpoint was found
    const entry = await fetchEntry(ref);
    return entry ? [toSourcedModel(entry)] : [];
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    return listMeshFiles(modelId);
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    const files = await listMeshFiles(modelId);
    const chosen = fileId ? files.find((f) => f.id === fileId) : (files.find((f) => f.preferred) ?? files[0]);
    if (!chosen?.url) throw new Error(fileId ? `File ${fileId} not found.` : "No downloadable mesh found on this entry.");
    return { url: chosen.url, fileName: chosen.name };
  },
};

async function listMeshFiles(modelId: string): Promise<SourcedFile[]> {
  const entry = await fetchEntry(modelId);
  if (!entry) throw new Error(`NIH 3D entry "${modelId}" not found.`);
  const sub = bestSubmission(entry);
  const files = sub?.outputFiles ?? [];
  return files
    .filter((f) => isMeshExt(extOf(f.name)))
    .map((f) => ({
      id: String(f.fileId),
      name: f.name,
      ext: extOf(f.name),
      sizeBytes: f.fileSize,
      url: f.s3Location,
      preferred: extOf(f.name) === ".stl",
    }));
}
