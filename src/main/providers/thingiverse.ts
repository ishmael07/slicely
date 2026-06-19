// Thingiverse provider — the one marketplace Slicely can both SEARCH and
// DOWNLOAD from unattended. Requires a free "App Token".
//
// Verified API facts (live-probed 2026-06-19):
//   • Base: https://api.thingiverse.com  — every call needs `Authorization: Bearer <token>`
//   • Search: GET /search/{term}/?page=&per_page=&sort=popular
//   • Files:  GET /things/{id}/files  → each file has a `download_url`
//   • download_url 302-redirects to a signed CDN url serving the .stl/.3mf
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelResult,
  ModelFile,
  DownloadResult,
  DownloadPart,
} from "../../shared/types";
import type { DownloadProvider } from "./types";
import { extractMeshesFromZip } from "../meshzip";

const BASE = "https://api.thingiverse.com";
const MESH_EXTS = [".stl", ".3mf", ".obj", ".step", ".stp"];
const ARCHIVE_EXTS = [".zip"];

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
    const archives = files.filter((f) => ARCHIVE_EXTS.includes(extOf(f.name)));

    if (meshes.length === 0 && archives.length === 0) {
      throw new Error("This Thingiverse model has no downloadable mesh files.");
    }

    // If a specific file was requested, download just that one (legacy path).
    if (fileId) {
      const chosen = [...meshes, ...archives].find(
        (f) => String(f.id) === fileId,
      );
      if (!chosen) throw new Error(`File ${fileId} not found on this model.`);
      const part = await this.fetchOne(chosen, destDir);
      return { ...part, parts: [part] };
    }

    // Otherwise grab the WHOLE model: every mesh file, plus meshes unpacked
    // from any ZIP archives — into a per-model subfolder so parts stay grouped.
    const folder = join(destDir, `thing-${modelId}`);
    await mkdir(folder, { recursive: true });

    const parts: DownloadPart[] = [];
    for (const m of meshes) {
      try {
        parts.push(await this.fetchOne(m, folder));
      } catch (err) {
        console.warn(`[thingiverse] skip ${m.name}:`, (err as Error).message);
      }
    }
    for (const a of archives) {
      if (!a.download_url) continue;
      try {
        const buf = await this.fetchBuffer(a.download_url);
        const extracted = await extractMeshesFromZip(buf, folder);
        parts.push(...extracted);
      } catch (err) {
        console.warn(`[thingiverse] zip ${a.name}:`, (err as Error).message);
      }
    }

    if (parts.length === 0) {
      throw new Error("Couldn't extract any printable meshes from this model.");
    }

    // Primary = largest .stl, else the largest mesh overall, else first.
    const primary =
      [...parts]
        .filter((p) => p.ext === ".stl")
        .sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ??
      [...parts].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];

    return {
      localPath: primary.localPath,
      fileName: primary.fileName,
      sizeBytes: primary.sizeBytes,
      parts,
    };
  }

  /** Download one Thingiverse file into destDir, returning a DownloadPart. */
  private async fetchOne(file: TvFile, destDir: string): Promise<DownloadPart> {
    if (!file.download_url) {
      throw new Error(`File "${file.name}" has no download URL.`);
    }
    const buf = await this.fetchBuffer(file.download_url);
    const fileName = sanitizeFileName(file.name);
    const localPath = join(destDir, fileName);
    await writeFile(localPath, buf);
    return { localPath, fileName, sizeBytes: buf.byteLength, ext: extOf(fileName) };
  }

  /** Fetch a download_url (302-redirects to a signed CDN url) as a Buffer. */
  private async fetchBuffer(downloadUrl: string): Promise<Buffer> {
    const dl = await fetch(downloadUrl, { headers: this.headers() });
    if (!dl.ok) {
      throw new Error(`Download failed (${dl.status}): ${await safeText(dl)}`);
    }
    return Buffer.from(await dl.arrayBuffer());
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
