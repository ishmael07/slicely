// Extract mesh files from a ZIP archive. Used for multi-part downloads
// (Thingiverse often packages parts in a .zip) and ZIP uploads. Main-process
// only — never imported by the renderer bundle.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import unzipper from "unzipper";
import type { DownloadPart } from "../shared/types";

/** Mesh extensions we keep out of an archive (sliceable + importable meshes). */
export const ARCHIVE_MESH_EXTS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"];

/**
 * Extract every mesh file from a ZIP buffer into `destDir`, flattened (no
 * nested folders). Returns one DownloadPart per extracted mesh. Hardened
 * against zip-slip: only the basename of each entry is ever used, so a
 * malicious "../../etc/x" path can't escape destDir.
 */
export async function extractMeshesFromZip(
  buf: Buffer,
  destDir: string,
): Promise<DownloadPart[]> {
  await mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.buffer(buf);
  const parts: DownloadPart[] = [];

  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    // Skip macOS resource-fork junk and anything not a mesh.
    if (entry.path.includes("__MACOSX")) continue;
    const ext = extname(entry.path).toLowerCase();
    if (!ARCHIVE_MESH_EXTS.includes(ext)) continue;

    // Zip-slip guard: take the basename only — never honor directory parts.
    const safeName = sanitizeName(basename(entry.path));
    const localPath = join(destDir, safeName);
    const content = await entry.buffer();
    await writeFile(localPath, content);
    parts.push({
      localPath,
      fileName: safeName,
      sizeBytes: content.byteLength,
      ext,
    });
  }

  return parts;
}

function sanitizeName(name: string): string {
  const reserved = new Set(["<", ">", ":", '"', "|", "?", "*", "/", "\\"]);
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue;
    out += reserved.has(ch) ? "_" : ch;
  }
  out = out.trim();
  return out.length > 0 ? out : "part.stl";
}
