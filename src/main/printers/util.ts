// Shared helpers for every printer driver: a hard-timeout fetch wrapper (a
// hung socket must never hang the app), small formatting/parsing helpers, and
// id/clock utilities. Pure Node — this whole directory runs inside both the
// Electron main process and the headless web server, so nothing here may
// import "electron".
import { randomUUID } from "node:crypto";

/** Default network timeout applied to a driver call, in ms. Every driver
 *  method (test/status/send/pause/resume/cancel) must bound its network calls
 *  to roughly this so an unreachable printer fails fast instead of hanging. */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * fetch() with a hard timeout via AbortSignal.timeout. A printer that's
 * powered off but still holds a DHCP lease (connection just hangs, no RST) is
 * the common case this guards against — without it, a single stale printer
 * could freeze the whole status-polling loop.
 */
export function fetchTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/** A fresh id for a new registry record. */
export function newId(): string {
  return randomUUID();
}

/** Current time as an ISO string — the timestamp format every status/record
 *  in shared/printers.ts uses. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize a printer-reported colour to "#RRGGBB". Accepts a bare 6-hex
 * string ("00AE42") or an 8-hex RRGGBBAA string (Bambu's AMS report format,
 * e.g. "00AE42FF") and drops the alpha channel. Returns undefined for
 * anything that doesn't parse as hex, so a garbled report degrades to "no
 * colour" instead of a wrong one.
 */
export function normalizeColourHex(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const hex = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex) && !/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

/** Render any thrown value as a plain-language message. Network errors from
 *  fetch/AbortSignal.timeout are Error instances, but defend against the rest
 *  (thrown strings, MQTT's occasional non-Error rejects). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError";
    // its default message ("The operation was aborted due to timeout") is
    // already clear enough to show a user as-is.
    return err.message || String(err);
  }
  return String(err);
}

/** Best-effort read of a Response body for an error message, capped so a
 *  misbehaving server can't dump megabytes into a status message. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
