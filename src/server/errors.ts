// ─────────────────────────────────────────────────────────────────────────────
// One funnel for every error that reaches a browser.
//
// Two rules, both learned from the way this server used to answer:
//
//  1. THE CLIENT GETS A CODE, NOT PROSE. `{ error, code }` with a stable code
//     (`no_key`, `key_rejected`, `rate_limited`, …) lets the UI do the right
//     thing — show the "connect your key" card, offer a retry — instead of
//     painting an arbitrary sentence red and leaving the user to guess.
//
//     THE ACCOUNTS AND FREE-TIER CODES, and there are exactly eight:
//       `signin_required`   — hosted, no account: sign in to spend free credit
//       `credit_exhausted`  — the grant is spent; add your own key
//       `free_tier_paused`  — the whole day's global spend cap is reached
//       `signup_limited`    — too many new accounts from one address today
//       `email_unverified`  — the provider has not verified the address
//       `email_blocked`     — a disposable domain: that ADDRESS cannot be used
//       `account_blocked`   — 409, this ACCOUNT cannot chat, whoever is paying.
//                             Refused before any provider call and before the
//                             own-key branch (main/agent/funding.ts); signing in
//                             is still allowed, so the person sees the sentence
//       `oauth_failed`      — anything else about a sign-in, and a visitor can
//                             only retry, so everything else folds into it
//     Each gets a sentence in `CODE_COPY` (src/web/api.ts) so the client's copy
//     and the server's cannot drift. `email_invalid` is a 400 on the waitlist
//     route only and is deliberately NOT a chat code: the one address a visitor
//     types themselves is the one they can be asked to retype.
//     The four sign-in codes do not travel in a body at all — the OAuth
//     callback is always a 302, and the code rides in the `#auth_error=`
//     fragment (see routes/auth.ts).
//
//  2. THE CLIENT LEARNS NOTHING ELSE. Routes used to relay `err.message`
//     straight out, which meant absolute server paths
//     (`/data/sessions/<id>/uploads/…`), upstream provider bodies, and internal
//     invariants all shipped to anyone who could provoke a failure. Anything
//     not explicitly mapped below becomes "Something went wrong." and the real
//     error is logged server-side instead.
// ─────────────────────────────────────────────────────────────────────────────
import type { Response } from "express";
import { getConfig } from "../main/config";
import { currentSessionId } from "../main/session-context";
import { NoApiKeyError, KeyFormatError } from "../main/userkey";
import { classifyProviderError } from "../main/agent/provider";

/** An error a route RAISES on purpose, already carrying what the client should
 *  be told. Anything else reaching `toWire` is treated as a bug and generalised. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface WirePayload {
  error: string;
  code?: string;
}

const GENERIC = "Something went wrong.";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Absolute-path prefixes worth scrubbing: the configured workdir (wherever the
 *  operator put it) plus the usual roots a server's files live under, so a path
 *  is caught even when it never passed through `getConfig()`. */
function pathPrefixes(): string[] {
  const roots = ["/Users", "/home", "/private", "/var", "/tmp", "/data", "/app", "/root"];
  try {
    const { workdir } = getConfig();
    if (workdir && workdir.startsWith("/")) roots.unshift(workdir);
  } catch {
    /* config unavailable — the generic roots still apply */
  }
  // Longest first so `<workdir>/sessions/x` isn't half-matched by `/Users`.
  return [...new Set(roots)].sort((a, b) => b.length - a.length).map(escapeRe);
}

/**
 * Replace absolute server filesystem paths with `<file>`.
 *
 * Deliberately greedy: a path fragment tells an attacker the deployment layout
 * and tells a user nothing they can act on (their files live in a browser, not
 * on our disk). Over-scrubbing a message is cheap; leaking a path is not.
 */
export function stripPaths(text: string): string {
  if (!text) return text;
  // At least one segment must follow the root, so ordinary prose that merely
  // starts like a path ("/variable", "/apps") is left alone.
  const re = new RegExp(`(?:${pathPrefixes().join("|")})(?:/[^\\s"'\`,;)\\]}]+)+`, "g");
  return text.replace(re, "<file>");
}

/**
 * Map any thrown value to the status + body a client should receive.
 *
 * A PROVIDER's own failure is mapped to the USER'S NEXT ACTION rather than
 * relayed or swallowed as a 500: a rejected key means "update it in Settings", a
 * 429 means "wait a moment", no credit means "top up the account behind the
 * key". Those are the three things that will actually go wrong for a
 * bring-your-own-key user, and each has a different fix.
 *
 * WHICH provider failed is asked of the providers themselves
 * (main/agent/provider.ts), not decided by a chain of `instanceof Anthropic.*`
 * here — this module has no business importing an SDK, and the copy it sends is
 * de-branded because a session may be on either key.
 */
export function toWire(err: unknown): { status: number; body: WirePayload } {
  if (err instanceof WireError) {
    return { status: err.status, body: withCode(stripPaths(err.message) || GENERIC, err.code) };
  }
  if (err instanceof NoApiKeyError) {
    return {
      status: 409,
      body: withCode(err.message || "Connect an AI API key in Settings to chat.", err.code),
    };
  }
  if (err instanceof KeyFormatError) {
    return { status: 400, body: withCode(err.message, err.code) };
  }
  const fromProvider = classifyProviderError(err);
  if (fromProvider) {
    return { status: fromProvider.status, body: withCode(fromProvider.message, fromProvider.code) };
  }

  // Unmapped: a bug, an upstream oddity, or something hostile. Log it where the
  // operator can see it (with the session id, so it can be correlated with a
  // report) and tell the client nothing.
  logInternal(err);
  return { status: 500, body: { error: GENERIC } };
}

function withCode(error: string, code?: string): WirePayload {
  return code ? { error, code } : { error };
}

function logInternal(err: unknown): void {
  // The user's API key is never part of a provider's error (it lives in a
  // request header no provider echoes) and never part of a WireError, so
  // this cannot log a secret. Keep it that way if you add fields here.
  //
  // The STACK, not just the message: an unmapped 500 is by definition one
  // nobody has a story for, and "TypeError: Cannot read properties of
  // undefined" with no frames names neither the file nor the call that did it.
  // The client still gets only `GENERIC` — the stack is for the server log,
  // which only the operator reads.
  const detail =
    err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  let session = "-";
  try {
    session = currentSessionId();
  } catch {
    /* outside a request */
  }
  console.error(`[server] unmapped error (session ${session}): ${detail}`);
}

/** Send `err` to the client through `toWire`. A no-op once the response has
 *  already begun (e.g. a failure mid-SSE-stream), where the caller must emit an
 *  in-band error event instead. */
export function sendError(res: Response, err: unknown): void {
  const { status, body } = toWire(err);
  if (res.headersSent) return;
  res.status(status).json(body);
}

/**
 * Answer a failure whose own wording is worth keeping, with paths scrubbed.
 *
 * `sendError` alone generalises anything it doesn't recognise to "Something
 * went wrong.", which is right for a bug but wrong for the large middle class
 * of failures where OUR OWN code has already written the sentence the user
 * needs: "transport is required", "The printer bed's x size is 0, which isn't a
 * usable measurement in mm", "planJob requires at least one part." Throwing
 * those away would replace an actionable complaint with a shrug.
 *
 * So: a `WireError` (or anything else `toWire` maps deliberately) is sent as
 * itself; anything else keeps its message with absolute paths replaced, under
 * the `status` the CALLER chose — because only the route knows whether an
 * unrecognised failure from the layer it just called is the client's fault
 * (422) or an upstream's (502).
 *
 * Use this ONLY where the thrown messages are ours. A failure carrying an
 * upstream provider's response body (see routes/models.ts) must not come
 * through here — its text is not ours to forward.
 */
export function sendScrubbed(res: Response, err: unknown, fallback: string, status = 422): void {
  if (err instanceof WireError) {
    sendError(res, err);
    return;
  }
  const message = err instanceof Error ? err.message : "";
  sendError(res, new WireError(status, stripPaths(message) || fallback));
}
