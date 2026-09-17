// /api/admin/* — the owner's dashboard data, and the four things the owner
// may do to an account from it.
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
// show it to. The PAGE at /admin is a public, empty shell (static.ts); these
// routes are the only things that ever hand out data or change it.
import { Router } from "express";
import type { Request, Response } from "express";
import { isHosted } from "../../main/mode";
import { adminSummary, releaseDownloads, type AdminDownloads } from "../../main/accounts/admin-summary";
import { addCredit, AdminActionError, removeAccount, setBlocked, zeroBalance } from "../../main/accounts/admin-actions";
import { normalizeEmail } from "../../main/accounts/email";
import { getAccount, type Account } from "../../main/accounts/store";
import { sendError, WireError } from "../errors";

const DEFAULT_REPO_URL = "https://github.com/ishmael07/slicely";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

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

/** The signed-in owner, or undefined — in which case the caller answers 404. */
function ownerOf(req: Request): Account | undefined {
  if (!isHosted()) return undefined;
  const id = req.session?.accountId;
  if (!id) return undefined;
  const admins = adminEmails();
  if (admins.size === 0) return undefined;
  const account = getAccount(id);
  return account && admins.has(account.normalizedEmail) ? account : undefined;
}

export interface AdminRouterOptions {
  /** Live sessions in this process, for the "right now" figure. */
  sessions: () => number;
  /** Mac download counts; the default asks GitHub (cached). Tests inject. */
  downloads?: () => Promise<AdminDownloads>;
}

export function createAdminRouter(opts: AdminRouterOptions): Router {
  const r = Router();
  const notFound = (res: Response) => sendError(res, new WireError(404, "Not found.", "not_found"));

  r.get("/admin/summary", (req: Request, res: Response) => {
    if (!ownerOf(req)) return notFound(res);
    const downloads =
      opts.downloads ?? (() => releaseDownloads(process.env.SLICELY_REPO_URL?.trim() || DEFAULT_REPO_URL));
    void downloads().then(
      (d) => {
        res.setHeader("Cache-Control", "no-store");
        res.json(adminSummary(opts.sessions(), Date.now(), d));
      },
      () => {
        res.setHeader("Cache-Control", "no-store");
        res.json(adminSummary(opts.sessions()));
      },
    );
  });

  // The actions. Each is a POST with the account id in the path; the owner's
  // gate and the 404 are the same as the summary's, so a stranger probing
  // these learns nothing. Errors from the actions carry their own codes.
  type Action = (id: string, body: Record<string, unknown>) => Promise<void>;
  const actions: Record<string, Action> = {
    block: async (id) => {
      await setBlocked(id, true);
    },
    unblock: async (id) => {
      await setBlocked(id, false);
    },
    credit: async (id, body) => {
      const cents = typeof body.cents === "number" ? body.cents : NaN;
      if (!Number.isInteger(cents)) throw new WireError(400, "Say how many cents to add.", "bad_amount");
      await addCredit(id, cents * 1_000_000);
    },
    zero: async (id) => {
      await zeroBalance(id);
    },
    delete: async (id) => {
      await removeAccount(id);
    },
  };

  r.post("/admin/accounts/:id/:action", (req: Request, res: Response) => {
    const owner = ownerOf(req);
    if (!owner) return notFound(res);
    const id = String(req.params.id ?? "");
    const verb = String(req.params.action ?? "");
    const action = Object.prototype.hasOwnProperty.call(actions, verb) ? actions[verb] : undefined;
    if (!action || !ACCOUNT_ID.test(id)) return notFound(res);
    // The owner cannot lock themselves out of the room they are standing in.
    if (id === owner.id && verb !== "credit") {
      return sendError(res, new WireError(400, "That's your own account.", "own_account"));
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    res.setHeader("Cache-Control", "no-store");
    void action(id, body).then(
      () => res.json({ ok: true }),
      (err: unknown) => {
        if (err instanceof AdminActionError) {
          const status = err.code === "not_found" ? 404 : 400;
          return sendError(res, new WireError(status, err.message, err.code));
        }
        sendError(res, err);
      },
    );
  });

  return r;
}
