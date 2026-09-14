// ─────────────────────────────────────────────────────────────────────────────
// api.ts — every HTTP call the browser client makes.
//
// One place for the wire format so the rest of the client never touches
// `fetch()` directly. The server answers every failure with
// `{ error: string, code?: string }`, so ApiError carries both: `code` is the
// stable machine-readable half (`no_key`, `key_rejected`,
// `key_invalid_format`, `rate_limited`, …) that callers switch on, and
// `message` is the human half that goes on screen.
//
// No runtime imports: this module is plain browser ESM compiled by
// tsconfig.renderer.json, loaded straight from dist-web/web.
// ─────────────────────────────────────────────────────────────────────────────

/** A non-2xx answer from the Slicely server. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** `Retry-After`, in seconds, when the server sent one (it does on both 429
   *  paths — the per-session tier limiter and the per-IP session-mint cap). The
   *  two differ by two orders of magnitude, which is the whole reason this is
   *  carried: see `rateLimitedCopy`. */
  readonly retryAfterSec?: number;

  constructor(message: string, status: number, code?: string, retryAfterSec?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

interface WireError {
  error?: string;
  code?: string;
}

async function readBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/** `Retry-After` as a number of seconds, when the header is present and is the
 *  delta-seconds form the server sends. No CORS work is needed to read it: the
 *  client is same-origin with the server by construction (corsGuard refuses
 *  anything else outright), and `Access-Control-Expose-Headers` only ever
 *  governs a cross-origin response. */
function retryAfterSeconds(resp: Response): number | undefined {
  const raw = resp.headers.get("Retry-After");
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
}

function fail(url: string, resp: Response, body: WireError): never {
  throw new ApiError(
    body.error ?? `${url} failed (${resp.status})`,
    resp.status,
    body.code,
    retryAfterSeconds(resp),
  );
}

// ── code-driven copy ─────────────────────────────────────────────────────────
//
// The server already scrubs its own `error` text (see ../server/errors.ts —
// no path, no stack ever lands in `message`), but its wording is free to
// change and is written for whichever route raised it. A `code` is the part
// that is contractually stable, so for the codes a user can actually hit we
// author the sentence here once and let every caller show the same short,
// calm line no matter which endpoint failed or how the server phrased it.
// Anything without a mapped code falls back to the server's own message.
/**
 * "Slow down" reads one way for a burst and another way for a lockout.
 *
 * There are two 429s, and they are not the same event. The per-session TIER
 * limiter (60 burst / 5 per second on `api`) refills in a second or two — a
 * user who clicked too fast, and "a few seconds" is exactly right. The per-IP
 * SESSION-MINT cap (20 an hour) refills in about three MINUTES, and it is the
 * one a first-time visitor hits: telling them to try again in a few seconds
 * sends them into a reload loop that can never succeed and reads as a broken
 * site rather than a limit.
 *
 * So the sentence follows the server's own `Retry-After` rather than guessing.
 * Over a minute, it says how many minutes; under, it keeps the short line —
 * "try again in about 1 minute" would be a worse way to say "a few seconds".
 */
const RATE_LIMITED_SHORT = "Slow down a little — try again in a few seconds";

export function rateLimitedCopy(retryAfterSec?: number): string {
  if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec) || retryAfterSec <= 60) {
    return RATE_LIMITED_SHORT;
  }
  const minutes = Math.max(1, Math.round(retryAfterSec / 60));
  return `Slow down a little — try again in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const CODE_COPY: Record<string, string> = {
  no_key: "Connect your Anthropic API key to chat.",
  key_rejected: "Your Anthropic key was rejected — update it in Settings.",
  key_invalid_format: "That doesn't look like a valid Anthropic API key.",
  rate_limited: RATE_LIMITED_SHORT,
  // The page asked for something before it had a session (or after the server
  // forgot it). api.ts boots again and retries once by itself, so this line is
  // only reached if that second attempt failed too.
  no_session: "Reload Slicely to start a new session.",
  slicer_busy: "PrusaSlicer is busy with another job — try again shortly.",
  slice_failed: "PrusaSlicer couldn't slice this. Try adjusting the settings, or check the model.",
  slice_timeout: "Slicing took too long and was stopped.",
  zip_entry_too_large: "That archive has a file too large to unpack.",
  zip_too_many_entries: "That archive has too many files to unpack.",
  not_in_workspace: "That file is outside your workspace.",
  forbidden_in_hosted_mode: "Not available on a shared server.",
  cross_origin: "That request was blocked for security reasons.",
  // Desktop only: the per-launch token this window was given is missing, stale
  // (the app was relaunched behind an old window) or the request reached the
  // server under a host name that isn't its own. Reopening the app is the fix,
  // and the only one the user can carry out.
  forbidden: "This window isn't allowed to talk to the app. Reopen Slicely.",
  billing: "Your Anthropic account has no available credit.",
  busy: "Still working on your last message — wait for it to finish.",
  not_found: "That wasn't found. It may have already been removed.",
  too_large: "That's too large.",
  host_blocked: "That printer's address isn't allowed.",
};

/**
 * The product's copy for a stable error `code`, if one is mapped.
 *
 * `retryAfterSec` refines exactly one of them — see `rateLimitedCopy`. Every
 * other code reads the same however long the server said to wait.
 */
export function codeMessage(code?: string, retryAfterSec?: number): string | undefined {
  if (code === "rate_limited") return rateLimitedCopy(retryAfterSec);
  return code ? CODE_COPY[code] : undefined;
}

/**
 * One short, safe line for any failure this module can throw: a stable
 * `code`'s copy always wins (so the same code reads the same way everywhere,
 * and a server-side wording change can't surprise the UI); otherwise the
 * server's own (already scrubbed) message; otherwise `fallback`. Never a raw
 * server path or stack — neither can reach `ApiError.message` in the first
 * place.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) return codeMessage(err.code, err.retryAfterSec) ?? err.message ?? fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// ── the boot gate ────────────────────────────────────────────────────────────
//
// EVERY request in this module waits for ONE `GET /api/config` to come back
// first, because that is the call that gives this browser its session cookie.
//
// It used to be that the page's modules each fetched what they needed as soon
// as they loaded — `/api/config`, `/api/status`, `/api/settings`,
// `/api/printers`, `/api/printers/status`, `/api/sources`, … — all in the same
// tick, all before any cookie existed. The server minted a workspace per
// request (7–12 of them per page load, measured), the browser kept only the
// last `Set-Cookie`, and everything done during those first seconds belonged to
// a session the browser then abandoned: attach a model while the page was still
// booting and "Delete my data" deleted somebody else's empty directory.
//
// The server now refuses to mint a workspace for anything but this one call
// (401 `no_session`), so ordering it here is not politeness — it is the
// contract. One promise, created on first use and shared by every caller, so
// the calls that used to race now queue behind the cookie they all need.

const CONFIG_URL = "/api/config";

/** The in-flight (or settled) boot call. Cleared on failure so a later call
 *  retries rather than inheriting a dead promise forever. */
let booting: Promise<Record<string, unknown>> | undefined;

/**
 * The boot call's result, making it exactly once per page.
 *
 * Exported so the module that renders the first screen can READ the config it
 * already paid for instead of asking for it a second time (see onboarding.ts's
 * `loadConfig`), and so a caller outside this module — a file dropped on the
 * page while it is still booting — can wait for the same promise.
 */
export function ready(): Promise<Record<string, unknown>> {
  booting ??= bootstrap();
  return booting;
}

/** Throw away the session we thought we had, so the next call boots again.
 *  Used when the server tells us our cookie names nothing (`no_session`) —
 *  which is what a server restart looks like from here, since the session table
 *  is in memory. */
export function resetSession(): void {
  booting = undefined;
}

async function bootstrap(): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(CONFIG_URL);
    const data = await readBody(resp);
    if (!resp.ok) fail(CONFIG_URL, resp, data as WireError);
    return data;
  } catch (err) {
    // A failed boot is not a permanent verdict: the network comes back, and a
    // 429 from the per-IP mint cap refills. Let the next caller try again.
    booting = undefined;
    throw err;
  }
}

/**
 * One request, after the boot call, retried once if the server says our session
 * is gone.
 *
 * `perform` is called with no arguments and must build the request fresh each
 * time — a retry cannot reuse a consumed `Response`, and a `FormData` body is
 * safe to send twice only because nothing has read it yet.
 */
async function withSession(
  perform: () => Promise<Response>,
): Promise<{ resp: Response; body: Record<string, unknown> }> {
  // The boot call's own failure IS this request's failure — a 429 from the
  // per-IP mint cap, or the network being down — and it arrives with its `code`
  // intact so the UI can tell those two apart (see errorMessage / CODE_COPY).
  await ready();
  let resp = await perform();
  let body = await readBody(resp);
  if (resp.status === 401 && (body as WireError).code === "no_session") {
    // Our cookie names a session this server no longer has (it restarted, or
    // the session was swept). Boot again, once, and repeat the request — the
    // alternative is telling the user to reload a page that would work.
    resetSession();
    await ready();
    resp = await perform();
    body = await readBody(resp);
  }
  return { resp, body };
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const { resp, body: data } = await withSession(() =>
    fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body ?? {}),
    }),
  );
  if (!resp.ok) fail(url, resp, data as WireError);
  return data as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return send<T>("GET", url);
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return send<T>("POST", url, body ?? {});
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  return send<T>("PATCH", url, body ?? {});
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  return send<T>("PUT", url, body ?? {});
}

/** DELETE something. 204 (no body) is the normal answer, so nothing is parsed
 *  on success — but a failure body is still read for its `error`/`code`. */
export async function del(url: string): Promise<void> {
  const { resp, body } = await withSession(() => fetch(url, { method: "DELETE" }));
  if (!resp.ok) fail(url, resp, body as WireError);
}

/** Upload files as multipart/form-data. Kept here so the one place that knows
 *  about wire errors also owns the only non-JSON request. */
export async function postForm<T>(url: string, form: FormData): Promise<T> {
  // This is the call a file dropped on the page during boot takes, and the one
  // that used to land in a session the browser abandoned a moment later: the
  // upload was attributed to one of the boot storm's orphan workspaces, so the
  // model survived "Delete my data". `withSession` makes it wait for the cookie.
  const { resp, body } = await withSession(() => fetch(url, { method: "POST", body: form }));
  if (!resp.ok) fail(url, resp, body as WireError);
  return body as T;
}

/** Read a `data: {...}\n\n` SSE stream off a POST response body — the
 *  browser's native EventSource can only issue GET requests, so a streamed
 *  chat/job reply is parsed by hand off `fetch()`'s ReadableStream. Reused by
 *  BOTH /api/chat and /api/jobs/:id/run — do not write a second parser.
 *
 *  A refusal before the stream opens (e.g. 409 `no_key`) arrives as ordinary
 *  JSON, so it becomes an ApiError with its `code` intact. */
export async function streamSse(
  url: string,
  body: unknown,
  onEvent: (data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  // The same boot gate as every other call. Not routed through `withSession`'s
  // retry: a chat turn or a job run is not safe to send twice, and a stream is
  // read from the response this function must keep hold of.
  await ready();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const data = await readBody(resp);
    fail(url, resp, data as WireError);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw) continue;
      try {
        onEvent(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* a malformed frame is dropped rather than killing the stream */
      }
    }
  }
}
