// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload — accepts the user's own CAD/mesh files via multer, then
// hands them to the REAL validation/zip-expansion/sliceable-detection logic
// in main/uploads.ts (acceptUploads) rather than re-deriving any of it.
//
// The one thing main/uploads.ts doesn't know about is sessions: it always
// copies into the single GLOBAL `<workdir>/uploads` directory (correct for
// the single-user Electron app; not correct for a server with many browsers
// in flight at once). So this route runs a temp file through acceptUploads()
// for its validation/expansion, then immediately MOVES the result(s) into
// this session's own uploads directory and forgets the global copy ever
// existed — see session.ts's header comment on file isolation.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, rename, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { ACCEPTED_UPLOAD_EXTS } from "../../shared/types";
import type { UploadResult } from "../../shared/types";
import { acceptUploads } from "../../main/uploads";
import { MAX_UPLOAD_BYTES } from "../security";

/** Track per-request extension rejections through multer's fileFilter, which
 *  otherwise drops a disallowed file silently (no error, no trace of its
 *  name) — we want to tell the user WHICH file(s) got skipped and why. */
interface RequestWithRejects extends Request {
  __rejectedUploads?: string[];
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 12 },
  fileFilter: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!(ACCEPTED_UPLOAD_EXTS as readonly string[]).includes(ext)) {
      const r = req as RequestWithRejects;
      (r.__rejectedUploads ??= []).push(file.originalname);
      cb(null, false);
      return;
    }
    cb(null, true);
  },
});

/** basename() only, with reserved/control characters scrubbed and any
 *  leading dots stripped — never trust an uploaded filename to be a safe
 *  single path segment. Mirrors the intent of main/uploads.ts's (unexported)
 *  sanitizer so a hostile "../../etc/passwd.stl"-style name can never place a
 *  temp file outside the scratch directory we create for it. */
function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"));
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "upload";
}

/** Find a filename in `dir` that doesn't collide with anything already moved
 *  there this request, by suffixing "-2", "-3", … before the extension. */
function dedupeName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export function createUploadRouter(): Router {
  const router = Router();

  router.post("/upload", (req: Request, res: Response) => {
    upload.array("files", 12)(req, res, async (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large — the limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB per file.`,
          });
        } else {
          res.status(400).json({ error: (err as Error).message ?? "upload failed" });
        }
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const rejected = [...((req as RequestWithRejects).__rejectedUploads ?? [])];

      if (files.length === 0) {
        res.status(400).json({
          error: `No accepted files. Slicely accepts ${ACCEPTED_UPLOAD_EXTS.join(", ")}.`,
          rejected,
        });
        return;
      }

      const session = req.session!;
      const scratch = await mkdtemp(join(tmpdir(), "slicely-up-"));
      const relocated: UploadResult[] = [];
      const takenNames = new Set<string>();

      try {
        await mkdir(session.uploadsDir, { recursive: true });

        for (const file of files) {
          // A random (never session-id-derived, never client-derived) prefix
          // is enough to avoid colliding with another upload mid-flight in
          // the shared global uploads dir main/uploads.ts writes to — the
          // prefix never survives past this handler.
          const tempName = `${randomBytes(4).toString("hex")}__${safeName(file.originalname)}`;
          const tempPath = join(scratch, tempName);
          await writeFile(tempPath, file.buffer);

          // One call per file (rather than batching the whole array through
          // acceptUploads) so we know which group of results — 1 for a plain
          // mesh, N for a ZIP of parts — came from THIS upload, and can keep
          // them grouped when relocating (two different ZIPs each containing
          // "part1.stl" must not collide once both land in one flat session
          // directory).
          const group = await acceptUploads([tempPath]).catch(() => []);
          if (group.length === 0) {
            rejected.push(file.originalname);
            continue;
          }

          const destDir =
            group.length > 1
              ? join(session.uploadsDir, dedupeName(takenNames, safeName(baseStem(file.originalname))))
              : session.uploadsDir;
          if (destDir !== session.uploadsDir) await mkdir(destDir, { recursive: true });

          for (const r of group) {
            // A single (non-ZIP) upload's `r.fileName` is just the temp name
            // we invented above (random-prefixed, to dodge a collision in the
            // shared global dir) — use the ORIGINAL name for display instead.
            // A ZIP's extracted parts already carry their own real names
            // (from inside the archive) and keep them as-is.
            const displayName = group.length === 1 ? safeName(file.originalname) : r.fileName;
            const cleanName = dedupeName(takenNames, safeName(displayName));
            const dest = join(destDir, cleanName);
            await rename(r.localPath, dest);
            relocated.push({ ...r, localPath: dest, fileName: cleanName });
          }
        }
      } catch (e) {
        res.status(400).json({ error: (e as Error).message ?? "upload failed" });
        return;
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }

      if (relocated.length === 0) {
        res.status(400).json({
          error: "No printable mesh could be read from the upload(s).",
          rejected,
        });
        return;
      }

      session.activeModelPaths = relocated.map((r) => r.localPath);
      session.lastActiveAt = Date.now();
      res.json({ uploaded: relocated, rejected });
    });
  });

  return router;
}

function baseStem(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
}
