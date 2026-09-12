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
import {
  corsGuard,
  JSON_BODY_LIMIT,
  LIMITS,
  rateLimiter,
  securityHeaders,
  type RateLimitOptions,
} from "./security";
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
import { createConfigRouter } from "./routes/config";
import { createKeyRouter, type KeyValidator } from "./routes/key";
import { createSessionRouter } from "./routes/session";

export interface CreateAppOptions {
  /** Inject a session store (tests use a temp-dir-backed one with a short
   *  idle timeout instead of the real `~/Slicely/sessions`). */
  sessionStore?: SessionStore;
  /** Inject a chat agent factory. Tests MUST override this with a stub —
   *  without it, /api/chat constructs a real SlicelyAgent (Anthropic client +
   *  live network calls) on first use, which is never appropriate in a test. */
  chatAgentFactory?: () => ChatAgent;
  /** Inject the "is this Anthropic key real?" check that PUT /api/key makes.
   *  Tests MUST override it — the default makes a live `models.list` call with
   *  the pasted key. */
  keyValidator?: KeyValidator;
  /** Narrow (or widen) the rate-limit tiers. Production uses the `LIMITS`
   *  values from spec §2 verbatim; a test overrides a tier so it can prove the
   *  limiter fires in three requests instead of sixty. */
  limits?: {
    api?: Partial<BucketOverride>;
    chat?: Partial<BucketOverride>;
    heavy?: Partial<BucketOverride>;
  };
}

/** The half of `RateLimitOptions` a caller may override per tier — the tier's
 *  `name` and key function are not negotiable. */
type BucketOverride = Omit<RateLimitOptions, "name" | "keyFn">;

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
  // Trust `X-Forwarded-*` ONLY when the operator says there really is a proxy
  // in front of us (Fly/Render/nginx set SLICELY_TRUST_PROXY=1). Trusting it
  // unconditionally would let any caller dictate req.ip — i.e. hand themselves
  // a fresh rate-limit bucket per request. security.ts's clientIp() reads the
  // same variable, so the two can never disagree.
  app.set("trust proxy", process.env.SLICELY_TRUST_PROXY === "1");

  const store = opts.sessionStore ?? new SessionStore();
  const tier = (base: RateLimitOptions, override?: Partial<BucketOverride>) =>
    rateLimiter({ ...base, ...override });
  const chatLimit = tier(LIMITS.chat, opts.limits?.chat);
  // ONE shared `heavy` bucket across every expensive endpoint: slicing,
  // importing, uploading and key validation all cost the server real work, so
  // ten of them in a burst is the budget however they're mixed.
  const heavyLimit = tier(LIMITS.heavy, opts.limits?.heavy);

  app.use(securityHeaders());
  app.use(corsGuard());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // The zero-install client itself: static HTML/CSS served straight from
  // src/web (nothing to compile there), and the browser-targeted TS compiled
  // separately (see tsconfig.renderer.json) into dist-web/web — mounted at
  // "/web" so index.html's `<script src="/web/app.js">` resolves, without
  // also publishing the Electron renderer's compiled output that happens to
  // live alongside it under dist-web/.
  app.use(express.static(join(REPO_ROOT, "src", "web")));
  app.use("/web", express.static(join(REPO_ROOT, "dist-web", "web")));

  const api = express.Router();
  // ORDER MATTERS, and this is the whole point of the arrangement:
  //   1. the session middleware VERIFIES the cookie (and mints one, per-IP
  //      capped, when there isn't a valid one), so that
  //   2. the limiter can key on a session id this server itself issued —
  //      never on an attacker-supplied cookie string.
  // Sessions are minted here and nowhere else: static files, /healthz and the
  // legal pages never touch the store.
  api.use(sessionMiddleware(store));
  api.use(tier(LIMITS.api, opts.limits?.api));
  // /api/config and /api/key first: they are what the client calls before it
  // can render anything, and they must keep answering even when a later
  // router's dependency (the sourcing façade, say) is missing.
  api.use(createConfigRouter());
  // PUT /api/key is `heavy`, not `api`: every call validates the pasted key
  // against Anthropic, so it costs an outbound request.
  api.use(createKeyRouter({ validate: opts.keyValidator, limit: heavyLimit }));
  api.use(createSessionRouter(store));
  api.use(createChatRouter(opts.chatAgentFactory, { limit: chatLimit }));
  api.use(createModelsRouter(undefined, { limit: heavyLimit }));
  api.use(createUploadRouter({ limit: heavyLimit }));
  api.use(createSliceRouter({ limit: heavyLimit }));
  api.use(createPrintersRouter());
  api.use(createJobsRouter(undefined, { limit: heavyLimit }));
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
