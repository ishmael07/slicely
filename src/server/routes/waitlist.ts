// ─────────────────────────────────────────────────────────────────────────────
// POST /api/waitlist — "tell me when a paid plan opens".
//
// 204 for a well-formed address, whether or not it was already on the list: see
// accounts/waitlist.ts for why a different answer would be an enumeration
// oracle. 400 `email_invalid` for something that is not an address at all —
// which is the one place in this plan that code appears, because this is the one
// address a visitor types themselves and so the one they can be asked to retype.
//
// `heavy` tier: every call appends to a file, so it is a write endpoint and is
// budgeted as one.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { noLimit, type RouteLimitOptions } from "../security";
import { sendError, WireError } from "../errors";
import { addToWaitlist } from "../../main/accounts/waitlist";
import { EmailRejected, normalizeEmail } from "../../main/accounts/email";

/** Long enough for any real name, short enough that the field cannot be used as
 *  storage. Truncated rather than refused: nobody's name being 101 characters is
 *  a reason to show them an error. */
const MAX_NAME = 100;

export function createWaitlistRouter(opts: RouteLimitOptions = {}): Router {
  const router = Router();

  router.post("/waitlist", opts.limit ?? noLimit, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { email?: unknown; name?: unknown };
      let email: string;
      try {
        // Normalised only to VALIDATE and to dedupe; what is stored is the
        // address as typed (see addToWaitlist).
        email = normalizeEmail(body.email).email;
      } catch (err) {
        if (err instanceof EmailRejected) {
          throw new WireError(400, "That doesn't look like an email address.", "email_invalid");
        }
        throw err;
      }

      const name = cleanName(body.name);
      addToWaitlist({
        ts: Date.now(),
        email,
        ...(name ? { name } : {}),
        // Only when they are signed in. No IP: this file has no retention
        // policy, and the privacy policy promises one for addresses.
        ...(req.session?.accountId ? { accountId: req.session.accountId } : {}),
      });
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/**
 * The optional name, or `undefined`.
 *
 * A non-string is simply absent — the field is optional, and refusing a request
 * over it would be pedantry. A CONTROL CHARACTER is refused outright: the file
 * is one entry per line so that `wc -l` counts it, and while `JSON.stringify`
 * would escape a newline anyway, a format that is only safe by accident is one
 * somebody will break. The 400 carries no `code`: there are exactly seven new
 * stable codes in this plan and this is not one of them, and the sentence says
 * all there is to say.
 */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new WireError(400, "That name can't be used — it has a line break in it.");
  }
  return name.slice(0, MAX_NAME);
}
