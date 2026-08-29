// ─────────────────────────────────────────────────────────────────────────────
// The zero-install web server (P1). A plain Express app that reuses every
// portable module under src/main/* — the agent loop, the PrusaSlicer CLI
// wrapper, config, uploads — and the v2 façades under src/main/{printers,
// sourcing,jobs}, to serve the SAME product from a phone browser with no
// local install: no git clone, no npm install, no Anthropic/Thingiverse keys
// to find, no 300MB PrusaSlicer download.
//
// Before deploying this publicly, read ./LICENSING.md — PrusaSlicer is AGPL,
// and running it as a network service (which is exactly what this file does)
// carries obligations. That decision belongs to the repo owner.
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { corsGuard, JSON_BODY_LIMIT, rateLimiter, securityHeaders } from "./security";
import { SessionStore, sessionMiddleware, type ChatAgent } from "./session";
import { createChatRouter } from "./routes/chat";
import { createModelsRouter } from "./routes/models";
import { createUploadRouter } from "./routes/upload";
import { createSliceRouter } from "./routes/slice";
import { createSettingsRouter } from "./routes/settings";
import { createChatsRouter } from "./routes/chats";
import { createThumbsRouter } from "./routes/thumbs";
import { createPrintersRouter } from "./routes/printers";
import { createJobsRouter } from "./routes/jobs";

export interface CreateAppOptions {
  /** Inject a session store (tests use a temp-dir-backed one with a short
   *  idle timeout instead of the real `~/Slicely/sessions`). */
  sessionStore?: SessionStore;
  /** Inject a chat agent factory. Tests MUST override this with a stub —
   *  without it, /api/chat constructs a real SlicelyAgent (Anthropic client +
   *  live network calls) on first use, which is never appropriate in a test. */
  chatAgentFactory?: () => ChatAgent;
}

/** Repo root, resolved relative to THIS file's own location, so it's correct
 *  whether running compiled (`dist/server/index.js`, two levels under root)
 *  or straight from source (`src/server/index.ts`, also two levels under
 *  root) — e.g. via ts-node in local dev. */
const REPO_ROOT = join(__dirname, "..", "..");

/** Build the Express app. Exported (rather than only `startServer`) so tests
 *  can drive it directly with `fetch` against an ephemeral `http.Server`
 *  without going through the real network stack. */
export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind a hosted reverse proxy (Fly/Render/nginx/etc.) so req.secure and
  // req.ip reflect the real client, not the proxy hop.
  app.set("trust proxy", true);

  const store = opts.sessionStore ?? new SessionStore();

  app.use(securityHeaders());
  app.use(corsGuard());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(sessionMiddleware(store));

  // The zero-install client itself: static HTML/CSS served straight from
  // src/web (nothing to compile there), and the browser-targeted TS compiled
  // separately (see tsconfig.renderer.json) into dist-web/web — mounted at
  // "/web" so index.html's `<script src="/web/app.js">` resolves, without
  // also publishing the Electron renderer's compiled output that happens to
  // live alongside it under dist-web/.
  app.use(express.static(join(REPO_ROOT, "src", "web")));
  app.use("/web", express.static(join(REPO_ROOT, "dist-web", "web")));

  const api = express.Router();
  api.use(rateLimiter());
  api.use(createChatRouter(opts.chatAgentFactory));
  api.use(createModelsRouter());
  api.use(createUploadRouter());
  api.use(createSliceRouter());
  api.use(createPrintersRouter());
  api.use(createJobsRouter());
  api.use(createSettingsRouter());
  api.use(createChatsRouter());
  api.use(createThumbsRouter());
  app.use("/api", api);

  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

/** Boot the HTTP server on `SLICELY_PORT` (default 3000). Returns the raw
 *  `http.Server` plus the session store, so callers (and tests) can shut both
 *  down cleanly. */
export function startServer(port = Number(process.env.SLICELY_PORT) || 3000): {
  server: Server;
  store: SessionStore;
} {
  const store = new SessionStore();
  const app = createApp({ sessionStore: store });
  const server = createServer(app);

  server.listen(port, () => {
    console.log(`Slicely web server listening on :${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down…");
    store.stopSweep();
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, store };
}

if (require.main === module) {
  startServer();
}
