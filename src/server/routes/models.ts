// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search, POST /api/resolve, POST /api/import, GET /api/sources —
// the three ways a mesh enters a session's workspace that don't involve the
// chat agent directly: federated search, paste-a-link resolution, and the
// actual download. All backed by the v2 sourcing façade (src/main/sourcing).
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadSourcingApi } from "../facades";
import { sendError, WireError } from "../errors";
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
      sendError(res, new WireError(503, "Model sourcing is not available on this server yet."));
    });
    return router;
  }

  router.get("/search", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      sendError(res, new WireError(400, "q is required"));
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
      sendSourcingError(res, err, "None of the model sites answered. Try again in a moment.");
    }
  });

  router.post("/resolve", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      sendError(res, new WireError(400, "url is required"));
      return;
    }
    try {
      res.json(await api.resolveUrl(url));
    } catch (err) {
      sendSourcingError(res, err, "That link couldn't be read.");
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
        sendError(res, new WireError(400, "Provide either { url } or { source, modelId }."));
        return;
      }

      session.activeModelPaths = result.parts?.length
        ? result.parts.map((p) => p.localPath)
        : [result.localPath];
      session.lastActiveAt = Date.now();
      res.json(result);
    } catch (err) {
      sendSourcingError(res, err, "That model couldn't be downloaded.");
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

/**
 * Answer a sourcing failure without quoting the upstream.
 *
 * Unlike the planner or the printer registry, the errors that come out of
 * main/sourcing carry OTHER PEOPLE'S text: `guardedFetch` throws
 * `` `${url} failed (${status}): ${await safeText(res)}` ``, i.e. a slice of
 * Thingiverse's / GitHub's / MyMiniFactory's response body. Forwarding that to
 * the browser hands a visitor an arbitrary upstream document (with whatever the
 * upstream chose to say about our owner-held API token in it), and tells them
 * nothing they can act on. So nothing is forwarded here.
 *
 * The URL guard's refusals ARE worth distinguishing, because they are the one
 * failure the user caused and can fix — a link pointing at localhost, at a
 * private address, at a non-http port. Those become the stable `host_blocked`
 * code with our own wording; everything else is the caller's fallback sentence.
 */
function sendSourcingError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof WireError) {
    sendError(res, err);
    return;
  }
  const message = err instanceof Error ? err.message : "";
  if (/^refusing to fetch|^not a valid url|^too many redirects/i.test(message)) {
    sendError(
      res,
      new WireError(400, "That link can't be fetched — it has to be a public http(s) URL.", "host_blocked"),
    );
    return;
  }
  sendError(res, new WireError(502, fallback));
}
