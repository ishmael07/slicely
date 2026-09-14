// ─────────────────────────────────────────────────────────────────────────────
// Printer CRUD + control, backed by the v2 printers façade (src/main/
// printers). The one thing this layer adds on top of the façade: the
// SLICELY_MULTI_USER guard (see security.ts) that refuses LAN discovery and
// LAN-only transports when this is a hosted, shared server — and routing
// "send to printer" through this session's OWN gcode-id registry so a client
// can never hand the printer driver an arbitrary server filesystem path.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadPrintersApi } from "../facades";
import type { PrintersApi } from "../facades";
import { isMultiUser, isLanOnlyTransport } from "../security";
import { sendError, sendScrubbed, WireError } from "../errors";
import type { PrinterConnection, PrinterSecrets, PrinterTransport } from "../../shared/printers";

export function createPrintersRouter(api: PrintersApi | undefined = loadPrintersApi()): Router {
  const router = Router();

  if (!api) {
    router.use((_req, res) => {
      sendError(res, new WireError(503, "Printer connections are not available on this server yet."));
    });
    return router;
  }

  /**
   * Every `/printers/:id` route starts here.
   *
   * The registry is per session (main/printers/registry.ts), so an id this
   * session doesn't own simply isn't there — and the honest, non-leaking answer
   * is 404, the same one the caller gets for an id that never existed. Anything
   * else (403, or relaying the registry's "Printer not found: <id>" as a 422)
   * would confirm to one visitor that another visitor's printer id is real.
   * Returns the printer when it is this session's, otherwise answers and
   * returns undefined.
   */
  async function ownPrinter(req: Request, res: Response): Promise<PrinterConnection | undefined> {
    let printer: PrinterConnection | undefined;
    try {
      printer = await api!.getPrinter(req.params.id);
    } catch (err) {
      // A rejection here (a driver/registry bug, a disk error) must still
      // answer with JSON — every one of this helper's callers only checked
      // this awaited call for a resolved value, not for a rejection, so an
      // unguarded one became an unhandled promise rejection that could take
      // the whole process down. See fix round 1 in the D1+D2 report.
      fail(res, err, "couldn't look up that printer", 500);
      return undefined;
    }
    if (printer) return printer;
    sendError(res, new WireError(404, "No such printer.", "not_found"));
    return undefined;
  }

  /** A failure while validating/applying client input, OR any rejection from
   *  an awaited registry/driver call — every route funnels both through here.
   *  A `WireError` already says what the client should be told (status +
   *  stable code); a plain "Printer not found: <id>" (the registry's own
   *  message, e.g. from a race between this session's own two concurrent
   *  requests) gets the same 404 an unowned id gets; anything else is a
   *  generic complaint, with absolute paths scrubbed — no wire payload may
   *  carry a server path (spec §Error handling). */
  function fail(res: Response, err: unknown, fallback: string, status = 422): void {
    if (err instanceof Error && !(err instanceof WireError) && /^printer not found/i.test(err.message)) {
      sendError(res, new WireError(404, "No such printer.", "not_found"));
      return;
    }
    sendScrubbed(res, err, fallback, status);
  }

  router.get("/printers", async (_req: Request, res: Response) => {
    try {
      res.json(await api.listPrinters());
    } catch (err) {
      fail(res, err, "list printers failed", 500);
    }
  });

  router.get("/printers/drivers", (_req: Request, res: Response) => {
    res.json(api.driverLabels());
  });

  router.get("/printers/status", async (_req: Request, res: Response) => {
    try {
      res.json(await api.allStatuses());
    } catch (err) {
      fail(res, err, "status failed", 500);
    }
  });

  // A POST, not a GET (Task D7). Discovery is seconds of mDNS/SSDP traffic
  // sprayed across whatever network the server is on — an expensive, externally
  // visible side effect. As a GET it was reachable from any other page on the
  // internet (`<img src="https://slicely.app/api/printers/discover">`) and from
  // anything that speculatively fetches links, none of which meant to start a
  // network scan. It is also not idempotent in any useful sense, so a cache or
  // a prefetcher had no business replaying it.
  //
  // Order matters: this literal route must be registered before the
  // parameterized "/printers/:id/..." routes below, or Express would try to
  // treat "discover" as an :id.
  router.post("/printers/discover", async (req: Request, res: Response) => {
    if (isMultiUser()) {
      sendError(
        res,
        new WireError(
          403,
          "LAN discovery is disabled on a hosted/multi-user server — a datacenter's network isn't your printer's network. Add a cloud connection (Prusa Connect / Bambu Cloud) instead.",
          "forbidden_in_hosted_mode",
        ),
      );
      return;
    }
    const raw = (req.body ?? {}).timeoutMs;
    const timeoutMs = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    try {
      res.json(await api.discoverPrinters(Number.isFinite(timeoutMs) ? timeoutMs : undefined));
    } catch (err) {
      fail(res, err, "discovery failed", 502);
    }
  });

  router.post("/printers/active", async (req: Request, res: Response) => {
    const id = (req.body ?? {}).id;
    try {
      // Selecting a printer this session doesn't own is the same kind of miss
      // as addressing one by id — and the façade throws for an unknown id,
      // which would otherwise surface as a 500 (or, unguarded, a crash).
      if (typeof id === "string" && !(await api.getPrinter(id))) {
        sendError(res, new WireError(404, "No such printer.", "not_found"));
        return;
      }
      await api.setActivePrinter(typeof id === "string" ? id : undefined);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "set active printer failed", 500);
    }
  });

  router.post("/printers", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const transport = body.transport as PrinterTransport | undefined;
    if (!transport) {
      sendError(res, new WireError(400, "transport is required"));
      return;
    }
    // The folder transport writes to the machine Slicely runs on. On a hosted
    // server that is the operator's disk — not a folder the visitor could ever
    // open — so it is refused with its own stable code rather than the LAN
    // message below, which would be confusing advice for a transport that has
    // no network at all.
    if (isMultiUser() && transport === "file") {
      sendError(
        res,
        new WireError(403, "Saving to a folder only works in the Mac app.", "forbidden_in_hosted_mode"),
      );
      return;
    }
    if (isMultiUser() && isLanOnlyTransport(transport)) {
      sendError(
        res,
        new WireError(
          400,
          `"${transport}" requires being on the printer's own LAN, so it can't be added on a hosted server. Use a cloud transport (Prusa Connect or Bambu Cloud).`,
          "forbidden_in_hosted_mode",
        ),
      );
      return;
    }
    try {
      const input = body as unknown as Omit<PrinterConnection, "id"> & PrinterSecrets;
      const result = await api.addPrinter(input);
      res.status(201).json(result);
    } catch (err) {
      fail(res, err, "add printer failed");
    }
  });

  router.patch("/printers/:id", async (req: Request, res: Response) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    if (isMultiUser() && typeof patch.transport === "string" && isLanOnlyTransport(patch.transport as PrinterTransport)) {
      sendError(
        res,
        new WireError(400, "LAN-only transports are disabled on a hosted server.", "forbidden_in_hosted_mode"),
      );
      return;
    }
    if (!(await ownPrinter(req, res))) return;
    try {
      const typedPatch = patch as unknown as Partial<PrinterConnection & PrinterSecrets>;
      res.json(await api.updatePrinter(req.params.id, typedPatch));
    } catch (err) {
      fail(res, err, "update failed");
    }
  });

  router.delete("/printers/:id", async (req: Request, res: Response) => {
    if (!(await ownPrinter(req, res))) return;
    try {
      await api.removePrinter(req.params.id);
      res.status(204).end();
    } catch (err) {
      fail(res, err, "delete failed", 500);
    }
  });

  router.post("/printers/:id/test", async (req: Request, res: Response) => {
    if (!(await ownPrinter(req, res))) return;
    try {
      res.json(await api.testPrinter(req.params.id));
    } catch (err) {
      fail(res, err, "test failed", 502);
    }
  });

  router.get("/printers/:id/status", async (req: Request, res: Response) => {
    if (!(await ownPrinter(req, res))) return;
    try {
      res.json(await api.printerStatus(req.params.id));
    } catch (err) {
      fail(res, err, "status failed", 502);
    }
  });

  router.post("/printers/:id/send", async (req: Request, res: Response) => {
    if (!(await ownPrinter(req, res))) return;
    const session = req.session!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gcodeId = body.gcodeId;
    if (typeof gcodeId !== "string") {
      sendError(res, new WireError(400, "gcodeId is required (from a /api/slice or job result)."));
      return;
    }
    // The gcode-id registry is the ONLY way a filesystem path reaches the
    // printer driver from this route — never a raw path in the request body.
    // It also transitively enforces session ownership: a token only exists
    // in a session that produced the file itself.
    const entry = session.gcodeFiles.get(gcodeId);
    if (!entry) {
      sendError(res, new WireError(404, "Unknown gcodeId for this session.", "not_found"));
      return;
    }
    const opts = (body.opts ?? {}) as Record<string, unknown>;
    try {
      // SAFETY: startImmediately is passed through as the caller's REQUEST,
      // never invented or defaulted true here. The printers façade itself is
      // what actually enforces that a print only starts unattended when the
      // user has explicitly armed auto-start for this printer (setAutoStart)
      // — this route does not, and must not, add a way around that.
      const result = await api.sendToPrinter(req.params.id, entry.path, {
        startImmediately: opts.startImmediately === true,
        jobName: typeof opts.jobName === "string" ? opts.jobName : undefined,
      });
      res.json(result);
    } catch (err) {
      fail(res, err, "send failed", 502);
    }
  });

  router.post("/printers/:id/control", async (req: Request, res: Response) => {
    const action = (req.body ?? {}).action;
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
      sendError(res, new WireError(400, "action must be pause, resume, or cancel"));
      return;
    }
    if (!(await ownPrinter(req, res))) return;
    try {
      res.json(await api.controlPrinter(req.params.id, action));
    } catch (err) {
      fail(res, err, "control failed", 502);
    }
  });

  router.post("/printers/:id/autostart", async (req: Request, res: Response) => {
    // SAFETY: this endpoint IS the arming switch, meant to be hit only by an
    // explicit user toggle in Settings — never called implicitly from /send
    // or from planning/running a job. Do not wire an automatic call to this
    // into any other flow. And a visitor may only arm THEIR OWN printer: the
    // whole point of the gate is that a human confirmed this bed is clear.
    if (!(await ownPrinter(req, res))) return;
    const armed = (req.body ?? {}).armed === true;
    try {
      await api.setAutoStart(req.params.id, armed);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "autostart failed", 500);
    }
  });

  return router;
}
