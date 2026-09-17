// GET /api/admin/summary — the owner's dashboard data.
//
// Who is the owner: a SIGNED-IN account whose e-mail is listed in
// SLICELY_ADMIN_EMAILS (comma-separated), compared the way grants compare
// addresses — normalised, so "Ish.Mael+x@gmail.com" and "ishmael@gmail.com"
// are the same person here as they are at sign-up. No separate password, no
// token in a URL: the same OAuth sign-in every visitor uses, plus a list.
//
// Everybody else gets a 404, not a 403: "forbidden" would confirm there is
// something to be forbidden from. The same 404 covers a desktop build (no
// accounts) and a hosted one with the variable unset — there is no owner to
// show it to. The PAGE at /admin is a public, empty shell (static.ts); this
// route is the only thing that ever hands out data.
import { Router } from "express";
import type { Request, Response } from "express";
import { isHosted } from "../../main/mode";
import { adminSummary } from "../../main/accounts/admin-summary";
import { normalizeEmail } from "../../main/accounts/email";
import { getAccount } from "../../main/accounts/store";
import { sendError, WireError } from "../errors";

/** The normalised admin addresses, or an empty set when none parse. */
export function adminEmails(raw: string | undefined = process.env.SLICELY_ADMIN_EMAILS): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      out.add(normalizeEmail(trimmed).normalized);
    } catch {
      // A malformed entry is ignored rather than failing the whole list: one
      // typo must not lock the owner out of the other address.
    }
  }
  return out;
}

export interface AdminRouterOptions {
  /** Live sessions in this process, for the "right now" figure. */
  sessions: () => number;
}

export function createAdminRouter(opts: AdminRouterOptions): Router {
  const r = Router();

  r.get("/admin/summary", (req: Request, res: Response) => {
    const notFound = () => sendError(res, new WireError(404, "Not found.", "not_found"));
    if (!isHosted()) return notFound();
    const id = req.session?.accountId;
    if (!id) return notFound();
    const admins = adminEmails();
    if (admins.size === 0) return notFound();
    const account = getAccount(id);
    if (!account || !admins.has(account.normalizedEmail)) return notFound();

    res.setHeader("Cache-Control", "no-store");
    res.json(adminSummary(opts.sessions()));
  });

  return r;
}
