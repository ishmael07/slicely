// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search, POST /api/resolve, POST /api/import, GET /api/sources —
// the three ways a mesh enters a session's workspace that don't involve the
// chat agent directly: federated search, paste-a-link resolution, and the
// actual download. All backed by the v2 sourcing façade (src/main/sourcing).
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadSourcingApi } from "../facades";
import { noLimit, type RouteLimitOptions } from "../security";
import type { SourcingApi } from "../facades";
import type { SourceId, SearchOptions } from "../../shared/sourcing";

export function createModelsRouter(
  api: SourcingApi | undefined = loadSourcingApi(),
  opts: RouteLimitOptions = {},
): Router {
  const router = Router();
  // POST /api/import downloads a mesh from the internet — the `heavy` tier.
  const heavy = opts.limit ?? noLimit;

  if (!api) {
    router.use((_req, res) => {
      res.status(503).json({ error: "Model sourcing is not available on this server yet." });
    });
    return router;
  }

  router.get("/search", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    const opts: SearchOptions = {};
    if (typeof req.query.limit === "string") opts.limit = clampInt(req.query.limit, 1, 50, 12);
    if (typeof req.query.perSource === "string") opts.perSource = clampInt(req.query.perSource, 1, 50, 10);
    if (req.query.downloadableOnly === "true") opts.downloadableOnly = true;
    if (typeof req.query.sources === "string" && req.query.sources.trim()) {
      opts.sources = req.query.sources
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as SourceId[];
    }

    try {
      const outcome = await api.searchModels(q, opts);
      res.json(outcome);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message ?? "search failed" });
    }
  });

  router.post("/resolve", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    try {
      res.json(await api.resolveUrl(url));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message ?? "resolve failed" });
    }
  });

  router.post("/import", heavy, async (req: Request, res: Response) => {
    const session = req.session!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const source = typeof body.source === "string" ? (body.source as SourceId) : undefined;
    const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
    const fileId = typeof body.fileId === "string" ? body.fileId : undefined;

    try {
      // destDir keeps the download inside THIS session's own directory —
      // never the global downloads folder main/config.ts otherwise defaults
      // to, so one browser can never see another's imported models.
      const destDir = session.downloadsDir;
      const result = url
        ? await api.downloadFromUrl(url, { destDir })
        : source && modelId
          ? await api.downloadModel(source, modelId, { fileId, destDir })
          : undefined;

      if (!result) {
        res.status(400).json({ error: "Provide either { url } or { source, modelId }." });
        return;
      }

      session.activeModelPaths = result.parts?.length
        ? result.parts.map((p) => p.localPath)
        : [result.localPath];
      session.lastActiveAt = Date.now();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message ?? "import failed" });
    }
  });

  router.get("/sources", (_req: Request, res: Response) => {
    res.json(api.sourceAvailability());
  });

  return router;
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
