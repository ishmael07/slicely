// Extract mesh files from a ZIP archive. Used for multi-part downloads
// (Thingiverse often packages parts in a .zip) and ZIP uploads. Main-process
// only — never imported by the renderer bundle.
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import type { DownloadPart } from "../shared/types";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
} from "../shared/types";
import { WireError } from "../server/errors";

/** Mesh extensions we keep out of an archive (sliceable + importable meshes). */
export const ARCHIVE_MESH_EXTS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"];

/**
 * Extract every mesh file from a ZIP already on disk at `zipPath` into
 * `destDir`, flattened (no nested folders). Returns one DownloadPart per
 * extracted mesh. Hardened against zip-slip: only the basename of each entry
 * is ever used, so a malicious "../../etc/x" path can't escape destDir — and
 * against zip bombs: the archive is refused outright if its central directory
 * declares more than MAX_ZIP_ENTRIES entries, more than MAX_ZIP_TOTAL_BYTES of
 * content, or any SINGLE entry over MAX_ZIP_ENTRY_BYTES, all checked BEFORE a
 * byte is written.
 *
 * The WHOLE ARCHIVE is never read into memory: `unzipper.Open.file()` reads
 * only the central directory eagerly (a few KB even for a huge zip), the same
 * disk-backed pattern `sourcing/download.ts`'s `expandZipFile` uses — a caller
 * that read the entire upload into a Buffer first and handed it here would
 * defeat the point, so `acceptZip` in uploads.ts passes the path straight
 * through instead of `readFile`-ing it.
 *
 * Entries are STREAMED to disk, never buffered. `entry.buffer()` made the
 * per-entry cap unenforceable in the only case that mattered: one 1.9 GB entry
 * sits inside the 2 GB total, so the old code went straight to allocating a
 * 1.9 GB Buffer and the running total it checked afterwards never got to run.
 * Streaming bounds the damage to one chunk at a time, so a lying central
 * directory is caught mid-transfer — with the partial file removed — instead of
 * taking the process down.
 *
 * `maxEntryBytes` exists so a test can prove both refusals with a few bytes of
 * fixture instead of half a gigabyte, the same way `expandZipFile` takes it.
 */
export async function extractMeshesFromZip(
  zipPath: string,
  destDir: string,
  maxEntryBytes: number = MAX_ZIP_ENTRY_BYTES,
): Promise<DownloadPart[]> {
  await mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);

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

    // Cheapest check first: what the archive SAYS this entry weighs.
    if ((entry.uncompressedSize ?? 0) > maxEntryBytes) {
      throw entryTooBig(safeName, maxEntryBytes);
    }

    // Belt and braces: the declared sizes came from the archive itself, so the
    // stream is metered against both ceilings as it is written.
    const size = await writeEntryStreamed(
      entry,
      localPath,
      safeName,
      maxEntryBytes,
      MAX_ZIP_TOTAL_BYTES - written,
    );
    written += size;

    parts.push({
      localPath,
      fileName: safeName,
      sizeBytes: size,
      ext,
    });
  }

  return parts;
}

/**
 * Stream one zip entry to `localPath`, aborting the moment it outgrows either
 * the per-entry cap or what is left of the whole-archive budget. A partial file
 * is removed on any failure: leaving half a mesh behind would be indexed as a
 * real part by the caller and handed to the slicer.
 */
async function writeEntryStreamed(
  entry: { stream(): NodeJS.ReadableStream },
  localPath: string,
  displayName: string,
  entryCap: number,
  totalRemaining: number,
): Promise<number> {
  let seen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.byteLength;
      if (seen > entryCap) return cb(entryTooBig(displayName, entryCap));
      if (seen > totalRemaining) return cb(zipTooBig());
      cb(null, chunk);
    },
  });

  try {
    await pipeline(entry.stream(), meter, createWriteStream(localPath));
  } catch (err) {
    await rm(localPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return seen;
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

function entryTooBig(name: string, cap: number): WireError {
  return new WireError(
    413,
    `"${name}" in that archive is bigger than the ${Math.max(
      1,
      Math.floor(cap / (1024 * 1024)),
    )} MB per-file limit.`,
    "zip_entry_too_large",
  );
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
