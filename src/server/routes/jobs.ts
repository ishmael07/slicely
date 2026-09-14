// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs (plan), POST /api/jobs/:id/run (SSE JobEvent stream),
// GET /api/jobs, GET /api/jobs/:id — the job-level (multi-part, multi-plate)
// slicing flow, backed by the v2 jobs façade (src/main/jobs).
//
// Like routes/slice.ts, any G-code a plate produces is relocated into this
// session's own slices directory and exposed only via an opaque gcodeId — see
// session.ts's adoptGcodeFile.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadJobsApi } from "../facades";
import { noLimit, type RouteLimitOptions } from "../security";
import type { JobsApi, PlanJobPartInput } from "../facades";
import type { JobEvent, JobPlanOptions } from "../../shared/jobs";
import { adoptGcodeFile, isInsideDir, type SessionRecord } from "../session";
import { sendError, sendScrubbed, toWire, WireError } from "../errors";
import { withSliceQueueLimit, REST_SLICE_QUEUE_MS } from "../../main/prusaslicer";

export function createJobsRouter(
  api: JobsApi | undefined = loadJobsApi(),
  opts: RouteLimitOptions = {},
): Router {
  const router = Router();
  // Running a job spawns PrusaSlicer once per plate — the `heavy` tier.
  const heavy = opts.limit ?? noLimit;

  if (!api) {
    router.use((_req, res) => {
      sendError(res, new WireError(503, "Job planning is not available on this server yet."));
    });
    return router;
  }

  router.post("/jobs", async (req: Request, res: Response) => {
    const session = req.session!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      sendError(res, new WireError(400, "parts is required"));
      return;
    }
    for (const part of parts) {
      const p = (part as { path?: unknown }).path;
      if (typeof p !== "string" || !isInsideDir(session.dir, p)) {
        sendError(
          res,
          new WireError(400, "One or more of those files isn't in your workspace.", "not_in_workspace"),
        );
        return;
      }
    }
    const opts = (body.opts ?? {}) as JobPlanOptions;
    // The bed is the one option planning cannot invent: packing, oversize
    // checks and plate splitting are all measured against it. Coming off the
    // wire it is whatever the client sent, so check it here — otherwise a
    // missing bed surfaces as "Cannot read properties of undefined (reading
    // 'x')", which tells the user nothing they can act on.
    const bedError = describeBadBed(opts.bed);
    if (bedError) {
      sendError(res, new WireError(400, bedError));
      return;
    }
    try {
      const job = await api.planJob(parts as PlanJobPartInput[], opts);
      // Record ownership: main/jobs/store.ts is process-wide, so this set is
      // what keeps one visitor's jobs invisible to every other visitor.
      session.jobIds.add(job.id);
      session.lastActiveAt = Date.now();
      res.json(job);
    } catch (err) {
      // The planner's own complaints ("planJob requires at least one part.",
      // "part is larger than the bed") are exactly what the user needs to read,
      // so they are kept — with any absolute path scrubbed out of them.
      sendScrubbed(res, err, "That job couldn't be planned.", 422);
    }
  });

  router.post("/jobs/:id/run", heavy, async (req: Request, res: Response) => {
    const session = req.session!;
    // Only the session that planned a job may run it.
    if (!session.jobIds.has(req.params.id)) {
      sendError(res, new WireError(404, "Not found.", "not_found"));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Relocation is async (a file rename) but events must reach the browser
    // in the order the job façade emitted them — chain each relocate+write
    // onto the previous one rather than firing them off independently, which
    // could otherwise reorder frames if one rename happens to finish first.
    // Same long-silence problem as /api/chat: a plate can take minutes, and a
    // silent stream gets treated as dead by browsers and proxies.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 10_000);

    let chain: Promise<void> = Promise.resolve();
    const onEvent = (event: JobEvent) => {
      chain = chain
        .then(() => relocateJobEventGcode(session, event))
        .then((wire) => {
          res.write(`data: ${JSON.stringify(wire)}\n\n`);
        })
        .catch((err) => {
          console.error("[jobs] failed to relocate/emit job event:", err);
        });
    };

    try {
      // main/jobs/runner.ts already emits a job_done JobEvent through
      // onEvent, which the chain above relocates and writes. Writing another
      // one here sent two job_done frames per run, the second carrying
      // un-relocated paths. Just await the chain and let that event stand.
      // The other REST entry point into the slicer (main/jobs/runner.ts calls
      // prusaslicer.slice per plate) — same bounded queue wait as /api/slice.
      await withSliceQueueLimit(REST_SLICE_QUEUE_MS, () =>
        api.runJob(req.params.id, onEvent),
      );
      await chain;
    } catch (err) {
      await chain.catch(() => undefined);
      // Headers are long gone, so `sendError` can't answer here — but the frame
      // still has to carry the SAME vetted text a status code would have, not a
      // raw `err.message` full of absolute slicer paths.
      const { body } = toWire(err);
      res.write(
        `data: ${JSON.stringify({
          type: "job_failed",
          jobId: req.params.id,
          error: body.error,
          code: body.code,
        })}\n\n`,
      );
    } finally {
      clearInterval(keepAlive);
      session.lastActiveAt = Date.now();
      res.end();
    }
  });

  router.get("/jobs", async (req: Request, res: Response) => {
    const session = req.session!;
    const all = await api.listJobs();
    res.json(all.filter((j) => session.jobIds.has(j.id)));
  });

  /** Geometry for a whole plate, so the UI can show the real arrangement. */
  router.get("/jobs/:id/plate/:index/preview", async (req: Request, res: Response) => {
    const session = req.session!;
    if (!session.jobIds.has(req.params.id)) {
      sendError(res, new WireError(404, "Not found.", "not_found"));
      return;
    }
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 1) {
      sendError(res, new WireError(400, "Bad plate index."));
      return;
    }
    try {
      const { previewPlate } = await import("../../main/jobs");
      const mesh = await previewPlate(req.params.id, index);
      res.setHeader("Cache-Control", "private, max-age=600");
      res.json(mesh);
    } catch (err) {
      sendScrubbed(res, err, "Could not build a preview.", 422);
    }
  });

  router.get("/jobs/:id", async (req: Request, res: Response) => {
    const session = req.session!;
    // 404 rather than 403 for a job owned by someone else: a visitor should
    // not be able to probe which job ids exist on the server.
    if (!session.jobIds.has(req.params.id)) {
      sendError(res, new WireError(404, "Not found.", "not_found"));
      return;
    }
    const job = await api.getJob(req.params.id);
    if (!job) {
      sendError(res, new WireError(404, "Not found.", "not_found"));
      return;
    }
    res.json(job);
  });

  return router;
}

/** Rewrite any gcodePath(s) carried by a JobEvent to point at this session's
 *  own relocated copy, and attach a gcodeId the client can pass to /api/gcode
 *  or /api/printers/:id/send. Widened to a plain record (rather than the
 *  strict JobEvent union) so we're free to add the extra `gcodeId` field on
 *  the wire without fighting excess-property checks on a discriminated
 *  union — the browser only ever duck-types on `.type` anyway. */
/**
 * Why this bed cannot be used, or undefined when it is fine.
 *
 * Returns prose rather than a boolean because the message goes straight to a
 * user who is trying to work out what to fix.
 */
function describeBadBed(bed: JobPlanOptions["bed"] | undefined): string | undefined {
  if (!bed || typeof bed !== "object") {
    return "No printer bed size was supplied, so parts can't be arranged. Pick a printer first.";
  }
  for (const axis of ["x", "y", "z"] as const) {
    const v = (bed as Record<string, unknown>)[axis];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `The printer bed's ${axis} size is ${String(v)}, which isn't a usable measurement in mm.`;
    }
  }
  return undefined;
}

export async function relocateJobEventGcode(
  session: SessionRecord,
  event: JobEvent,
): Promise<Record<string, unknown>> {
  const wire = event as unknown as Record<string, unknown>;

  // The plate PROJECT travels with the plate too, so the browser can offer it:
  // a .3mf that opens in PrusaSlicer showing the arrangement and colours, which
  // is the closest a web page can get to "open it in the slicer".
  if (event.type === "plate_done") {
    const adopted = await adoptGcodeFile(session, event.metrics.gcodePath).catch(() => undefined);
    if (!adopted) return wire;
    return { ...wire, metrics: { ...event.metrics, gcodePath: adopted.path }, gcodeId: adopted.id };
  }

  if (event.type === "job_planned" || event.type === "job_done") {
    const plates = await Promise.all(
      event.job.plates.map(async (plate) => {
        const out: Record<string, unknown> = { ...plate };
        if (plate.gcodePath) {
          const adopted = await adoptGcodeFile(session, plate.gcodePath).catch(() => undefined);
          if (adopted) {
            out.gcodePath = adopted.path;
            out.gcodeId = adopted.id;
          }
        }
        // The .3mf project as well: it opens in PrusaSlicer showing the
        // arrangement, orientations and colours Slicely planned, which is the
        // closest a web page can get to "open it in the slicer".
        if (plate.projectPath) {
          const proj = await adoptGcodeFile(session, plate.projectPath).catch(() => undefined);
          if (proj) {
            out.projectPath = proj.path;
            out.projectId = proj.id;
          }
        }
        return out;
      }),
    );
    return { ...wire, job: { ...event.job, plates } };
  }

  return wire;
}
