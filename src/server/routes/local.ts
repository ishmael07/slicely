// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attach-local — the desktop shortcut for a file that is ALREADY on
// this machine.
//
// In the Mac app the server and the browser are the same computer, so the
// ordinary multipart upload is a round trip through HTTP for bytes that never
// needed to move: a 300 MB STL is read off disk, framed into a request, written
// to a scratch file, and copied into the workspace. The preload can tell the
// client the real path of a dropped or picked file (`webUtils.getPathForFile`,
// `dialog.showOpenDialog`), so on the desktop the client sends the PATHS and the
// server copies the file in directly.
//
// WHICH MEANS THIS ENDPOINT TAKES A FILESYSTEM PATH FROM A CLIENT, and that is
// only ever acceptable under three conditions, all enforced below:
//
//   1. DESKTOP ONLY. Hosted mode refuses it outright (`forbidden_in_hosted_mode`).
//      On a shared server "read this path for me" is an arbitrary-file-read
//      primitive, and the person on the other end of the browser is not the
//      person who owns the disk.
//   2. THE USER'S OWN FILES ONLY. Every path goes through the same workspace
//      boundary the agent's tools use (session-context.ts's
//      `resolveInsideSessionWorkspace`): on the desktop that is the session
//      directory, the app's downloads folder, `$HOME` and `/Volumes` — with
//      hidden components (`~/.ssh`, `<workdir>/.session-secret`) refused, and
//      containment decided on the REAL path so a symlink can't step outside it.
//   3. MESHES ONLY. The extension must be one Slicely accepts. "Copy this file
//      into my workspace" is not a general-purpose file operation.
//
// The answer is byte-for-byte the shape of POST /api/upload's, so the client has
// one code path for what happens after a file is attached.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { ACCEPTED_UPLOAD_EXTS } from "../../shared/types";
import { isDesktop } from "../../main/mode";
import { resolveInsideSessionWorkspace } from "../../main/session-context";
import { acceptUploads } from "../../main/uploads";
import { WireError, sendError } from "../errors";
import { noLimit, type RouteLimitOptions } from "../security";

/** The same per-request file count POST /api/upload allows. */
const MAX_PATHS = 12;

export function createLocalRouter(opts: RouteLimitOptions = {}): Router {
  const router = Router();
  // Copying files and expanding archives is real work: the `heavy` tier, like
  // the upload it stands in for.
  const heavy = opts.limit ?? noLimit;

  router.post("/attach-local", heavy, async (req: Request, res: Response) => {
    try {
      if (!isDesktop()) {
        throw new WireError(
          403,
          "Attaching a file by path is only available in the Mac app. Upload it instead.",
          "forbidden_in_hosted_mode",
        );
      }

      const session = req.session!;
      const raw = (req.body as { paths?: unknown } | undefined)?.paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new WireError(400, "No files to attach.");
      }
      if (raw.length > MAX_PATHS) {
        throw new WireError(400, `Too many files at once (${MAX_PATHS} max).`, "too_large");
      }

      // Every path is vetted BEFORE anything is copied, so a batch either
      // attaches whole or is refused with the reason — half an attach is worse
      // than none when the user is about to slice what they dropped.
      const resolved: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new WireError(400, "That isn't a file.");
        }
        const ext = extname(entry).toLowerCase();
        if (!(ACCEPTED_UPLOAD_EXTS as readonly string[]).includes(ext)) {
          throw new WireError(
            400,
            `Unsupported file type "${ext || "(none)"}". Slicely accepts ${ACCEPTED_UPLOAD_EXTS.join(", ")}.`,
          );
        }
        const abs = resolveInsideSessionWorkspace(entry);
        if (!abs) {
          throw new WireError(400, "That file isn't somewhere Slicely is allowed to read.", "not_in_workspace");
        }
        const info = await stat(abs).catch(() => null);
        if (!info || !info.isFile()) {
          throw new WireError(400, "That file can't be read.");
        }
        resolved.push(abs);
      }

      // From here it is the ordinary upload pipeline: validation, ZIP
      // expansion, sliceable detection, landing in `<session>/uploads`.
      const uploaded = await acceptUploads(resolved, session.uploadsDir);
      if (uploaded.length === 0) {
        throw new WireError(400, "No printable mesh could be read from those files.");
      }

      session.activeModelPaths = uploaded.map((u) => u.localPath);
      session.lastActiveAt = Date.now();
      res.json({ uploaded, rejected: [] });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
