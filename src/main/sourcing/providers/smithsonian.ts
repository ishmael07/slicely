// Smithsonian Open Access — fully open 3D scans (CC0), api.si.edu.
//
// Verified live 2026-08-27:
//   • Base: https://api.si.edu/openaccess/api/v1.0
//   • Search: GET /search?q=&api_key=&rows=&start=  — VERIFIED working with
//     the public `DEMO_KEY` (no registration needed to try it; a real key
//     from https://api.data.gov/signup raises the rate limit substantially).
//   • GET /terms/online_media_type → VERIFIED the exact facet value for 3D
//     content is the literal string "3D Models" (confirmed via this
//     endpoint, which lists every valid `online_media_type` term).
//   • Response envelope confirmed live: { status, responseCode,
//     response: { rows: [...], rowCount } }, each row having `id`, `title`,
//     `unitCode`, `content.descriptiveNonRepeating.online_media` for media.
//
// NOT verified live (DEMO_KEY's rate limit was exhausted mid-session before
// either call could be re-tried — both attempts got HTTP 429, not a real
// answer):
//   - The exact shape of `online_media.media[]` for an actual 3D record and
//     its downloadable resource URL(s). The mapping below is written
//     DEFENSIVELY: it checks several plausible field paths for Smithsonian
//     Open Access 3D media (`media[].resources[].url`, `media[].content`)
//     and only reports `downloadable: true` when it actually finds a URL
//     that looks like a real mesh file — otherwise it degrades to
//     `downloadable: false` with a browser hand-off rather than guessing a
//     resource-URL pattern that might not exist.
//   - `GET /content/{id}` as the single-record lookup used by listFiles —
//     this is documented Smithsonian Open Access API shape (general
//     knowledge, not this session's probing), not independently confirmed
//     live here.
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { fetchJson } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const BASE = "https://api.si.edu/openaccess/api/v1.0";

interface SiMediaResource {
  url?: string;
  label?: string;
  fileSize?: string | number;
}

interface SiMedia {
  content?: string; // sometimes IS the direct asset URL
  guid?: string;
  type?: string;
  thumbnail?: string;
  resources?: SiMediaResource[];
}

interface SiRow {
  id: string;
  title: string;
  unitCode?: string;
  content?: {
    descriptiveNonRepeating?: {
      title?: { content?: string } | string;
      online_media?: { media?: SiMedia[]; mediaCount?: number };
      guid?: string;
      record_link?: string;
    };
    freetext?: {
      name?: Array<{ label?: string; content?: string }>;
      notes?: Array<{ label?: string; content?: string }>;
    };
    indexedStructured?: {
      usage?: Array<{ content?: string }>;
    };
  };
}

interface SiSearchResponse {
  response?: { rows?: SiRow[]; rowCount?: number };
}

function apiKey(): string {
  return process.env.SMITHSONIAN_API_KEY?.trim() || "DEMO_KEY";
}

function hasRealKey(): boolean {
  return (process.env.SMITHSONIAN_API_KEY?.trim().length ?? 0) > 0;
}

function buildUrl(path: string, params: Record<string, string | number>): string {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Best-effort extraction of a real, fetchable 3D file URL from whatever
 *  shape this row's media array turns out to have. Returns undefined rather
 *  than a guess when nothing plausible is found. */
function extractMeshUrls(media: SiMedia[] | undefined): SourcedFile[] {
  const out: SourcedFile[] = [];
  for (const m of media ?? []) {
    for (const res of m.resources ?? []) {
      if (!res.url) continue;
      const ext = extOf(res.url);
      if (isMeshExt(ext)) {
        out.push({
          id: res.url,
          name: res.label ?? res.url.split("/").pop() ?? "model",
          ext,
          sizeBytes: res.fileSize ? Number(res.fileSize) : undefined,
          url: res.url,
          preferred: ext === ".stl",
        });
      }
    }
    // Some records expose the mesh directly on `content` instead of a
    // `resources[]` array.
    if (m.content && isMeshExt(extOf(m.content))) {
      out.push({
        id: m.content,
        name: m.content.split("/").pop() ?? "model",
        ext: extOf(m.content),
        url: m.content,
        preferred: extOf(m.content) === ".stl",
      });
    }
  }
  return out;
}

function titleOf(row: SiRow): string {
  const t = row.content?.descriptiveNonRepeating?.title;
  if (typeof t === "string") return t;
  return t?.content ?? row.title;
}

function toSourcedModel(row: SiRow): SourcedModel {
  const media = row.content?.descriptiveNonRepeating?.online_media?.media;
  const files = extractMeshUrls(media);
  const webUrl =
    row.content?.descriptiveNonRepeating?.record_link ??
    `https://www.si.edu/object/${row.id}`;
  return {
    id: row.id,
    source: "smithsonian",
    title: titleOf(row),
    webUrl,
    thumbnail: media?.find((m) => m.thumbnail)?.thumbnail,
    downloadable: files.length > 0,
    license: "CC0 (Smithsonian Open Access)",
    signals: { fileCount: files.length || undefined },
  };
}

export const smithsonianProvider: SourcePlugin = {
  id: "smithsonian",
  label: "Smithsonian Open Access",
  canDownload: true,

  availability(): SourceAvailability {
    const real = hasRealKey();
    return sourceState({
      id: "smithsonian",
      label: "Smithsonian Open Access",
      status: real ? "ready" : "limited",
      searchable: true, // works even with the public DEMO_KEY, just rate-limited
      downloadable: true,
      operatorHint: real
        ? undefined
        : "Using the shared DEMO_KEY (low rate limit) — add a free SMITHSONIAN_API_KEY for reliable use.",
      setupUrl: real ? undefined : "https://api.data.gov/signup/",
    });
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    // Restrict to the verified 3D-content facet so results are always models,
    // never books/photos/audio from the wider Smithsonian catalog.
    const q = `online_media_type:"3D Models" AND ${query.trim()}`;
    const url = buildUrl("/search", { q, rows: Math.min(Math.max(limit, 1), 30) });
    const data = await fetchJson<SiSearchResponse>(url);
    const rows = data.response?.rows ?? [];
    return rows.map(toSourcedModel);
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    return listMeshFiles(modelId);
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    const files = await listMeshFiles(modelId);
    const chosen = fileId ? files.find((f) => f.id === fileId) : (files.find((f) => f.preferred) ?? files[0]);
    if (!chosen?.url) {
      throw new Error(
        fileId ? `File ${fileId} not found.` : "No downloadable 3D file found on this Smithsonian record.",
      );
    }
    return { url: chosen.url, fileName: chosen.name };
  },
};

async function listMeshFiles(modelId: string): Promise<SourcedFile[]> {
  const url = buildUrl(`/content/${encodeURIComponent(modelId)}`, {});
  const data = await fetchJson<{ response?: SiRow }>(url);
  if (!data.response) throw new Error(`Smithsonian record "${modelId}" not found.`);
  return extractMeshUrls(data.response.content?.descriptiveNonRepeating?.online_media?.media);
}
