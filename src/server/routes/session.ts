// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/session — "Delete my data", answered for real.
//
// A privacy policy that says the user can delete what we hold has to be backed
// by a single call that actually does it: the encrypted key, the chats, the
// uploads, the slices, the session record itself, and the cookie that pointed
// at it. Everything this server keeps about a visitor lives under their session
// directory or in that session's caches, so destroying the session IS the
// deletion — there is no second place to sweep.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { clearSessionCookie, type SessionStore } from "../session";
import { sendError } from "../errors";

export function createSessionRouter(store: SessionStore): Router {
  const router = Router();

  router.delete("/session", async (req: Request, res: Response) => {
    const id = req.session?.id;
    try {
      // Cancel a turn in flight first, so nothing is still writing into a
      // directory we're about to remove.
      req.session?.agent?.cancel();
      if (id) await store.destroy(id);
      // Clear the cookie even when there was no record to destroy: the next
      // request then mints a clean session instead of re-presenting a stale id.
      clearSessionCookie(res);
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
