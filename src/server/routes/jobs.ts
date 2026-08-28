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
import type { JobsApi, PlanJobPartInput } from "../facades";
import type { JobEvent, JobPlanOptions } from "../../shared/jobs";
import { adoptGcodeFile, isInsideDir, type SessionRecord } from "../session";

export function createJobsRouter(api: JobsApi | undefined = loadJobsApi()): Router {
  const router = Router();

  if (!api) {
    router.use((_req, res) => {
      res.status(503).json({ error: "Job planning is not available on this server yet." });
    });
    return router;
  }

  router.post("/jobs", async (req: Request, res: Response) => {
    const session = req.session!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      res.status(400).json({ error: "parts is required" });
      return;
    }
    for (const part of parts) {
      const p = (part as { path?: unknown }).path;
      if (typeof p !== "string" || !isInsideDir(session.dir, p)) {
        res.status(403).json({ error: "One or more part paths are outside this session's workspace." });
        return;
      }
    }
    const opts = (body.opts ?? {}) as JobPlanOptions;
    try {
      const job = await api.planJob(parts as PlanJobPartInput[], opts);
      session.lastActiveAt = Date.now();
      res.json(job);
    } catch (err) {
      res.status(422).json({ error: (err as Error).message ?? "planning failed" });
    }
  });

  router.post("/jobs/:id/run", async (req: Request, res: Response) => {
    const session = req.session!;
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
      const job = await api.runJob(req.params.id, onEvent);
      await chain;
      res.write(`data: ${JSON.stringify({ type: "job_done", job })}\n\n`);
    } catch (err) {
      await chain.catch(() => undefined);
      res.write(
        `data: ${JSON.stringify({
          type: "job_failed",
          jobId: req.params.id,
          error: (err as Error).message ?? String(err),
        })}\n\n`,
      );
    } finally {
      session.lastActiveAt = Date.now();
      res.end();
    }
  });

  router.get("/jobs", async (_req: Request, res: Response) => {
    res.json(await api.listJobs());
  });

  router.get("/jobs/:id", async (req: Request, res: Response) => {
    const job = await api.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Not found." });
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
async function relocateJobEventGcode(
  session: SessionRecord,
  event: JobEvent,
): Promise<Record<string, unknown>> {
  const wire = event as unknown as Record<string, unknown>;

  if (event.type === "plate_done") {
    const adopted = await adoptGcodeFile(session, event.metrics.gcodePath).catch(() => undefined);
    if (!adopted) return wire;
    return { ...wire, metrics: { ...event.metrics, gcodePath: adopted.path }, gcodeId: adopted.id };
  }

  if (event.type === "job_planned" || event.type === "job_done") {
    const plates = await Promise.all(
      event.job.plates.map(async (plate) => {
        if (!plate.gcodePath) return plate as unknown as Record<string, unknown>;
        const adopted = await adoptGcodeFile(session, plate.gcodePath).catch(() => undefined);
        if (!adopted) return plate as unknown as Record<string, unknown>;
        return { ...plate, gcodePath: adopted.path, gcodeId: adopted.id };
      }),
    );
    return { ...wire, job: { ...event.job, plates } };
  }

  return wire;
}
