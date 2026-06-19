// Thingiverse provider — the one marketplace Slicely can both SEARCH and
// DOWNLOAD from unattended. Requires a free "App Token".
//
// Verified API facts (live-probed 2026-06-19):
//   • Base: https://api.thingiverse.com  — every call needs `Authorization: Bearer <token>`
//   • Search: GET /search/{term}/?page=&per_page=&sort=popular
//   • Files:  GET /things/{id}/files  → each file has a `download_url`
//   • download_url 302-redirects to a signed CDN url serving the .stl/.3mf
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelResult,
  ModelFile,
  DownloadResult,
} from "../../shared/types";
import type { DownloadProvider } from "./types";

const BASE = "https://api.thingiverse.com";
const MESH_EXTS = [".stl", ".3mf", ".obj", ".step", ".stp"];

interface TvThing {
  id: number;
  name: string;
  public_url?: string;
  url?: string;
  thumbnail?: string;
  preview_image?: string;
  creator?: { name?: string };
  license?: string;
}

interface TvFile {
  id: number;
  name: string;
  size?: number;
  download_url?: string;
}

export class ThingiverseProvider implements DownloadProvider {
  readonly id = "thingiverse";

  constructor(private readonly token: string) {}

  isAvailable(): boolean {
    return this.token.trim().length > 0;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": "Slicely/0.1 (+https://github.com/ishmael07/slicely)",
    };
  }

  async search(query: string, limit: number): Promise<ModelResult[]> {
    const term = encodeURIComponent(query.trim());
    const perPage = Math.min(Math.max(limit, 1), 30);
    const url = `${BASE}/search/${term}/?per_page=${perPage}&page=1&sort=popular&type=things`;

    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 404) return []; // Thingiverse 404s on zero matches
    if (!res.ok) {
      throw new Error(
        `Thingiverse search failed (${res.status}): ${await safeText(res)}`,
      );
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
    }));
  }

  async listFiles(modelId: string): Promise<ModelFile[]> {
    const files = await this.fetchFiles(modelId);
    return files
      .filter((f) => MESH_EXTS.includes(extOf(f.name)))
      .map((f) => ({
        id: String(f.id),
        name: f.name,
        sizeBytes: f.size,
        ext: extOf(f.name),
      }));
  }

  async download(
    modelId: string,
    destDir: string,
    fileId?: string,
  ): Promise<DownloadResult> {
    const files = await this.fetchFiles(modelId);
    const meshes = files.filter((f) => MESH_EXTS.includes(extOf(f.name)));
    if (meshes.length === 0) {
      throw new Error("This Thingiverse model has no downloadable mesh files.");
    }

    // Pick the requested file, else prefer .stl, else first mesh.
    const chosen =
      (fileId && meshes.find((f) => String(f.id) === fileId)) ||
      meshes.find((f) => extOf(f.name) === ".stl") ||
      meshes[0];

    if (!chosen.download_url) {
      throw new Error(`File "${chosen.name}" has no download URL.`);
    }

    // The download_url 302-redirects to a signed CDN url; fetch follows
    // redirects by default. Send the bearer on the initial request.
    const dl = await fetch(chosen.download_url, { headers: this.headers() });
    if (!dl.ok) {
      throw new Error(`Download failed (${dl.status}): ${await safeText(dl)}`);
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const fileName = sanitizeFileName(chosen.name);
    const localPath = join(destDir, fileName);
    await writeFile(localPath, buf);

    return { localPath, fileName, sizeBytes: buf.byteLength };
  }

  private async fetchFiles(modelId: string): Promise<TvFile[]> {
    const url = `${BASE}/things/${encodeURIComponent(modelId)}/files`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Thingiverse file list failed (${res.status}): ${await safeText(res)}`,
      );
    }
    return (await res.json()) as TvFile[];
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function sanitizeFileName(name: string): string {
  // Drop directory separators and Windows-reserved chars; keep a safe stem.
  const reserved = new Set(["<", ">", ":", '"', "|", "?", "*", "/", "\\"]);
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue; // control chars
    out += reserved.has(ch) ? "_" : ch;
  }
  out = out.trim();
  return out.length > 0 ? out : "model.stl";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
