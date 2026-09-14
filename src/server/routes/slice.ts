// ─────────────────────────────────────────────────────────────────────────────
// POST /api/slice, GET /api/gcode/:id, GET /api/status — drives PrusaSlicer
// directly through main/prusaslicer.ts (the same wrapper the Electron agent
// tools use), independent of the chat agent. This is deliberate: the REST
// slicing path never touches main/agent/state.ts's shared singleton, so it's
// safely concurrent across every session without needing the chat lock (see
// session.ts's withGlobalAgentLock, which is scoped to /api/chat only).
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { basename } from "node:path";
import {
  getModelInfo,
  recommendSettings,
  slice as sliceOne,
  slicePlates,
  getStatus,
  withSliceQueueLimit,
  REST_SLICE_QUEUE_MS,
  type RecommendInput,
} from "../../main/prusaslicer";
import type { SliceParams, PrintGoal, PrintMaterial } from "../../shared/types";
import { adoptGcodeFile, resolveSessionPath } from "../session";
import { sendError, WireError } from "../errors";
import { loadPrintersApi } from "../facades";
import { noLimit, type RouteLimitOptions } from "../security";

const GOALS: PrintGoal[] = ["draft", "quality", "functional"];
const MATERIALS: PrintMaterial[] = ["PLA", "PETG", "ABS"];
const DEFAULT_BED = { x: 250, y: 210, z: 210 };

export function createSliceRouter(opts: RouteLimitOptions = {}): Router {
  const router = Router();
  // Slicing is a PrusaSlicer subprocess — the `heavy` tier.
  const heavy = opts.limit ?? noLimit;

  router.get("/status", async (_req: Request, res: Response) => {
    res.json(await getStatus());
  });

  router.post("/slice", heavy, async (req: Request, res: Response) => {
    const session = req.session!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const rawPaths =
      Array.isArray(body.paths) && body.paths.every((p) => typeof p === "string")
        ? (body.paths as string[])
        : session.activeModelPaths;

    if (rawPaths.length === 0) {
      sendError(res, new WireError(400, "No model to slice — upload, import, or pass { paths }."));
      return;
    }
    // Never slice an arbitrary server path a client might pass in `paths` —
    // only files this session itself uploaded/imported/sliced-before. A client
    // names them the way it was told about them ("uploads/cube.stl"), which
    // `resolveSessionPath` turns into an absolute path INSIDE this session's
    // directory or into nothing at all.
    const requestedPaths: string[] = [];
    for (const p of rawPaths) {
      const abs = resolveSessionPath(session, p);
      if (!abs) {
        // 400 with the stable code, and a sentence that names nothing: the
        // reply used to be a 403, which — combined with the 404 an unknown
        // file gets elsewhere — let a caller tell "that file exists but isn't
        // yours" from "that file doesn't exist", i.e. probe another session's
        // workspace one guess at a time. The message must not echo the path
        // back either: a path is only ever ABSOLUTE here, and an echo would
        // confirm the sessions root to anyone who guessed a prefix.
        sendError(
          res,
          new WireError(400, "That file isn't in your workspace. Upload or import it first.", "not_in_workspace"),
        );
        return;
      }
      requestedPaths.push(abs);
    }

    const goal =
      typeof body.goal === "string" && (GOALS as string[]).includes(body.goal)
        ? (body.goal as PrintGoal)
        : undefined;
    const material =
      typeof body.material === "string" && (MATERIALS as string[]).includes(body.material)
        ? (body.material as PrintMaterial)
        : undefined;
    const overrides = (body.params && typeof body.params === "object" ? body.params : {}) as SliceParams;

    // Best-effort: if a printer id is given AND the printers façade happens
    // to be available, slice against its real bed/nozzle. Otherwise fall
    // back to a generic Prusa MK-class bed, same as the Electron defaults.
    let bed = DEFAULT_BED;
    let nozzleMm: number | undefined;
    if (typeof body.printerId === "string") {
      const printersApi = loadPrintersApi();
      if (printersApi) {
        try {
          const printers = await printersApi.listPrinters();
          const p = printers.find((pr) => pr.id === body.printerId);
          if (p?.bed) bed = p.bed;
          if (typeof p?.nozzleMm === "number") nozzleMm = p.nozzleMm;
        } catch {
          /* fall back to defaults below */
        }
      }
    }

    try {
      const primary = requestedPaths[0];
      const info = await getModelInfo(primary);
      const recInput: RecommendInput = { goal, material, nozzleMm, bed };
      const rec = recommendSettings(info, recInput);
      const params: SliceParams = {
        ...rec.params,
        ...overrides,
        extraInputs: requestedPaths.slice(1),
      };

      // Name the output after the model, not a timestamp. These files end up
      // on the user's SD card, where "slice-mtetrlng.gcode" next to five more
      // like it is unusable — they need to know which is which at the printer.
      const stem = basename(primary).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
      const suffix = Date.now().toString(36).slice(-4);
      const outName = `${stem || "slice"}-${suffix}`;
      // Bound the QUEUE wait (not the slice itself): a visitor who arrives
      // behind a full slicer is told "busy, try again" rather than holding a
      // connection open until a proxy kills it from the other end.
      const metricsList = await withSliceQueueLimit(REST_SLICE_QUEUE_MS, async () =>
        requestedPaths.length > 1
          ? (await slicePlates(requestedPaths, params, { w: bed.x, d: bed.y }, undefined, outName)).plates
          : [await sliceOne(primary, params, undefined, outName)],
      );

      // THE WIRE CARRIES A TOKEN AND A NAME, NEVER A PATH. `m.gcodePath` and
      // `info.filePath` are absolute server paths (`/data/sessions/<id>/…`), and
      // this success body used to ship both. A path in a 200 leaks the
      // deployment layout and the session id exactly as reliably as one in an
      // error does — and the client has never had a use for it: it downloads via
      // `/api/gcode/<id>` and prints via `{ gcodeId }`. So the path is replaced
      // by the opaque token plus the basename, which is the only part of it a
      // person actually reads ("bracket-k3j1.gcode").
      const plates: Array<Record<string, unknown>> = [];
      for (const m of metricsList) {
        const adopted = await adoptGcodeFile(session, m.gcodePath);
        const { gcodePath: _absolute, ...metrics } = m;
        plates.push({ ...metrics, gcodeId: adopted.id, displayName: basename(adopted.path) });
      }

      const { filePath: _modelPath, ...modelInfo } = info;
      session.lastActiveAt = Date.now();
      res.json({
        info: { ...modelInfo, displayName: basename(info.filePath) },
        rationale: rec.rationale,
        warnings: rec.warnings,
        plates,
      });
    } catch (err) {
      // Everything goes through the one funnel. A slice we gave up on carries
      // its own status and code (422 `slice_failed`, 503 `slicer_busy`, 504
      // `slice_timeout`); anything else is a bug and becomes a generic 500
      // rather than relaying `err.message`, which is how PrusaSlicer's stderr —
      // absolute session paths and all — used to reach the browser verbatim.
      sendError(res, err);
    }
  });

  /**
   * Geometry for the 3D preview. Decimated server-side, and the path is proven
   * to belong to the caller's own session before anything is read — this
   * returns file contents, so it is exactly the kind of endpoint a path
   * traversal would target.
   */
  router.get("/preview", async (req: Request, res: Response) => {
    const session = req.session!;
    const raw = typeof req.query.path === "string" ? req.query.path : "";
    if (!raw) {
      sendError(res, new WireError(400, "path is required"));
      return;
    }
    // Workspace-relative ("uploads/cube.stl") or absolute; either way it has to
    // land inside this session's own directory. See resolveSessionPath.
    const path = resolveSessionPath(session, raw);
    if (!path) {
      // Same answer, same reason, as POST /slice above.
      sendError(
        res,
        new WireError(400, "That file isn't in your workspace. Upload or import it first.", "not_in_workspace"),
      );
      return;
    }
    try {
      const { previewMesh } = await import("../../main/jobs");
      const mesh = await previewMesh(path);
      // Immutable for the life of the session's copy of the file.
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.json(mesh);
    } catch (err) {
      // Same funnel, same reason: `previewMesh` failures quote the file path.
      sendError(res, err);
    }
  });

  router.get("/gcode/:id", (req: Request, res: Response) => {
    const session = req.session!;
    const entry = session.gcodeFiles.get(req.params.id);
    if (!entry) {
      sendError(res, new WireError(404, "Not found.", "not_found"));
      return;
    }
    res.download(entry.path, basename(entry.label));
  });

  return router;
}
