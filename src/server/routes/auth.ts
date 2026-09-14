// ─────────────────────────────────────────────────────────────────────────────
// Two redirect routes, one signed-in view, and a way back out.
//
//   GET  /auth/:provider/start     → 302 to the provider, sealing a note
//   GET  /auth/:provider/callback  → 302 home, or home#auth_error=<code>
//   GET  /api/me                   → { signedIn, account? }
//   POST /api/auth/signout         → 204
//
// THREE THINGS ABOUT THE CALLBACK are worth reading before changing it:
//
//  1. EVERY EXIT IS A 302 WITH AN EMPTY BODY. Not an error page, not JSON, not
//     `res.redirect`'s courtesy "Found. Redirecting to …" HTML — nothing. A
//     body here would be a body rendered from a URL a stranger can shape, on
//     the one route that cannot use the ordinary CSRF defence, and there is
//     nothing in it anybody would read anyway.
//
//  2. THE FAILURE CODE TRAVELS IN THE FRAGMENT, `#auth_error=…`. A fragment is
//     never sent to a server, so it reaches no access log and no `Referer` —
//     and the client turns it into a sentence from the same CODE_COPY table the
//     rest of the app uses.
//
//  3. THE `state` COMPARISON IS THE CSRF DEFENCE, and it has to be, because
//     `corsGuard` cannot help: a provider-initiated top-level navigation
//     carries no `Origin`, and corsGuard passes a request with no Origin by
//     design. So the sealed note is compared with `timingSafeEqual` and the
//     note is cleared before anything else happens, whatever the outcome. The
//     note also carries the session it was sealed for, so finishing a sign-in
//     takes the browser that started it and not merely a copy of its note.
//
//  4. A CALLBACK CARRYING `?error=` IS NOT AN EXCHANGE. The visitor pressing
//     Cancel is the commonest way a sign-in ends, and it ends with them back
//     where they were and no apology on screen — see `providerRefusal`.
//
// The signup counter is charged ONLY for a genuinely new account, and the check
// happens BEFORE the create — so a refused signup leaves nothing behind at all.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { clientIp } from "../security";
import { WireError } from "../errors";
import { bindAccountToSession, unbindAccountFromSession } from "../session";
import { isHosted } from "../../main/mode";
import { centsToMicros } from "../../main/pricing";
import { EmailRejected, isDisposableDomain, normalizeEmail } from "../../main/accounts/email";
import { accountExistsFor, findOrCreateAccount, getAccount } from "../../main/accounts/store";
import { countSignup } from "../../main/accounts/signups";
import type { MeResponse } from "../../shared/types";
import { accountView } from "./config";
import { clearOauthState, readOauthState, startOauthState, statesMatch } from "../oauth/state";
import { httpFor, OauthError, providerFor, type OauthConfig } from "../oauth/index";
import { getConfig } from "../../main/config";

/** The four codes the callback can put in a fragment. Anything unmapped is
 *  `oauth_failed`, because a visitor can only ever retry. */
type AuthErrorCode = "oauth_failed" | "email_unverified" | "email_blocked" | "signup_limited";

/** `/auth/:provider/start` and `/auth/:provider/callback`. Mounted at `/auth`,
 *  in hosted mode only — see createApp. */
export function createAuthRouter(cfg: OauthConfig = {}): Router {
  const router = Router();

  router.get("/:provider/start", (req: Request, res: Response) => {
    const provider = providerFor(req.params.provider, cfg);
    // Unknown and merely-unconfigured are the SAME 404: which providers a
    // deployment has secrets for is not a fact worth publishing one route at a
    // time. `/api/config` says it once, deliberately.
    if (!provider) {
      notFound(res);
      return;
    }
    // The note is sealed TO THIS WORKSPACE: `/auth` sits behind the same session
    // middleware `/api` does, so there is always a session id here to seal it to.
    const state = startOauthState(res, provider.id, req.query.return_to, req.session?.id ?? "");
    redirect(res, provider.authorizeUrl(state));
  });

  router.get("/:provider/callback", async (req: Request, res: Response) => {
    const provider = providerFor(req.params.provider, cfg);
    if (!provider) {
      notFound(res);
      return;
    }
    // Read and clear FIRST: the note is single-use, and a note left behind
    // after a failure is a note that can be replayed.
    const state = readOauthState(req);
    clearOauthState(res);

    try {
      if (!state || state.provider !== provider.id) {
        throw new OauthError("oauth_failed", "The sign-in note was missing, expired, or for another provider.");
      }
      if (!statesMatch(state.state, req.query.state)) {
        throw new OauthError("oauth_failed", "The state the provider echoed is not the one we sealed.");
      }
      // The note also has to belong to the browser presenting it. Without this,
      // a note copied out of someone else's cookie jar (or planted in a visitor's
      // by anyone who can write cookies for this host) could be completed in a
      // workspace that never started a sign-in — and the account would bind to
      // whichever session finished.
      if (!statesMatch(state.sid, req.session?.id)) {
        throw new OauthError("oauth_failed", "The sign-in note was sealed for a different workspace.");
      }
      // THE PROVIDER MAY BE REPORTING A REFUSAL RATHER THAN A CODE, and then
      // there is nothing to exchange — asked before any outbound call.
      const refusal = providerRefusal(req.query.error);
      if (refusal === "declined") {
        // Pressing Cancel is not a failure: put them back where they were
        // standing, with NO `#auth_error` for the client to apologise about.
        redirect(res, state.returnTo);
        return;
      }
      if (refusal === "failed") {
        throw new OauthError("oauth_failed", `${provider.label} refused the sign-in: ${errorLabel(req.query.error)}`);
      }
      const raw = await provider.profile(String(req.query.code ?? ""), state, httpFor(cfg));
      if (!raw.emailVerified) {
        throw new OauthError("email_unverified", `${provider.label} has not verified that address.`);
      }
      // An address the provider gave us that we cannot parse is not the
      // visitor's problem to fix by retyping, so `email_invalid` becomes
      // `email_blocked` rather than asking them to correct something they never
      // typed. See `codeFor`.
      const email = normalizeEmail(raw.email);
      if (isDisposableDomain(email.domain)) throw new EmailRejected("email_blocked");

      // Asked BEFORE the create, and only for an identity we have never seen:
      // a refused signup must leave no account and no counter entry, and a
      // returning visitor must never be charged one.
      const first = !accountExistsFor(email.normalized);
      if (first) {
        const allowance = countSignup(clientIp(req));
        if (!allowance.allowed) {
          throw new WireError(429, "Too many new accounts from this address today.", "signup_limited");
        }
      }

      const { account } = findOrCreateAccount(
        {
          provider: provider.id,
          providerUserId: raw.providerUserId,
          email: email.email,
          normalizedEmail: email.normalized,
          name: raw.name,
        },
        centsToMicros(getConfig().freeCreditCents),
      );
      // A BLOCKED account still binds. Refusing a chat is POST /api/chat's job;
      // an account the client cannot see is an account the client cannot
      // explain, and "signed out for no stated reason" is the worse failure.
      bindAccountToSession(req.session!, account.id);
      redirect(res, state.returnTo);
    } catch (err) {
      logAuthFailure(req, err);
      redirect(res, withAuthError(state?.returnTo ?? "/", codeFor(err)));
    }
  });

  return router;
}

/** `GET /api/me` and `POST /api/auth/signout`. Mounted at `/api` in BOTH modes:
 *  the client asks who it is before it renders, and on the desktop the honest
 *  answer is "nobody, and there is nothing to sign in to". */
export function createMeRouter(cfg: OauthConfig = {}): Router {
  const router = Router();

  router.get("/me", (req: Request, res: Response) => {
    res.json(meFor(req, cfg));
  });

  router.post("/auth/signout", (req: Request, res: Response) => {
    // Idempotent: signing out twice, or when never signed in, is a 204. There is
    // nothing to report and nothing to enumerate.
    unbindAccountFromSession(req.session!);
    res.status(204).end();
  });

  return router;
}

/**
 * Who this request is, as the client sees it.
 *
 * Signed out unless ALL of: hosted mode, at least one provider configured, a
 * bound account id, and an account still on disk. The provider check is not
 * belt-and-braces — a deployment that has removed its OAuth secrets has removed
 * its accounts feature, and a session bound before that happened must not keep
 * reporting a balance nobody can spend.
 */
function meFor(req: Request, cfg: OauthConfig): MeResponse {
  const id = req.session?.accountId;
  if (!isHosted() || !id) return { signedIn: false };
  if (providerFor("google", cfg) === undefined && providerFor("github", cfg) === undefined) {
    return { signedIn: false };
  }
  const account = getAccount(id);
  if (!account) return { signedIn: false };
  return { signedIn: true, account: accountView(account) };
}

/** Append the failure code as a FRAGMENT, replacing any the `return_to` already
 *  had — two hashes in one URL means the second is just text inside the first,
 *  and the client would never see the code. */
function withAuthError(returnTo: string, code: AuthErrorCode): string {
  const hash = returnTo.indexOf("#");
  const base = hash < 0 ? returnTo : returnTo.slice(0, hash);
  return `${base || "/"}#auth_error=${code}`;
}

/** The two spellings of "the visitor pressed Cancel": `access_denied` is
 *  OAuth 2.0's (and Google's), `user_cancelled_authorize` is GitHub's. */
const DECLINED = new Set(["access_denied", "user_cancelled_authorize"]);

/** What `?error=` on the callback means: the visitor declined, the provider
 *  failed some other way, or there is no error and we have a code to exchange. */
function providerRefusal(raw: unknown): "declined" | "failed" | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return DECLINED.has(raw) ? "declined" : "failed";
}

/** A provider's error code, fit to appear in a log line — it arrives as a query
 *  parameter, so it is a stranger's bytes, and a newline in a log is a forged
 *  log entry. One short token of the safe alphabet, or nothing. */
function errorLabel(raw: unknown): string {
  const cleaned = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) : "";
  return cleaned.length > 0 ? cleaned : "unnamed";
}

function codeFor(err: unknown): AuthErrorCode {
  if (err instanceof OauthError) return err.code;
  // `email_invalid` folds into `email_blocked`: the address came from the
  // provider, so there is nothing for the visitor to retype.
  if (err instanceof EmailRejected) return "email_blocked";
  if (err instanceof WireError && err.code === "signup_limited") return "signup_limited";
  return "oauth_failed";
}

/**
 * A bare 302 with no body.
 *
 * `res.redirect` writes a small HTML page ("Found. Redirecting to …") that
 * echoes the target, and on this route the target can carry a fragment shaped by
 * whatever arrived in `return_to`. There is no reason to render anything, so
 * nothing is rendered.
 */
function redirect(res: Response, location: string): void {
  res.status(302).setHeader("Location", location);
  res.end();
}

/** An unknown provider answers here, in exactly the body and code the app's own
 *  catch-all 404 would have sent — the router is mounted, so a request that
 *  matched `/auth/:provider/*` never reaches that handler to borrow it. */
function notFound(res: Response): void {
  res.status(404).json({ error: "Not found.", code: "not_found" });
}

/**
 * Say what went wrong where only the operator can read it.
 *
 * The message is ours in every case that reaches here (see oauth/google.ts and
 * oauth/github.ts, which refuse to put an upstream body or a token in one), so
 * this cannot log a secret — keep it that way if you add fields. The visitor
 * gets a code in a fragment and nothing else.
 */
function logAuthFailure(req: Request, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[auth] ${req.params.provider} sign-in failed (${codeFor(err)}): ${detail}`);
}
