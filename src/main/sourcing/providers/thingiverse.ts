// Thingiverse — app-token API, real file download. The one v1 source that
// could both search AND download; ported here mostly unchanged onto the new
// SourcePlugin contract, with signals + printability hints added.
//
// Verified API facts (re-verified live 2026-08-27, unchanged since v1's
// 2026-06-19 probe):
//   • Base: https://api.thingiverse.com — every call needs
//     `Authorization: Bearer <token>` (401 without one — confirmed live).
//   • Search: GET /search/{term}/?page=&per_page=&sort=popular
//   • Files:  GET /things/{id}/files → each file has a `download_url`
//   • download_url 302-redirects to a signed CDN url serving the .stl/.3mf
// NOT independently re-verified this session (no THINGIVERSE_APP_TOKEN was
// available in this sandbox to make an authenticated call) — carried forward
// from v1's header comment, which was live-probed with a real token.
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { getConfig } from "../../config";
import { fetchWithUA, safeText, clamp, USER_AGENT } from "../net";
import { extOf, isArchiveExt, isMeshExt } from "../fsutil";

const BASE = "https://api.thingiverse.com";

interface TvThing {
  id: number;
  name: string;
  public_url?: string;
  url?: string;
  thumbnail?: string;
  preview_image?: string;
  creator?: { name?: string };
  license?: string;
  like_count?: number;
  collect_count?: number;
  download_count?: number;
  comment_count?: number;
  added?: string;
}

interface TvFile {
  id: number;
  name: string;
  size?: number;
  download_url?: string;
}

function token(): string {
  return getConfig().thingiverseToken;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

async function fetchFiles(modelId: string): Promise<TvFile[]> {
  const url = `${BASE}/things/${encodeURIComponent(modelId)}/files`;
  const res = await fetchWithUA(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Thingiverse file list failed (${res.status}): ${await safeText(res)}`);
  }
  return (await res.json()) as TvFile[];
}

export const thingiverseProvider: SourcePlugin = {
  id: "thingiverse",
  label: "Thingiverse",
  canDownload: true,

  availability(): SourceAvailability {
    const has = token().trim().length > 0;
    return sourceState({
      id: "thingiverse",
      label: "Thingiverse",
      status: has ? "ready" : "off",
      searchable: has,
      downloadable: has,
      operatorHint: has ? undefined : "Add a free THINGIVERSE_APP_TOKEN to your .env.",
      setupUrl: has ? undefined : "https://www.thingiverse.com/developers",
    });
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    if (!token().trim()) return [];
    const term = encodeURIComponent(query.trim());
    const perPage = clamp(limit, 1, 30);
    const url = `${BASE}/search/${term}/?per_page=${perPage}&page=1&sort=popular&type=things`;

    const res = await fetchWithUA(url, { headers: authHeaders() });
    if (res.status === 404) return []; // Thingiverse 404s on zero matches
    if (!res.ok) {
      throw new Error(`Thingiverse search failed (${res.status}): ${await safeText(res)}`);
    }
    const body = (await res.json()) as { hits?: TvThing[] } | TvThing[];
    const hits: TvThing[] = Array.isArray(body) ? body : (body.hits ?? []);

    return hits.map((t) => ({
      id: String(t.id),
      source: "thingiverse" as const,
      title: t.name,
      creator: t.creator?.name,
      thumbnail: t.preview_image || t.thumbnail,
      webUrl: t.public_url || `https://www.thingiverse.com/thing:${t.id}`,
      license: t.license,
      downloadable: true,
      signals: {
        downloads: t.download_count,
        likes: t.like_count,
        makes: t.collect_count,
        comments: t.comment_count,
        publishedAt: t.added,
      },
    }));
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    const files = await fetchFiles(modelId);
    return files
      .filter((f) => isMeshExt(extOf(f.name)) || isArchiveExt(extOf(f.name)))
      .map((f) => ({
        id: String(f.id),
        name: f.name,
        ext: extOf(f.name),
        sizeBytes: f.size,
        url: f.download_url,
        preferred: isMeshExt(extOf(f.name)),
      }));
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    const files = await fetchFiles(modelId);
    const meshes = files.filter((f) => isMeshExt(extOf(f.name)));
    const archives = files.filter((f) => isArchiveExt(extOf(f.name)));
    const candidates = [...meshes, ...archives];
    if (candidates.length === 0) {
      throw new Error("This Thingiverse model has no downloadable files.");
    }
    const chosen = fileId
      ? candidates.find((f) => String(f.id) === fileId)
      : (meshes[0] ?? archives[0]);
    if (!chosen?.download_url) {
      throw new Error(fileId ? `File ${fileId} not found on this model.` : "No download URL available.");
    }
    return {
      url: chosen.download_url,
      headers: authHeaders(),
      fileName: chosen.name,
    };
  },
};
