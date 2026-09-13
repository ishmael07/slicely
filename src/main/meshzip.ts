// Extract mesh files from a ZIP archive. Used for multi-part downloads
// (Thingiverse often packages parts in a .zip) and ZIP uploads. Main-process
// only — never imported by the renderer bundle.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import unzipper from "unzipper";
import type { DownloadPart } from "../shared/types";
import { MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES } from "../shared/types";
import { WireError } from "../server/errors";

/** Mesh extensions we keep out of an archive (sliceable + importable meshes). */
export const ARCHIVE_MESH_EXTS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"];

/**
 * Extract every mesh file from a ZIP buffer into `destDir`, flattened (no
 * nested folders). Returns one DownloadPart per extracted mesh. Hardened
 * against zip-slip: only the basename of each entry is ever used, so a
 * malicious "../../etc/x" path can't escape destDir — and against zip bombs:
 * the archive is refused outright if its central directory declares more than
 * MAX_ZIP_ENTRIES entries or more than MAX_ZIP_TOTAL_BYTES of content, both
 * checked BEFORE a single byte is written.
 */
export async function extractMeshesFromZip(
  buf: Buffer,
  destDir: string,
): Promise<DownloadPart[]> {
  await mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.buffer(buf);

  assertZipWithinCaps(directory.files);

  const parts: DownloadPart[] = [];
  let written = 0;

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

    // Belt and braces: the declared uncompressed sizes were checked above, but
    // they come from the archive itself. Count what we ACTUALLY write too, so a
    // lying central directory can't talk us past the cap.
    written += content.byteLength;
    if (written > MAX_ZIP_TOTAL_BYTES) throw zipTooBig();

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

/** Refuse an archive whose central directory alone shows it's a bomb. Shared
 *  shape with sourcing/download.ts's expandZipFile — same caps, same codes. */
export function assertZipWithinCaps(
  files: ReadonlyArray<{ uncompressedSize?: number }>,
): void {
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new WireError(
      400,
      `That archive has too many files (${files.length}); the limit is ${MAX_ZIP_ENTRIES}.`,
      "zip_too_many_entries",
    );
  }
  const declared = files.reduce((n, f) => n + (f.uncompressedSize ?? 0), 0);
  if (declared > MAX_ZIP_TOTAL_BYTES) throw zipTooBig();
}

function zipTooBig(): WireError {
  return new WireError(
    413,
    `That archive unpacks to more than ${Math.floor(MAX_ZIP_TOTAL_BYTES / (1024 * 1024 * 1024))} GB.`,
    "too_large",
  );
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
