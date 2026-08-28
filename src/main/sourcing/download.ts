// The one shared, careful downloader. Every provider and the URL resolver
// funnel their final "put this on disk" step through here so the hard parts
// (streaming, size caps, real-type sniffing, zip-slip safety) are solved once.
//
// Design notes:
//   - Streams the HTTP response straight to a temp file on disk; the only
//     thing kept in memory is a small sniff buffer (<= 512 bytes) plus, for a
//     ZIP, one mesh entry at a time while it is extracted (matching the
//     existing project convention in ../meshzip.ts — extracting a *single*
//     mesh into memory is fine, buffering the whole archive or the whole
//     primary download is not).
//   - Sniffs magic bytes rather than trusting the URL extension or a
//     possibly-wrong Content-Type — catches a login-gated "download" that
//     silently serves an HTML page instead of erroring.
//   - Zip-slip guard: every archive entry is resolved through
//     `resolveZipEntryPath`, which strips directory components (basename
//     only) AND re-verifies the resolved path is still inside destDir before
//     anything is written.
import { createWriteStream, promises as fsp } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import unzipper from "unzipper";
import type { DownloadPart, DownloadResult } from "../../shared/types";
import { guardedFetch, safeText } from "./net";
import {
  filenameFromContentDisposition,
  filenameFromUrl,
  sanitizeFileName,
} from "./fsutil";
import { looksLikeErrorPage, sniffMagicBytes } from "./sniff";

/** Hard ceiling on any single file Slicely will pull down. Generous for
 *  meshes (even a dense scan is rarely more than a few hundred MB) while
 *  still bounding worst-case disk/bandwidth use from a misbehaving source. */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

/** Mesh extensions kept when expanding an archive. */
const ARCHIVE_MESH_EXTS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"];

export interface FetchToFileOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Used when the URL/Content-Disposition don't give a usable filename. */
  suggestedName?: string;
  signal?: AbortSignal;
}

/**
 * True when `candidate` resolves to a path inside `dir` (or dir itself).
 * Exported so the zip-slip guard is independently testable without a real
 * zip archive — see resolveZipEntryPath.
 */
export function isWithinDir(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  // NOTE: this must check for an actual ".." PATH SEGMENT (`rel === ".."` or
  // `rel` starting with `".." + sep`), not merely `rel.startsWith("..")` — a
  // perfectly safe, sanitized filename like "..-evil.dll" (produced when a
  // Windows-style "..\..\evil.dll" traversal has its backslashes swapped to
  // "_"/"-" by the filename sanitizer) also starts with the two characters
  // ".." without being a traversal at all, and a naive prefix check would
  // wrongly reject it.
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * The zip-slip guard. Takes a raw entry path exactly as it appears inside a
 * ZIP's central directory — which for a hostile archive might be
 * "../../../../etc/passwd" or an absolute path — and returns a path that is
 * guaranteed to land inside `destDir`, throwing if it somehow still wouldn't
 * (defense in depth on top of the basename-only strategy).
 */
export function resolveZipEntryPath(destDir: string, entryPath: string): string {
  const safeName = sanitizeFileName(basename(entryPath));
  const outPath = join(destDir, safeName);
  if (!isWithinDir(destDir, outPath)) {
    throw new Error(`Rejected unsafe zip entry path: ${entryPath}`);
  }
  return outPath;
}

/** Stream a URL to disk, enforcing a size cap, and report what the bytes
 *  actually look like. Never buffers the full response in memory. */
export async function fetchToFile(
  url: string,
  destDir: string,
  opts: FetchToFileOptions = {},
): Promise<{ path: string; fileName: string; sizeBytes: number; sniffed: ReturnType<typeof sniffMagicBytes> }> {
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const res = await guardedFetch(url, { headers: opts.headers, signal: opts.signal });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}) for ${url}: ${await safeText(res)}`);
  }
  if (!res.body) {
    throw new Error(`Empty response body for ${url}`);
  }

  const declaredLen = Number(res.headers.get("content-length") ?? "0");
  if (declaredLen > 0 && declaredLen > maxBytes) {
    throw new Error(
      `File too large (${declaredLen} bytes, cap is ${maxBytes}): ${url}`,
    );
  }

  const cdName = filenameFromContentDisposition(res.headers.get("content-disposition"));
  const rawName = cdName || opts.suggestedName || filenameFromUrl(url) || "download";
  await fsp.mkdir(destDir, { recursive: true });

  const tmpPath = join(destDir, `.slicely-dl-${process.pid}-${Date.now()}`);
  const write = createWriteStream(tmpPath);
  const reader = res.body.getReader();
  let sniffBuf = Buffer.alloc(0);
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `File exceeded the ${maxBytes}-byte cap while downloading: ${url}`,
        );
      }
      if (sniffBuf.length < 512) {
        sniffBuf = Buffer.concat([sniffBuf, chunk]).subarray(0, 512);
      }
      await new Promise<void>((resolve, reject) => {
        write.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      write.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    write.destroy();
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }

  // Re-sniff against the full buffer we kept (covers the binary-STL exact
  // file-size check, which needs the true total length).
  const finalBuf =
    total <= sniffBuf.length ? sniffBuf.subarray(0, total) : sniffBuf;
  const sniffed =
    total <= 512
      ? sniffMagicBytes(finalBuf)
      : sniffMagicBytes(await peekWithLength(tmpPath, sniffBuf, total));

  if (looksLikeErrorPage(sniffed)) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(
      `${url} returned a webpage instead of a file — the download is likely login-gated or the link expired.`,
    );
  }

  const fileName = sanitizeFileName(rawName);
  const finalPath = await uniquePath(join(destDir, fileName));
  await fsp.rename(tmpPath, finalPath);

  return { path: finalPath, fileName: basename(finalPath), sizeBytes: total, sniffed };
}

/** The binary-STL sniff needs the real total length to validate
 *  `84 + 50*triangleCount === length`; for anything over our 512-byte sniff
 *  window we build a small synthetic buffer carrying the true length via a
 *  cheap re-read of just the header instead of the whole file. */
async function peekWithLength(path: string, head: Buffer, totalLength: number): Promise<Buffer> {
  if (head.length >= 84) {
    // Fabricate a buffer of the true length whose first 84 bytes are real —
    // sniffMagicBytes only reads buf[80..84) and buf.length, never the body.
    const synthetic = Buffer.alloc(totalLength);
    head.copy(synthetic, 0, 0, Math.min(84, head.length));
    return synthetic;
  }
  return fsp.readFile(path).then((b) => b.subarray(0, Math.min(b.length, 512))).catch(() => head);
}

async function uniquePath(path: string): Promise<string> {
  try {
    await fsp.access(path);
  } catch {
    return path; // doesn't exist yet — safe to use as-is
  }
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Expand a ZIP already on disk into its contained mesh files, flattened
 *  into destDir. Reads the archive's central directory + one entry at a time
 *  from disk (never the whole archive into memory), and every entry path is
 *  passed through the zip-slip guard before anything is written. */
export async function expandZipFile(
  zipPath: string,
  destDir: string,
  maxEntryBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<DownloadPart[]> {
  await fsp.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  const parts: DownloadPart[] = [];

  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    if (entry.path.includes("__MACOSX")) continue;
    const ext = extname(entry.path).toLowerCase();
    if (!ARCHIVE_MESH_EXTS.includes(ext)) continue;
    if (entry.uncompressedSize > maxEntryBytes) {
      console.warn(
        `[sourcing/download] skipping oversized zip entry ${entry.path} (${entry.uncompressedSize} bytes)`,
      );
      continue;
    }

    const outPath = resolveZipEntryPath(destDir, entry.path);
    const content = await entry.buffer();
    await fsp.writeFile(outPath, content);
    parts.push({
      localPath: outPath,
      fileName: basename(outPath),
      sizeBytes: content.byteLength,
      ext,
    });
  }

  return parts;
}

/** Extensions that are themselves ZIP containers but are a single, terminal
 *  mesh file — never a "loose collection of meshes" archive to expand. 3MF
 *  is a zip containing (among other things) `3D/3dmodel.model`; AMF is
 *  usually plain XML but the spec also allows a zipped form. Both must be
 *  saved as-is, not unpacked. (Bug fix: a .3mf download was previously
 *  routed into the generic zip-expansion path — which correctly found no
 *  *.stl/*.3mf/etc. loose files INSIDE the 3MF container — and was thrown
 *  away as "no printable meshes found", silently dropping a perfectly good,
 *  natively-sliceable file. A model shipping ONLY a .3mf, with no separate
 *  .stl, failed to download at all.) */
const ZIP_BASED_MESH_EXTS = new Set([".3mf", ".amf"]);

/** The 3MF spec's required root part — its presence is the ground-truth
 *  signal that a zip is a 3MF file, independent of (and more reliable than)
 *  whatever extension the URL/Content-Disposition happened to report. */
async function looksLike3mfContainer(zipPath: string): Promise<boolean> {
  try {
    const directory = await unzipper.Open.file(zipPath);
    return directory.files.some((f) => f.path.toLowerCase() === "3d/3dmodel.model");
  } catch {
    return false;
  }
}

/** Rename a file on disk to end in `ext` if it doesn't already, returning
 *  the (possibly updated) path/name. Used when content-sniffing finds a 3MF
 *  container under a filename that didn't already say so. */
async function ensureExtension(path: string, fileName: string, ext: string): Promise<{ path: string; fileName: string }> {
  if (fileName.toLowerCase().endsWith(ext)) return { path, fileName };
  const newFileName = `${fileName}${ext}`;
  const newPath = join(dirname(path), newFileName);
  await fsp.rename(path, newPath);
  return { path: newPath, fileName: newFileName };
}

/**
 * Download `url` into `destDir`, auto-expanding a ZIP-of-meshes into its
 * mesh parts. This is the canonical entry point used by both
 * `downloadFromUrl` and every provider's `fileUrl`-based download path.
 */
export async function downloadUrlToDir(
  url: string,
  destDir: string,
  opts: FetchToFileOptions = {},
): Promise<DownloadResult> {
  let fetched = await fetchToFile(url, destDir, opts);
  let ext = extname(fetched.fileName).toLowerCase();

  const sniffedZip = fetched.sniffed === "zip" || ext === ".zip";
  let treatAsArchive = sniffedZip && !ZIP_BASED_MESH_EXTS.has(ext);

  // Extension didn't already say .3mf/.amf, but the bytes are a zip — check
  // for the 3MF root part before assuming this is a loose-file archive.
  if (treatAsArchive) {
    if (await looksLike3mfContainer(fetched.path)) {
      treatAsArchive = false;
      fetched = { ...fetched, ...(await ensureExtension(fetched.path, fetched.fileName, ".3mf")) };
      ext = ".3mf";
    }
  }

  if (!treatAsArchive) {
    // A single terminal file: a recognized mesh (including a zip-based one
    // like .3mf/.amf), or an unrecognized type returned as-is — the
    // resolver/caller decides whether an unrecognized type is acceptable.
    return {
      localPath: fetched.path,
      fileName: fetched.fileName,
      sizeBytes: fetched.sizeBytes,
      parts: [
        {
          localPath: fetched.path,
          fileName: fetched.fileName,
          sizeBytes: fetched.sizeBytes,
          ext,
        },
      ],
    };
  }

  // It's a genuine archive of loose files: expand into a per-download
  // subfolder so parts stay grouped, then remove the archive itself.
  const stem = sanitizeFileName(basename(fetched.fileName, extname(fetched.fileName)), "archive");
  const folder = join(destDir, stem);
  const parts = await expandZipFile(fetched.path, folder);
  await fsp.rm(fetched.path, { force: true });

  if (parts.length === 0) {
    throw new Error(`No printable meshes found in the downloaded archive from ${url}.`);
  }

  const primary =
    [...parts].filter((p) => p.ext === ".stl").sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ??
    [...parts].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];

  return {
    localPath: primary.localPath,
    fileName: primary.fileName,
    sizeBytes: primary.sizeBytes,
    parts,
  };
}
