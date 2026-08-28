// PrusaLink driver — the built-in web server/API on MK4, MK4S, XL, and Mini+
// running current Prusa firmware. Supports two auth modes: a plain API key
// (X-Api-Key — what PrusaLink's own settings screen calls the "API Key") or
// HTTP Digest auth (RFC 2617/7616) with a username that defaults to "maker"
// per Prusa's documentation for the printer's web UI login. There's no
// digest-auth package in this project's dependencies, so digest is
// hand-rolled in ../digestAuth.
//
// Endpoint confidence:
//  - GET /api/version, GET /api/printer: legacy endpoints PrusaLink kept
//    OctoPrint-compatible for tool interop (this is what OctoPrint-plugin-
//    style integrations and Home Assistant poll). The /api/printer response
//    shape implemented here (temperature.tool0/bed + state.flags, mirroring
//    OctoPrint) is a reasonable-confidence best effort — it has NOT been
//    verified against a live device from this codebase, so treat field names
//    as "probably right, confirm against real firmware."
//  - PUT /api/v1/files/usb/<name>, POST /api/v1/job: PrusaLink's newer v1
//    API, used by PrusaLink's own web UI for uploads and print control. The
//    upload endpoint/method match the task's brief. The exact JSON body
//    /api/v1/job expects to START a just-uploaded file is UNVERIFIED —
//    PrusaLink's v1 API is not fully published outside Prusa's own clients.
//    If this 4xxs against a real printer, the /api/v1/job body is the first
//    thing to fix; the upload itself (the part that actually gets the file
//    onto the printer) does not depend on it.
//  - Job pause/resume/cancel are intentionally NOT implemented here: v1's
//    control endpoints appear to be addressed by a job id (`/api/v1/job/{id}
//    /pause`) that this driver has no verified way to obtain, and guessing a
//    path here would be worse than admitting the gap. Callers get "not
//    supported" (the interface's pause/resume/cancel are optional) rather
//    than a fabricated endpoint.
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  PrinterDriver,
  PrinterState,
  PrinterStatus,
  PrinterTestResult,
  ResolvedPrinter,
  SendJobResult,
} from "../../../shared/printers";
import { DEFAULT_TIMEOUT_MS, describeError, fetchTimeout, nowIso, safeText } from "../util";
import { buildDigestHeader, parseDigestChallenge } from "../digestAuth";

const UPLOAD_TIMEOUT_MS = 60_000;

function baseUrl(p: ResolvedPrinter): string {
  return `http://${p.host}:${p.port ?? prusalinkDriver.defaultPort}`;
}

/**
 * Harvest a Digest challenge from a cheap, bodyless GET to /api/version
 * rather than re-issuing the caller's real request (which may carry a large
 * G-code body) just to trigger the 401. PrusaLink runs one embedded HTTP
 * server with one realm, so the challenge it hands out for /api/version is
 * the same one any other protected path expects.
 */
async function getDigestChallenge(printer: ResolvedPrinter, timeoutMs: number) {
  try {
    const res = await fetchTimeout(`${baseUrl(printer)}/api/version`, {}, timeoutMs);
    if (res.status !== 401) return undefined;
    return parseDigestChallenge(res.headers.get("www-authenticate"));
  } catch {
    return undefined;
  }
}

/** Fetch with PrusaLink's auth: X-Api-Key if supplied, else HTTP Digest
 *  (username defaults to "maker"), else anonymous (some PrusaLink setups
 *  disable auth entirely on a trusted LAN). */
async function authedFetch(
  printer: ResolvedPrinter,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const url = `${baseUrl(printer)}${path}`;
  const baseHeaders: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };

  if (printer.apiKey) {
    return fetchTimeout(url, { ...init, headers: { ...baseHeaders, "X-Api-Key": printer.apiKey } }, timeoutMs);
  }
  if (printer.password) {
    const challenge = await getDigestChallenge(printer, timeoutMs);
    if (challenge) {
      const username = printer.username || "maker";
      const authHeader = buildDigestHeader(challenge, username, printer.password, init.method || "GET", path);
      return fetchTimeout(url, { ...init, headers: { ...baseHeaders, Authorization: authHeader } }, timeoutMs);
    }
    // No challenge came back (unreachable, or auth isn't actually required) —
    // fall through and just try the plain request.
  }
  return fetchTimeout(url, { ...init, headers: baseHeaders }, timeoutMs);
}

interface PrusaVersion {
  api?: string;
  server?: string;
  text?: string;
  hostname?: string;
}

interface PrusaPrinterInfo {
  state?: { text?: string; flags?: Record<string, boolean> };
  temperature?: Record<string, { actual?: number; target?: number } | undefined>;
}

function mapState(flags: Record<string, boolean> | undefined): PrinterState {
  if (!flags) return "unknown";
  if (flags.printing) return "printing";
  if (flags.paused || flags.pausing) return "paused";
  if (flags.error || flags.closedOrError) return "error";
  if (flags.ready || flags.operational) return "idle";
  return "unknown";
}

export const prusalinkDriver: PrinterDriver = {
  transport: "prusalink",
  defaultPort: 80,
  label: "PrusaLink",
  // Either an API key OR a username+password works; the setup UI should let
  // the user pick either, so nothing is unconditionally "required" here.
  requiredSecrets: [],

  async test(printer): Promise<PrinterTestResult> {
    try {
      const res = await authedFetch(printer, "/api/version");
      if (!res.ok) {
        return {
          ok: false,
          message:
            res.status === 401
              ? "Authentication failed — check the API key, or the username/password."
              : `PrusaLink replied ${res.status}.`,
        };
      }
      const json = (await res.json()) as PrusaVersion;
      return {
        ok: true,
        message: `Connected to PrusaLink${json.hostname ? ` (${json.hostname})` : ""}.`,
        version: json.server,
      };
    } catch (err) {
      return { ok: false, message: `Can't reach PrusaLink: ${describeError(err)}` };
    }
  },

  async status(printer): Promise<PrinterStatus> {
    try {
      const res = await authedFetch(printer, "/api/printer");
      if (!res.ok) {
        return {
          id: printer.id,
          state: res.status === 401 ? "error" : "offline",
          observedAt: nowIso(),
          message: `PrusaLink /api/printer → ${res.status}`,
        };
      }
      const json = (await res.json()) as PrusaPrinterInfo;
      const tool0 = json.temperature?.tool0;
      const bed = json.temperature?.bed;
      return {
        id: printer.id,
        state: mapState(json.state?.flags),
        nozzleTempC: tool0?.actual,
        nozzleTargetC: tool0?.target,
        bedTempC: bed?.actual,
        bedTargetC: bed?.target,
        observedAt: nowIso(),
      };
    } catch (err) {
      return { id: printer.id, state: "offline", observedAt: nowIso(), message: describeError(err) };
    }
  },

  async send(printer, gcodePath, opts): Promise<SendJobResult> {
    const name = opts.jobName || basename(gcodePath);
    const uploadPath = `/api/v1/files/usb/${encodeURIComponent(name)}`;
    try {
      const bytes = await readFile(gcodePath);
      const uploadRes = await authedFetch(
        printer,
        uploadPath,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          // Re-wrap as a plain Uint8Array — see octoprint.ts's comment on why
          // a raw Buffer doesn't structurally satisfy fetch's BodyInit type.
          body: new Uint8Array(bytes),
        },
        UPLOAD_TIMEOUT_MS,
      );
      if (!uploadRes.ok) {
        return { ok: false, started: false, message: `Upload failed (${uploadRes.status}): ${await safeText(uploadRes)}` };
      }
      if (!opts.startImmediately) {
        return {
          ok: true,
          started: false,
          message: `Uploaded ${name} to the printer's USB storage. Start it from the printer's screen (or arm auto-start).`,
        };
      }

      // UNVERIFIED: best-effort body for starting the file just uploaded —
      // see the file-header comment. If this fails, the upload has still
      // succeeded, so we report ok:true / started:false rather than losing
      // that.
      const jobRes = await authedFetch(printer, "/api/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name, path: `/usb/${name}` }),
      });
      if (!jobRes.ok) {
        return {
          ok: true,
          started: false,
          message: `Uploaded ${name}, but starting it automatically failed (${jobRes.status}). Start it from the printer's screen.`,
        };
      }
      return { ok: true, started: true, message: `Uploaded and started ${name}.` };
    } catch (err) {
      return { ok: false, started: false, message: `Upload failed: ${describeError(err)}` };
    }
  },

  // pause/resume/cancel intentionally omitted — see file-header comment.
};
