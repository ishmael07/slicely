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
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  corsGuard,
  JSON_BODY_LIMIT,
  LIMITS,
  noStore,
  rateLimiter,
  securityHeaders,
  type RateLimitOptions,
} from "./security";
import { SessionStore, sessionMiddleware, type ChatAgent } from "./session";
import { desktopTokenGuard, isLoopbackBindHost } from "./desktop-token";
import { isDesktop } from "../main/mode";
import { webStatic } from "./static";
import { sendError, WireError } from "./errors";
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
import { createLocalRouter } from "./routes/local";
import { createKeyRouter, type KeyValidator } from "./routes/key";
import { createSessionRouter } from "./routes/session";
import { loadPrintersApi } from "./facades";
import type { PrinterTestResult, ResolvedPrinter } from "../shared/printers";

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
  /** Replace the printer connection probe `POST /api/printers` makes on add.
   *  TESTS ONLY: it lets a test add a printer without a printer (or a network)
   *  on the other end. Never set in production. */
  printerTestOverride?: (printer: ResolvedPrinter) => Promise<PrinterTestResult>;
  /** The per-launch secret the Electron app requires on every request (desktop
   *  mode only — see desktop-token.ts). Absent in hosted mode, where the
   *  session cookie is the identity; present but inert if `SLICELY_MODE` isn't
   *  `desktop`. */
  desktopToken?: string;
  /** Narrow (or widen) the rate-limit tiers. Production uses the `LIMITS`
   *  values from spec §2 verbatim; a test overrides a tier so it can prove the
   *  limiter fires in three requests instead of sixty. */
  limits?: {
    api?: Partial<BucketOverride>;
    chat?: Partial<BucketOverride>;
    heavy?: Partial<BucketOverride>;
    /** Per-IP cap on minting brand-new sessions (default 20/hour). */
    mintPerHour?: number;
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
  // DESKTOP MODE CANNOT RUN WITHOUT A TOKEN. The guard used to be mounted only
  // when a token was passed, which meant the one configuration that most needed
  // it — desktop mode, a real TCP port on a machine with other processes on it —
  // was also the configuration that silently ran wide open if the caller forgot
  // the option. There is no sane fallback (there is no other identity in desktop
  // mode: every request resolves to the single workspace), so this is a refusal
  // to start rather than a warning. See desktop-token.ts.
  if (isDesktop() && !opts.desktopToken) {
    throw new Error(
      "SLICELY_MODE=desktop requires a per-launch desktop token: without it every " +
        "process on this machine could drive the app over its loopback port. " +
        "Pass `desktopToken` to createApp/startServer (main.ts mints one per launch).",
    );
  }
  // Before the static allow-list, and therefore before ANYTHING is served: in
  // desktop mode the app shell is as private as the API (desktop-token.ts).
  if (opts.desktopToken) app.use(desktopTokenGuard(opts.desktopToken));
  app.use(corsGuard());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // The zero-install client itself, plus the two legal pages. Served from an
  // explicit allow-list (static.ts), NOT by publishing a directory: `src/web`
  // is the source tree, so `express.static` on it handed out `app.ts` and
  // `app.js.map` along with everything anyone ever drops in there next. Every
  // URL this server serves off disk is one line in that table.
  app.use(webStatic(REPO_ROOT));

  const api = express.Router();
  // Before anything else, including the limiter's own 429s: no API response is
  // shareable between visitors (see noStore).
  api.use(noStore());
  // ORDER MATTERS, and this is the whole point of the arrangement:
  //   1. the session middleware VERIFIES the cookie (and mints one, per-IP
  //      capped, when there isn't a valid one), so that
  //   2. the limiter can key on a session id this server itself issued —
  //      never on an attacker-supplied cookie string.
  // Sessions are minted here and nowhere else: static files, /healthz and the
  // legal pages never touch the store.
  api.use(sessionMiddleware(store, { mintPerHour: opts.limits?.mintPerHour }));
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
  // Desktop's by-path alternative to /api/upload. Mounted in both modes so the
  // hosted server answers the honest 403 rather than a 404 that reads like a
  // deployment mistake.
  api.use(createLocalRouter({ limit: heavyLimit }));
  api.use(createSliceRouter({ limit: heavyLimit }));
  const printersApi = loadPrintersApi();
  if (opts.printerTestOverride) {
    // Test seam only (see the option's doc comment). Applied to the loaded
    // façade rather than threaded through the router, because the probe happens
    // two layers down inside addPrinter().
    printersApi?.setConnectionTestOverride?.(opts.printerTestOverride);
  }
  api.use(createPrintersRouter(printersApi));
  api.use(createJobsRouter(undefined, { limit: heavyLimit }));
  api.use(createSettingsRouter());
  api.use(createChatsRouter());
  api.use(createThumbsRouter());
  app.use("/api", api);

  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));

  // Nothing matched: not a route, and not one of the allow-listed static
  // files. Same JSON shape as every other failure, so a client never has to
  // guess whether a body is parseable.
  app.use((_req: Request, res: Response) => {
    sendError(res, new WireError(404, "Not found.", "not_found"));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // A body that blew the JSON limit is the one thing that reliably lands here
    // rather than in a route, and it has a real answer: the request was too
    // big. Everything else goes through the funnel, which logs the detail
    // server-side and tells the client only "Something went wrong." — never a
    // stack, a path, or an Express internal.
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") {
      sendError(res, new WireError(413, `Request body too large — the limit is ${JSON_BODY_LIMIT}.`, "too_large"));
      return;
    }
    sendError(res, err);
  });

  return app;
}

export interface StartServerOptions {
  /** Interface to bind. Hosted leaves it unset (every interface, which is what
   *  a container wants); the Mac app passes `127.0.0.1` so nothing outside the
   *  machine can even open a socket. */
  host?: string;
  /** TCP port. `0` asks the OS for a free one — what the Mac app does, since
   *  there is no fixed port it could claim on someone's own machine. */
  port?: number;
  /** The per-launch desktop secret (see desktop-token.ts). */
  desktopToken?: string;
  /** Inject a store (the Mac app doesn't; tests do). */
  store?: SessionStore;
}

/**
 * Boot the HTTP server and resolve once it is actually listening.
 *
 * Async and returning the real `port`/`url` because of `port: 0`: the Electron
 * app cannot load a window until it knows which port the OS handed out, and
 * that is only knowable after `listen` completes. Hosted callers get the same
 * shape with `SLICELY_PORT` (default 3000).
 */
export async function startServer(opts: StartServerOptions = {}): Promise<{
  server: Server;
  store: SessionStore;
  port: number;
  url: string;
}> {
  // DESKTOP MODE IS LOOPBACK-ONLY. The Mac app passes `127.0.0.1`; anything else
  // — an unset host (which binds every interface, the right default for a
  // container and the wrong one here), a LAN address, `0.0.0.0` — would publish
  // one person's workspace, their Anthropic key and their printers to the
  // network they happen to be on. The launch token would still be required, but
  // the port has no business being reachable in the first place, so this refuses
  // to listen rather than relying on the guard alone.
  if (isDesktop() && !isLoopbackBindHost(opts.host)) {
    throw new Error(
      `SLICELY_MODE=desktop must bind a loopback interface, not ${opts.host ?? "every interface"}: ` +
        "the Mac app's server is for the person sitting in front of it.",
    );
  }

  const store = opts.store ?? new SessionStore();
  const app = createApp({ sessionStore: store, desktopToken: opts.desktopToken });
  const server = createServer(app);

  const wanted = opts.port ?? (Number(process.env.SLICELY_PORT) || 3000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (opts.host) server.listen(wanted, opts.host, () => resolve());
    else server.listen(wanted, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  // A bound-to-everything server has no single hostname, so the URL says
  // loopback — the only address that is certainly ours to talk to.
  const urlHost = !opts.host || opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const url = `http://${urlHost.includes(":") ? `[${urlHost}]` : urlHost}:${port}`;
  console.log(`Slicely server listening on ${url}`);

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
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { server, store, port, url };
}

if (require.main === module) {
  void startServer().catch((err: unknown) => {
    console.error("Slicely server failed to start:", err);
    process.exit(1);
  });
}
