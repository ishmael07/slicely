// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/key and DELETE /api/key — connecting and disconnecting a visitor's
// own API key, for whichever provider they name (see main/userkey.ts for how it
// is stored, and main/agent/provider-*.ts for each provider's pattern, help copy
// and validation call).
//
// `provider` is OPTIONAL and defaults to "anthropic": this endpoint predates
// the second provider, and an older client sends no such field.
//
// A key is checked in two stages, because the two failures need different
// wording. The FORMAT check is local and instant, and is also where subscription
// credentials (`sk-ant-oat…` for Claude Pro/Max) are refused — they are not API
// keys and both providers forbid routing third-party traffic through them. The
// VALIDITY check then makes exactly one cheap, real call so a user learns at
// paste time that their key is wrong, instead of discovering it halfway through
// their first chat turn.
//
// The validator is injectable: tests hand in a verdict, so the whole surface can
// be exercised without a key, a network, or a provider's cooperation.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { clearUserApiKey, hasAnyUserApiKey, setUserApiKey, userKeyHint } from "../../main/userkey";
import { getProvider, isProviderId } from "../../main/agent/provider";
import type { KeyVerdict } from "../../main/agent/provider";
import type { ProviderId } from "../../shared/types";
import { sendError, WireError } from "../errors";
import { noLimit, type RouteLimitOptions } from "../security";

export type { KeyVerdict };
/** The injectable "is this key real?" check. Takes the provider because each one
 *  validates against its own API. */
export type KeyValidator = (provider: ProviderId, key: string) => Promise<KeyVerdict>;

/** The real check: one cheap call to the provider the key belongs to. */
export const validateWithProvider: KeyValidator = (provider: ProviderId, apiKey: string): Promise<KeyVerdict> =>
  getProvider(provider).validateKey(apiKey);

export function createKeyRouter(opts: { validate?: KeyValidator } & RouteLimitOptions = {}): Router {
  const validate = opts.validate ?? validateWithProvider;
  const router = Router();
  // Each PUT validates the pasted key against Anthropic — the `heavy` tier,
  // so a stolen session can't be used to hammer the provider through us.
  const heavy = opts.limit ?? noLimit;

  router.put("/key", heavy, async (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as { apiKey?: unknown; provider?: unknown };
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";

    try {
      const id = pickProvider(raw.provider);
      const provider = getProvider(id);
      if (!provider.keyPattern.test(apiKey)) {
        throw new WireError(400, provider.keyHelp.formatMessage(apiKey), "key_invalid_format");
      }

      const verdict = await validate(id, apiKey);
      if (verdict === "rejected") {
        throw new WireError(
          401,
          `${provider.label} rejected that key. Check you pasted all of it, that it hasn't been revoked, and that it isn't restricted.`,
          "key_rejected",
        );
      }
      if (verdict === "unreachable") {
        throw new WireError(502, `Couldn't reach ${provider.label} to check the key. Try again in a moment.`);
      }

      // Only now does the key touch disk, encrypted.
      setUserApiKey(id, apiKey);
      // The session's agent built a client from the PREVIOUS key and would keep
      // using it for the rest of the session — so re-keying after a rejection
      // would appear to work and then fail on every turn. Drop it; the next turn
      // builds a client with the new key. (A turn already streaming holds its own
      // reference and finishes on the old one.)
      forgetAgent(req);
      res.json({ hasKey: true, provider: id, keyHint: userKeyHint(id) });
    } catch (err) {
      // sendError, never `err.message`: a storage failure here could otherwise
      // put the session's directory path in the response.
      sendError(res, err);
    }
  });

  router.delete("/key", (req: Request, res: Response) => {
    try {
      // Accepted in the body OR the query: a DELETE with a body is legal but
      // awkward from some clients, and a wrong provider here would disconnect
      // the key the user meant to keep.
      const raw = (req.body ?? {}) as { provider?: unknown };
      const id = pickProvider(raw.provider ?? req.query.provider);
      clearUserApiKey(id);
      // Disconnecting means disconnecting: stop any turn in flight and drop the
      // agent, so nothing in this process keeps spending on a key the user just
      // took back.
      req.session?.agent?.cancel();
      forgetAgent(req);
      // `hasKey` stays the same question /api/config answers — "is there any key
      // at all" — so a user who disconnects one of two is not told they have none.
      res.json({ hasKey: hasAnyUserApiKey(), provider: id });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/** Which provider a request is about. Absent means "anthropic": every client
 *  written before OpenAI existed sends no provider at all, and PUT /api/key was
 *  an Anthropic-only endpoint then. */
function pickProvider(raw: unknown): ProviderId {
  if (raw === undefined || raw === null || raw === "") return "anthropic";
  if (!isProviderId(raw)) throw new WireError(400, "Unknown AI provider.");
  return raw;
}

/** Forget this session's cached agent, so the next chat turn constructs one
 *  against whatever key is connected now. */
function forgetAgent(req: Request): void {
  if (req.session) req.session.agent = undefined;
}

