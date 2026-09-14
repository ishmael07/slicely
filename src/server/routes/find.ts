// ─────────────────────────────────────────────────────────────────────────────
// POST /api/find — finding a model without spending a token.
//
// THE CHEAPEST TURN IS THE ONE THAT NEVER HAPPENS. "find me a phone stand" does
// not need a model: it needs the sourcing layer, which is deterministic, already
// written, and free. So the composer routes a bare find/search phrase here
// instead of to /api/chat, and the transcript says so in one honest line.
//
// It runs the SAME fan-out the `find_models` tool runs, through the same façade —
// no second ranking implementation to drift, and no second set of source
// credentials. What it deliberately does NOT do is read a provider key, construct
// an agent, or charge an account: this path is free to everyone, signed in or not,
// which is the whole point of it existing.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadSourcingApi } from "../facades";
import { sendError, WireError } from "../errors";
import { noLimit, type RouteLimitOptions } from "../security";
import type { SourcingApi } from "../facades";

/** The longest query worth sending to eight model sites. Past this it is not a
 *  search, it is a sentence, and a sentence belongs in the chat. */
const MAX_QUERY_CHARS = 200;

/** Results returned. The same default the `find_models` tool uses, so the two
 *  paths show a visitor the same thing. */
const LIMIT = 12;

export function createFindRouter(
  api: SourcingApi | undefined = loadSourcingApi(),
  opts: RouteLimitOptions = {},
): Router {
  const router = Router();
  // The `heavy` tier: one call fans out to every model site, so it costs the
  // owner's bandwidth and their source quotas even though it costs no tokens.
  const heavy = opts.limit ?? noLimit;

  if (!api) {
    router.post("/find", (_req, res) => {
      sendError(res, new WireError(503, "Model sourcing is not available on this server yet."));
    });
    return router;
  }

  router.post("/find", heavy, async (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const query = typeof raw.query === "string" ? raw.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) {
      sendError(res, new WireError(400, `query is required, and at most ${MAX_QUERY_CHARS} characters.`));
      return;
    }

    try {
      const outcome = await api.searchModels(query, { limit: LIMIT });
      // The query goes back with the results so the client can label the cards
      // without trusting its own in-flight state.
      //
      // `sources` goes back too — which sites answered, which had nothing, which
      // failed — because a direct search deserves the same footnote the chat's
      // `find_models` gets (the SSE `info` frame already carries the whole
      // outcome, sources and all). It is the façade's own per-source summary —
      // id, count, duration, one-line reason — and exactly the object the chat
      // path already hands this same client, so no new shape and no new
      // exposure. The 502 below is the case where an upstream body could leak,
      // and that one still says nothing.
      res.json({ query, models: outcome.results, sources: outcome.sources });
    } catch {
      // Nothing from upstream is forwarded: sourcing failures quote other
      // people's response bodies (see routes/models.ts for the long version).
      sendError(res, new WireError(502, "None of the model sites answered. Try again in a moment."));
    }
  });

  return router;
}
