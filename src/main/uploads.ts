// Accepts user-supplied CAD / mesh files (drag-drop or file picker), validates
// the type, and copies them into the workspace so the rest of the pipeline
// (inspect → recommend → slice) can treat them exactly like a downloaded model.
//
// PrusaSlicer slices mesh formats directly (STL/3MF/OBJ/AMF). It can also OPEN
// STEP/STP (it auto-meshes them on import in the GUI), but headless CLI slicing
// of STEP is unreliable across versions — so we mark STEP "import-only" and
// steer those into the GUI rather than a headless slice.
import { copyFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ACCEPTED_UPLOAD_EXTS } from "../shared/types";
import type { UploadResult } from "../shared/types";
import { sessionUploadsDir } from "./session-context";
import { extractMeshesFromZip } from "./meshzip";
import { WireError } from "../server/errors";

/** Mesh formats PrusaSlicer slices directly from the CLI. */
const SLICEABLE_EXTS = new Set([".stl", ".3mf", ".obj", ".amf"]);

function isAccepted(ext: string): boolean {
  return (ACCEPTED_UPLOAD_EXTS as readonly string[]).includes(ext);
}

/** Where accepted files land when the caller doesn't say: the AMBIENT SESSION's
 *  uploads folder. For Electron (and anything outside a request) that is the
 *  default session, i.e. `<workdir>/uploads` — unchanged. For a hosted visitor
 *  it is their own session directory, so files never pile into one shared folder
 *  and a path outside the caller's workspace is never produced (Task D5).
 *  routes/upload.ts still passes its session's uploads dir explicitly. */
function defaultUploadsDir(): string {
  return sessionUploadsDir();
}

/**
 * Copy one accepted (non-archive) mesh/CAD file into `destDir` (default
 * <workdir>/uploads) and describe it. Throws on an unsupported extension or
 * unreadable source. ZIP archives are handled by acceptUploads (they expand to
 * many files).
 */
export async function acceptUpload(
  sourcePath: string,
  destDir?: string,
): Promise<UploadResult> {
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

  const uploadsDir = destDir ?? defaultUploadsDir();
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
 *
 * "Skipping, not failing" is right for a bad file (one unreadable STL in a drop
 * of twelve shouldn't lose the other eleven) and WRONG for a refusal we owe the
 * user an explanation for: a zip that blew the entry/size caps is rethrown so
 * the caller can answer with its code instead of a blank "nothing usable here".
 */
export async function acceptUploads(
  paths: string[],
  destDir?: string,
): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const p of paths) {
    try {
      if (extname(p).toLowerCase() === ".zip") {
        out.push(...(await acceptZip(p, destDir)));
      } else {
        out.push(await acceptUpload(p, destDir));
      }
    } catch (err) {
      if (err instanceof WireError) throw err;
      console.warn(`[uploads] skipped ${p}:`, (err as Error).message);
    }
  }
  return out;
}

/** Expand a ZIP of parts into one UploadResult per contained mesh. The path is
 *  handed straight to the extractor — never read into a Buffer here — so a
 *  200 MB upload doesn't sit in RAM twice (once in multer's own scratch copy
 *  on disk, once more if this read the whole thing back in). */
async function acceptZip(zipPath: string, destDir?: string): Promise<UploadResult[]> {
  const stem = sanitizeFileName(basename(zipPath, ".zip"));
  const parts = await extractMeshesFromZip(zipPath, join(destDir ?? defaultUploadsDir(), stem));
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
