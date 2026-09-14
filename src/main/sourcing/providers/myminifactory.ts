// MyMiniFactory — public REST API v2, `key` query param auth.
//
// Verified live 2026-08-27 against the official OpenAPI spec
// (github.com/MyMiniFactory/api-documentation/blob/master/myminifactory-api.yaml,
// fetched directly) plus live requests to confirm real paths/params:
//   • Base: https://www.myminifactory.com/api/v2
//   • Search: GET /search?q=&page=&per_page=&key=<API key>
//       - Confirmed live: an invalid key gets "Invalid API key" (401) at
//         this exact path+param shape, vs. "Authentication required" with no
//         key at all — i.e. the path and param name are right, only the key
//         value was untested (no MYMINIFACTORY_API_KEY was available in this
//         sandbox; MMF issues keys by manual developer approval).
//   • Object shape (from the spec): id, name, description, designer{username},
//     images[]{thumbnail_url or similar}, files[]{id, filename, size,
//     download_url, viewer_url, thumbnail_url}, license, views, likes.
//
// IMPORTANT CORRECTION to this source's brief ("free objects expose direct
// file URLs" via the API key): the official spec explicitly states, on BOTH
// `Object.archive_download_url` and `File.download_url`:
//   "Available ONLY with Oauth connected User. Not with API key."
// That is NOT what I was told to assume — it was checked directly against
// the current spec text, not inferred. An API key alone (the common,
// low-friction auth mode) gets metadata + thumbnails + a *reduced preview*
// mesh (`viewer_url`, explicitly documented as "Reduced version... for
// preview") but NOT the real, full-resolution print file.
//
// Full OAuth2 (authorization-code grant against auth.myminifactory.com,
// requiring a registered client_id/secret and a redirect callback — a bigger
// lift than Printables' pattern) is out of scope for this pass. What's
// implemented instead: if the caller has obtained their own OAuth access
// token some other way and set MYMINIFACTORY_ACCESS_TOKEN, requests are sent
// with `Authorization: Bearer <token>` instead of `key=`, which per the spec
// should populate the real `download_url` fields. UNVERIFIED — no token was
// available to test this path live; if it doesn't pan out in practice, every
// model still degrades to `downloadable: false` (browser hand-off), which is
// always correct.
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { fetchJson, clamp } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const BASE = "https://www.myminifactory.com/api/v2";

interface MmfImage {
  thumbnail_url?: string;
  url?: string;
}

interface MmfFile {
  id: number;
  filename: string;
  download_url?: string; // only populated with a real OAuth user token
  viewer_url?: string; // reduced preview mesh — available with just an API key
  thumbnail_url?: string;
  size?: string; // bytes, as a string per the spec
}

interface MmfObject {
  id: number;
  url?: string;
  name: string;
  description?: string;
  designer?: { username?: string } | null;
  images?: MmfImage[];
  files?: MmfFile[];
  license?: string;
  views?: number;
  likes?: number;
  published_at?: string;
}

function apiKey(): string {
  return process.env.MYMINIFACTORY_API_KEY?.trim() ?? "";
}

function accessToken(): string {
  return process.env.MYMINIFACTORY_ACCESS_TOKEN?.trim() ?? "";
}

/** True once we have SOME credential — an API key at minimum for search. */
function hasAnyCredential(): boolean {
  return apiKey().length > 0 || accessToken().length > 0;
}

function authedUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (!accessToken() && apiKey()) url.searchParams.set("key", apiKey());
  return url.toString();
}

function authHeaders(): Record<string, string> | undefined {
  const token = accessToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function modelUrl(o: MmfObject): string {
  return o.url ?? `https://www.myminifactory.com/object/${o.id}`;
}

function canRealDownload(): boolean {
  // Per the verified spec, only an OAuth user token gets real download_url
  // values back — a bare API key only ever gets the reduced viewer_url.
  return accessToken().length > 0;
}

export const myminifactoryProvider: SourcePlugin = {
  id: "myminifactory",
  label: "MyMiniFactory",
  canDownload: true,

  availability(): SourceAvailability {
    const has = hasAnyCredential();
    const full = canRealDownload();
    return sourceState({
      id: "myminifactory",
      label: "MyMiniFactory",
      status: !has ? "off" : full ? "ready" : "search_only",
      searchable: has,
      downloadable: full,
      operatorHint: has
        ? full
          ? undefined
          : "Search works with an API key, but real downloads need MYMINIFACTORY_ACCESS_TOKEN (an OAuth user token) — a bare API key only exposes a reduced preview mesh."
        : "Add a free MYMINIFACTORY_API_KEY to your .env.",
      setupUrl: has ? undefined : "https://www.myminifactory.com/api-doc/index.html",
    });
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    if (!hasAnyCredential()) return [];
    const url = authedUrl("/search", { q: query.trim(), per_page: clamp(limit, 1, 30), page: 1 });
    const data = await fetchJson<{ total_count?: number; items?: MmfObject[] } | MmfObject[]>(url, {
      headers: authHeaders(),
    });
    const items = Array.isArray(data) ? data : (data.items ?? []);

    return items.map((o) => ({
      id: String(o.id),
      source: "myminifactory" as const,
      title: o.name,
      creator: o.designer?.username ?? undefined,
      thumbnail: o.images?.[0]?.thumbnail_url ?? o.images?.[0]?.url,
      webUrl: modelUrl(o),
      license: o.license,
      downloadable: canRealDownload(),
      summary: o.description,
      signals: { likes: o.likes, publishedAt: o.published_at, fileCount: o.files?.length },
    }));
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    return listMeshFiles(modelId);
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    if (!canRealDownload()) {
      throw new Error(
        "MyMiniFactory only serves the real print file to an OAuth-authenticated user (MYMINIFACTORY_ACCESS_TOKEN) — open this model in the browser instead.",
      );
    }
    const files = await listMeshFiles(modelId);
    const chosen = fileId ? files.find((f) => f.id === fileId) : files[0];
    if (!chosen?.url) {
      throw new Error(fileId ? `File ${fileId} not found on this model.` : "No downloadable file found.");
    }
    return { url: chosen.url, fileName: chosen.name };
  },
};

async function listMeshFiles(modelId: string): Promise<SourcedFile[]> {
  const url = authedUrl(`/objects/${encodeURIComponent(modelId)}/files`);
  const data = await fetchJson<MmfFile[] | { items?: MmfFile[] }>(url, { headers: authHeaders() });
  const files = Array.isArray(data) ? data : (data.items ?? []);
  return files
    .filter((f) => isMeshExt(extOf(f.filename)))
    .map((f) => ({
      id: String(f.id),
      name: f.filename,
      ext: extOf(f.filename),
      sizeBytes: f.size ? Number(f.size) : undefined,
      url: canRealDownload() ? f.download_url : undefined,
      preferred: true,
    }));
}
