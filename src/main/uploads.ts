// Accepts user-supplied CAD / mesh files (drag-drop or file picker), validates
// the type, and copies them into the workspace so the rest of the pipeline
// (inspect → recommend → slice) can treat them exactly like a downloaded model.
//
// PrusaSlicer slices mesh formats directly (STL/3MF/OBJ/AMF). It can also OPEN
// STEP/STP (it auto-meshes them on import in the GUI), but headless CLI slicing
// of STEP is unreliable across versions — so we mark STEP "import-only" and
// steer those into the GUI rather than a headless slice.
import { copyFile, stat, mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ACCEPTED_UPLOAD_EXTS } from "../shared/types";
import type { UploadResult } from "../shared/types";
import { getConfig } from "./config";
import { extractMeshesFromZip } from "./meshzip";

/** Mesh formats PrusaSlicer slices directly from the CLI. */
const SLICEABLE_EXTS = new Set([".stl", ".3mf", ".obj", ".amf"]);

function isAccepted(ext: string): boolean {
  return (ACCEPTED_UPLOAD_EXTS as readonly string[]).includes(ext);
}

/**
 * Copy one accepted (non-archive) mesh/CAD file into <workdir>/uploads and
 * describe it. Throws on an unsupported extension or unreadable source.
 * ZIP archives are handled by acceptUploads (they expand to many files).
 */
export async function acceptUpload(sourcePath: string): Promise<UploadResult> {
  const ext = extname(sourcePath).toLowerCase();
  if (!isAccepted(ext)) {
    throw new Error(
      `Unsupported file type "${ext || "(none)"}". Slicely accepts ${ACCEPTED_UPLOAD_EXTS.join(
        ", ",
      )}.`,
    );
  }

  const info = await stat(sourcePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`Can't read file: ${sourcePath}`);
  }

  const uploadsDir = join(getConfig().workdir, "uploads");
  await mkdir(uploadsDir, { recursive: true });

  const fileName = sanitizeFileName(basename(sourcePath));
  const localPath = join(uploadsDir, fileName);
  await copyFile(sourcePath, localPath);

  return {
    localPath,
    fileName,
    sizeBytes: info.size,
    ext,
    sliceable: SLICEABLE_EXTS.has(ext),
  };
}

/**
 * Accept many files, skipping (not failing on) ones that error. A `.zip` is
 * expanded in place into its contained mesh files, so dropping one archive of
 * parts yields multiple UploadResults the rest of the pipeline can arrange.
 */
export async function acceptUploads(paths: string[]): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const p of paths) {
    try {
      if (extname(p).toLowerCase() === ".zip") {
        out.push(...(await acceptZip(p)));
      } else {
        out.push(await acceptUpload(p));
      }
    } catch (err) {
      console.warn(`[uploads] skipped ${p}:`, (err as Error).message);
    }
  }
  return out;
}

/** Expand a ZIP of parts into one UploadResult per contained mesh. */
async function acceptZip(zipPath: string): Promise<UploadResult[]> {
  const buf = await readFile(zipPath);
  const stem = sanitizeFileName(basename(zipPath, ".zip"));
  const destDir = join(getConfig().workdir, "uploads", stem);
  const parts = await extractMeshesFromZip(buf, destDir);
  if (parts.length === 0) {
    throw new Error(`No printable meshes found in ${basename(zipPath)}.`);
  }
  return parts.map((p) => ({
    localPath: p.localPath,
    fileName: p.fileName,
    sizeBytes: p.sizeBytes,
    ext: p.ext,
    sliceable: SLICEABLE_EXTS.has(p.ext),
  }));
}

/** Comma-joined glob list for the native file picker dialog. */
export function pickerExtensions(): string[] {
  return ACCEPTED_UPLOAD_EXTS.map((e) => e.replace(/^\./, ""));
}

function sanitizeFileName(name: string): string {
  const reserved = new Set(["<", ">", ":", '"', "|", "?", "*", "/", "\\"]);
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue;
    out += reserved.has(ch) ? "_" : ch;
  }
  out = out.trim();
  return out.length > 0 ? out : "upload.stl";
}
