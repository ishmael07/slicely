// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/key and DELETE /api/key — connecting and disconnecting the visitor's
// own Anthropic API key (see main/userkey.ts for how it is stored).
//
// A key is checked in two stages, because the two failures need different
// wording. The FORMAT check is local and instant, and is also where Claude
// Pro/Max subscription tokens (`sk-ant-oat…`) are refused — they are not API
// keys and Anthropic's terms forbid routing this traffic through them. The
// VALIDITY check then makes exactly one cheap, real call (`models.list`) so a
// user learns at paste time that their key is wrong, instead of discovering it
// halfway through their first chat turn.
//
// The validator is injectable: tests hand in a verdict, so the whole surface can
// be exercised without a key, a network, or Anthropic's cooperation.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_KEY_RE, clearUserApiKey, setUserApiKey, userKeyHint } from "../../main/userkey";
import { sendError, WireError } from "../errors";
import { noLimit, type RouteLimitOptions } from "../security";

/** What one validation attempt concluded. "unreachable" is deliberately NOT
 *  "rejected": refusing a good key because our own egress was down would send
 *  the user hunting for a new key they don't need. */
export type KeyVerdict = "ok" | "rejected" | "unreachable";
export type KeyValidator = (key: string) => Promise<KeyVerdict>;

/** How long to wait on Anthropic before calling it unreachable. Long enough for
 *  a slow TLS handshake, short enough that a paste doesn't hang the UI. */
const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * One `models.list` call with the user's key. No retries: this runs while
 * someone watches a spinner, and a retry storm on a bad key just delays the
 * "that key is wrong" they need to see.
 */
export const validateWithAnthropic: KeyValidator = async (apiKey: string): Promise<KeyVerdict> => {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: VALIDATE_TIMEOUT_MS });
  try {
    await client.models.list({ limit: 1 });
    return "ok";
  } catch (err) {
    // 401: wrong/revoked key. 403: a key that exists but isn't allowed to do
    // this — a workspace-scoped key, say. Both mean "this key won't work for
    // Slicely", which is the only thing the user can act on.
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return "rejected";
    }
    if (err instanceof Anthropic.APIConnectionError) return "unreachable";
    // Anything else (a 429 on the user's account, a 500 at Anthropic, an
    // unexpected shape) says nothing about the KEY. Accept it and let the first
    // real chat turn surface the actual problem with a mapped error.
    return "ok";
  }
};

export function createKeyRouter(opts: { validate?: KeyValidator } & RouteLimitOptions = {}): Router {
  const validate = opts.validate ?? validateWithAnthropic;
  const router = Router();
  // Each PUT validates the pasted key against Anthropic — the `heavy` tier,
  // so a stolen session can't be used to hammer the provider through us.
  const heavy = opts.limit ?? noLimit;

  router.put("/key", heavy, async (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as { apiKey?: unknown };
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";

    try {
      if (!ANTHROPIC_KEY_RE.test(apiKey)) {
        throw new WireError(400, formatMessage(apiKey), "key_invalid_format");
      }

      const verdict = await validate(apiKey);
      if (verdict === "rejected") {
        throw new WireError(
          401,
          "Anthropic rejected that key. Check you pasted all of it, that it hasn't been revoked, and that it isn't restricted to a workspace.",
          "key_rejected",
        );
      }
      if (verdict === "unreachable") {
        throw new WireError(502, "Couldn't reach Anthropic to check the key. Try again in a moment.");
      }

      // Only now does the key touch disk, encrypted.
      setUserApiKey(apiKey);
      // The session's agent built an Anthropic client from the PREVIOUS key and
      // would keep using it for the rest of the session — so re-keying after a
      // rejection would appear to work and then fail on every turn. Drop it;
      // the next turn builds a client with the new key. (A turn already
      // streaming holds its own reference and finishes on the old one.)
      forgetAgent(req);
      res.json({ hasKey: true, keyHint: userKeyHint() });
    } catch (err) {
      // sendError, never `err.message`: a storage failure here could otherwise
      // put the session's directory path in the response.
      sendError(res, err);
    }
  });

  router.delete("/key", (req: Request, res: Response) => {
    try {
      clearUserApiKey();
      // Disconnecting means disconnecting: stop any turn in flight and drop the
      // agent, so nothing in this process keeps spending on a key the user just
      // took back.
      req.session?.agent?.cancel();
      forgetAgent(req);
      res.json({ hasKey: false });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/** Forget this session's cached agent, so the next chat turn constructs one
 *  against whatever key is connected now. */
function forgetAgent(req: Request): void {
  if (req.session) req.session.agent = undefined;
}

/** Why the paste was refused, in terms of what the user should do next. */
function formatMessage(apiKey: string): string {
  if (!apiKey) return "Paste your Anthropic API key.";
  if (apiKey.startsWith("sk-ant-oat")) {
    return "That's a Claude Pro/Max subscription token, which can't be used here. Create an API key at console.anthropic.com — it starts with \"sk-ant-api\".";
  }
  return "That doesn't look like an Anthropic API key. Create one at console.anthropic.com — it starts with \"sk-ant-api\".";
}
