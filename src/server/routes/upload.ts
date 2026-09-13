// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload — accepts the user's own CAD/mesh files, then hands them to
// the REAL validation/zip-expansion/sliceable-detection logic in
// main/uploads.ts (acceptUploads) rather than re-deriving any of it.
//
// Two things this route owns that main/uploads.ts deliberately doesn't:
//
//  1. SESSIONS. main/uploads.ts defaults to the single global
//     `<workdir>/uploads` directory — correct for the single-user Electron app,
//     wrong for a server with many browsers in flight. So it is pointed at THIS
//     session's uploads directory and nothing is ever written outside
//     `<session>/` (see session.ts's header comment on file isolation).
//
//  2. BOUNDS. Bytes stream to `<session>/scratch` on disk and never through
//     RAM (multer 1.x's memoryStorage buffered up to 12 × 200 MB = 2.4 GB per
//     request), per-file and per-count limits are multer's, and the BATCH total
//     is counted by hand — multer has no per-request ceiling, so 12 × 200 MB
//     was authorised before.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm, rename, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { ACCEPTED_UPLOAD_EXTS } from "../../shared/types";
import type { UploadResult } from "../../shared/types";
import { acceptUploads } from "../../main/uploads";
import { WireError, sendError } from "../errors";
import {
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_BYTES,
  noLimit,
  type RouteLimitOptions,
} from "../security";

/** Track per-request extension rejections through multer's fileFilter, which
 *  otherwise drops a disallowed file silently (no error, no trace of its
 *  name) — we want to tell the user WHICH file(s) got skipped and why. */
interface RequestWithRejects extends Request {
  __rejectedUploads?: string[];
}

const MB = 1024 * 1024;

function tooLarge(): WireError {
  return new WireError(
    413,
    `Upload too large (${Math.floor(MAX_UPLOAD_BATCH_BYTES / MB)} MB max per batch).`,
    "too_large",
  );
}

/** `<session>/scratch` — where multer streams the raw multipart bytes before
 *  anything has been validated. The files are moved into `<session>/uploads`
 *  (or deleted) before the response; whatever an interrupted request abandons
 *  there is aged out by session.ts's file sweep, which covers `scratchDir`
 *  exactly like the other scratch directories. */
function scratchDirFor(req: Request): string {
  const dir = req.session!.scratchDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const upload = multer({
  // Disk, not memory: an upload is bytes on their way to PrusaSlicer, and a
  // shared host's RAM is not a staging area for 2.4 GB of someone's STLs.
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        cb(null, scratchDirFor(req));
      } catch (err) {
        cb(err as Error, "");
      }
    },
    // A random prefix, never derived from the session id or the client, keeps
    // two in-flight uploads of the same filename from colliding in the shared
    // scratch dir. It never survives past this handler — the file is renamed
    // to its real (sanitized, deduped) name on the way into uploads/.
    filename: (_req, file, cb) =>
      cb(null, `${randomBytes(8).toString("hex")}__${safeName(file.originalname)}`),
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 12,
    // A model upload carries no form fields; these only bound how much framing
    // a client can make busboy parse.
    fields: 4,
    parts: 20,
  },
  fileFilter: (req, file, cb) => {
    // Erroring here is multer's own abort path: it stops accepting parts,
    // deletes everything it already stored for this request, and hands the
    // error to the callback below — which is exactly the cleanup we want.
    if (bytesStoredSoFar(req) > MAX_UPLOAD_BATCH_BYTES) {
      cb(tooLarge());
      return;
    }
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

/**
 * The batch ceiling multer doesn't have, refused BEFORE a byte is read.
 *
 * Every real client — browser `FormData`, curl, our own web app — sends
 * `Content-Length`, so this is the path an honest oversized upload takes, and it
 * costs nothing: no bytes read, no files written, no cleanup.
 *
 * A client that omits the header (chunked encoding) or lies about it is caught
 * by the running total in `fileFilter` below instead.
 */
function rejectOversizedBatch(): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BATCH_BYTES) {
      sendError(res, tooLarge());
      // Discard the rest of the body rather than tearing the socket down: the
      // bytes go nowhere (no RAM, no disk), and the client gets to read the
      // reason it was refused instead of a connection reset. This is what
      // multer itself does on its own limit errors, and Node's requestTimeout
      // bounds how long a client can dribble the remainder out.
      req.resume();
      return;
    }
    next();
  };
}

/**
 * Bytes of this request already committed to disk, summed over the files multer
 * has finished storing. This is the running total that catches a client whose
 * `Content-Length` didn't tell the truth.
 *
 * It lags by at most the file currently streaming (multer fills in `size` when
 * a file's write completes, and inserts a placeholder with no `size` before
 * that), so the true worst case on disk is the 600 MB cap plus one 200 MB
 * file — bounded, which was the entire problem with 12 × 200 MB.
 */
function bytesStoredSoFar(req: Request): number {
  const files = (req.files as Array<{ size?: number }> | undefined) ?? [];
  return files.reduce((n, f) => n + (f.size ?? 0), 0);
}

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

export function createUploadRouter(opts: RouteLimitOptions = {}): Router {
  const router = Router();
  // Up to 12 files of up to 200 MB each, 600 MB total — the `heavy` tier.
  const heavy = opts.limit ?? noLimit;

  router.post("/upload", heavy, rejectOversizedBatch(), (req: Request, res: Response) => {
    upload.array("files", 12)(req, res, async (err: unknown) => {
      if (err) {
        await discard(req);
        if (err instanceof WireError) {
          sendError(res, err);
          return;
        }
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large — the limit is ${Math.floor(MAX_UPLOAD_BYTES / MB)} MB per file.`,
            code: "too_large",
          });
        } else if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_PART_COUNT") {
          res.status(413).json({ error: "Too many files in one upload (12 max).", code: "too_large" });
        } else {
          res.status(400).json({ error: (err as Error).message ?? "upload failed" });
        }
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const rejected = [...((req as RequestWithRejects).__rejectedUploads ?? [])];

      // Last line of the running total: every size is known now, so a batch
      // that slipped past the header pre-check and the one-file lag in
      // fileFilter still doesn't get processed or stored.
      if (bytesStoredSoFar(req) > MAX_UPLOAD_BATCH_BYTES) {
        await discard(req);
        sendError(res, tooLarge());
        return;
      }

      if (files.length === 0) {
        res.status(400).json({
          error: `No accepted files. Slicely accepts ${ACCEPTED_UPLOAD_EXTS.join(", ")}.`,
          rejected,
        });
        return;
      }

      const session = req.session!;
      const relocated: UploadResult[] = [];
      const takenNames = new Set<string>();

      try {
        await mkdir(session.uploadsDir, { recursive: true });

        for (const file of files) {
          // One call per file (rather than batching the whole array through
          // acceptUploads) so we know which group of results — 1 for a plain
          // mesh, N for a ZIP of parts — came from THIS upload, and can keep
          // them grouped when relocating (two different ZIPs each containing
          // "part1.stl" must not collide once both land in one flat session
          // directory).
          const group = await acceptUploads([file.path], session.uploadsDir);
          if (group.length === 0) {
            rejected.push(file.originalname);
            continue;
          }

          const destDir =
            group.length > 1
              ? join(session.uploadsDir, dedupeName(takenNames, safeName(baseStem(file.originalname))))
              : session.uploadsDir;
          if (destDir !== session.uploadsDir) await mkdir(destDir, { recursive: true });

          // A ZIP expanded into `<uploads>/<random-prefixed stem>/`; once its
          // parts are moved to their real home that staging folder is litter.
          const staging = dirname(group[0].localPath);

          // A plain mesh's `r.fileName` is the random-prefixed scratch name
          // multer invented, so the ORIGINAL name is used for display instead.
          // Parts out of a ZIP already carry their own real names (from inside
          // the archive) and keep them — including when the archive held just
          // one, where the original name would rename an .stl to ".zip".
          const fromArchive = extname(file.originalname).toLowerCase() === ".zip";

          for (const r of group) {
            const displayName =
              !fromArchive && group.length === 1 ? safeName(file.originalname) : r.fileName;
            const cleanName = dedupeName(takenNames, safeName(displayName));
            const dest = join(destDir, cleanName);
            if (dest !== r.localPath) await rename(r.localPath, dest);
            relocated.push({ ...r, localPath: dest, fileName: cleanName });
          }

          if (staging !== session.uploadsDir && staging !== destDir) {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      } catch (e) {
        if (e instanceof WireError) {
          sendError(res, e);
        } else {
          res.status(400).json({ error: (e as Error).message ?? "upload failed" });
        }
        return;
      } finally {
        await discard(req);
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

/** Remove whatever multer left in `<session>/scratch` for this request. Files
 *  that were accepted have already been renamed out of it, so this is either a
 *  no-op or a cleanup of bytes we refused. */
async function discard(req: Request): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  await Promise.all(
    files.map((f) => (f.path ? rm(f.path, { force: true }).catch(() => undefined) : undefined)),
  );
}

function baseStem(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
}
