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

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface WireError {
  error?: string;
  code?: string;
}

async function readBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

function fail(url: string, resp: Response, body: WireError): never {
  throw new ApiError(body.error ?? `${url} failed (${resp.status})`, resp.status, body.code);
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
const CODE_COPY: Record<string, string> = {
  no_key: "Connect your Anthropic API key to chat.",
  key_rejected: "Your Anthropic key was rejected — update it in Settings.",
  key_invalid_format: "That doesn't look like a valid Anthropic API key.",
  rate_limited: "Slow down a little — try again in a few seconds",
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

/** The product's copy for a stable error `code`, if one is mapped. */
export function codeMessage(code?: string): string | undefined {
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
  if (err instanceof ApiError) return codeMessage(err.code) ?? err.message ?? fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await readBody(resp);
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
  const resp = await fetch(url, { method: "DELETE" });
  if (!resp.ok) fail(url, resp, (await readBody(resp)) as WireError);
}

/** Upload files as multipart/form-data. Kept here so the one place that knows
 *  about wire errors also owns the only non-JSON request. */
export async function postForm<T>(url: string, form: FormData): Promise<T> {
  const resp = await fetch(url, { method: "POST", body: form });
  const data = await readBody(resp);
  if (!resp.ok) fail(url, resp, data as WireError);
  return data as T;
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
