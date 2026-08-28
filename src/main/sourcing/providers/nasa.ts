// NASA 3D Resources — fully open, no auth required for reading. The modern
// nasa3d.arc.nasa.gov site now redirects into science.nasa.gov/3d-resources/
// (a WordPress site whose printable-STL download links are not present in
// the server-rendered HTML — they appear to be client-rendered, and no
// working REST route for them was found), but the SAME catalog is also
// mirrored, exactly as the brief predicted, as a plain GitHub repo with a
// clean per-model folder layout and direct raw file links.
//
// Verified live 2026-08-27:
//   • https://nasa3d.arc.nasa.gov/ → 301 → https://science.nasa.gov/3d-resources/
//     (WordPress; its REST API at /wp-json/wp/v2/resource exists but the 3D
//     print files aren't reachable through it — confirmed by fetching a real
//     3D-resources page and finding no .stl/.obj/download link in the HTML).
//   • https://github.com/nasa/NASA-3D-Resources — VERIFIED via the GitHub
//     Contents API: root has a `3D Printing/` folder with 106 subfolders
//     (one per model, e.g. "CubeSat", "Curiosity Rover (Detailed)",
//     "Apollo 11 - Landing Site", ...), each containing the mesh file(s)
//     directly — e.g. `3D Printing/CubeSat/` has three .stl files plus a
//     .png preview, each GitHub Contents API entry already carrying a ready-
//     to-fetch `download_url` on raw.githubusercontent.com.
//
// Design: the repo's file tree under "3D Printing" IS the searchable
// catalog. It's small (106 entries) and changes rarely, so the whole listing
// is fetched once and cached in memory; `search()` filters cached folder
// names against the query locally rather than re-hitting GitHub per search
// (kind to GitHub's unauthenticated rate limit, which this shares with
// nothing else in the app — this uses the Contents API, not Code Search, so
// it does NOT need GITHUB_TOKEN, though one is honored if present since it
// raises the rate limit from 60/hr to 5000/hr).
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { fetchJson } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const REPO = "nasa/NASA-3D-Resources";
const CATALOG_PATH = "3D Printing";
const API_BASE = `https://api.github.com/repos/${REPO}/contents`;
const CACHE_TTL_MS = 60 * 60 * 1000; // the repo changes rarely — an hour is plenty

interface GhContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  download_url?: string | null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

let folderCache: { at: number; folders: GhContentEntry[] } | null = null;

async function listCatalogFolders(): Promise<GhContentEntry[]> {
  if (folderCache && Date.now() - folderCache.at < CACHE_TTL_MS) return folderCache.folders;
  const entries = await fetchJson<GhContentEntry[]>(
    `${API_BASE}/${encodeURIComponent(CATALOG_PATH)}`,
    { headers: githubHeaders() },
  );
  const folders = entries.filter((e) => e.type === "dir");
  folderCache = { at: Date.now(), folders };
  return folders;
}

async function listFolderFiles(folderName: string): Promise<GhContentEntry[]> {
  const path = `${CATALOG_PATH}/${folderName}`;
  return fetchJson<GhContentEntry[]>(`${API_BASE}/${encodeURIComponent(path)}`, {
    headers: githubHeaders(),
  });
}

function folderToModel(folder: GhContentEntry): SourcedModel {
  return {
    id: folder.name,
    source: "nasa",
    title: folder.name,
    webUrl: `https://github.com/${REPO}/tree/master/${encodeURIComponent(CATALOG_PATH)}/${encodeURIComponent(folder.name)}`,
    license: "NASA Open Source Agreement / public domain (US government work)",
    downloadable: true,
  };
}

export const nasaProvider: SourcePlugin = {
  id: "nasa",
  label: "NASA 3D Resources",
  canDownload: true,

  availability(): SourceAvailability {
    return { id: "nasa", label: "NASA 3D Resources", searchable: true, downloadable: true };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const folders = await listCatalogFolders();
    const q = query.trim().toLowerCase();
    const matches = q
      ? folders.filter((f) => f.name.toLowerCase().includes(q))
      : folders;
    return matches.slice(0, limit).map(folderToModel);
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    return listMeshFiles(modelId);
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    const files = await listMeshFiles(modelId);
    const chosen = fileId ? files.find((f) => f.id === fileId) : (files.find((f) => f.preferred) ?? files[0]);
    if (!chosen?.url) throw new Error(fileId ? `File ${fileId} not found.` : `No mesh files found in "${modelId}".`);
    return { url: chosen.url, fileName: chosen.name };
  },
};

async function listMeshFiles(modelId: string): Promise<SourcedFile[]> {
  const entries = await listFolderFiles(modelId);
  return entries
    .filter((e) => e.type === "file" && isMeshExt(extOf(e.name)))
    .map((e) => ({
      id: e.path,
      name: e.name,
      ext: extOf(e.name),
      sizeBytes: e.size,
      url: e.download_url ?? undefined,
      preferred: extOf(e.name) === ".stl",
    }));
}
