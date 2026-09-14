// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat — the zero-install client's brain. Streams the SAME agent
// loop the Electron app uses (main/agent/agent.ts) to the browser over
// Server-Sent Events instead of Electron IPC.
//
// SSE, not a raw WebSocket: it rides plain HTTP, so it survives the reverse
// proxies / load balancers a hosted deployment sits behind (some strip
// Upgrade headers or time out idle WS connections), and the browser's native
// EventSource retries a dropped connection with zero client code. The
// trade-off (one-way: server → client) is fine here because the only
// "upload" direction we need is the initial POST body.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { SlicelyAgent } from "../../main/agent/agent";
import { getUserApiKey, NoApiKeyError } from "../../main/userkey";
import { sendError, stripPaths, toWire } from "../errors";
import { isDesktop } from "../../main/mode";
import { sessionState } from "../../main/agent/state";
import type { AgentEvent } from "../../shared/types";
import { adoptGcodeFile, toClientPaths, type ChatAgent, type SessionRecord } from "../session";
import { loadChats, saveChats, newChat, appendTurn } from "../chats";
import { noLimit, type RouteLimitOptions } from "../security";

/** How often to poke a silent stream. Comfortably under the ~30s idle timeout
 *  common in browsers and reverse proxies. */
const KEEP_ALIVE_MS = 10_000;

/**
 * Write one frame, with every absolute server path taken out of it first.
 *
 * THE ONE EXIT. Each frame used to be written straight through, and the agent's
 * events are where the remaining leaks were hiding: `info` carried
 * `ModelInfo.filePath`, `download` carried a sourcing `DownloadResult.localPath`
 * (and one per part), `job`/`job_progress` carried the whole job contract the
 * REST router had already been taught to scrub, `orientation` carried a
 * `partPath`, `status` carried PrusaSlicer's install location, and `metrics`
 * was handed the ABSOLUTE path of the copy we had just adopted. All of them
 * named `<workdir>/sessions/<id>/…`, i.e. the deployment's layout and the
 * caller's own session id, in a 200.
 *
 * Routing every frame through `toClientPaths` fixes them as a class rather than
 * one at a time: `path`/`localPath`/`filePath` become the workspace-relative
 * `relPath` the client is allowed to hold (and the form /api/preview,
 * /api/slice and POST /api/jobs all accept back), and output paths are dropped
 * because their opaque token is already on the wire.
 */
function writeSse(session: SessionRecord, res: Response, wire: Record<string, unknown>): void {
  const scrubbed = toClientPaths(session, wire) as Record<string, unknown>;
  // DESKTOP EXEMPTION — the model's OWN PROSE only.
  //
  // The rule "absolute paths never reach a client" is about a SERVER's layout
  // reaching a stranger's browser. On the Mac app there is no stranger: the
  // client is a window on the machine the files are on, the user picked
  // `~/Desktop/x.stl` themselves, and `workspaceRef` deliberately hands the
  // model that full path because nothing shorter resolves again
  // (main/session-context.ts). Scrubbing it here turned the app's own answer
  // into "I sliced <file>", which is useless to the one reader who is entitled
  // to the name.
  //
  // Narrow on purpose: only `text`/`thinking`, only in desktop mode. Every
  // other field — a tool's exception `summary`, a `plate_failed` `error`, every
  // path-shaped KEY — still goes through the scrub in both modes, and hosted
  // behaviour is unchanged.
  if (isDesktop() && typeof wire.text === "string" && (wire.type === "text" || wire.type === "thinking")) {
    scrubbed.text = wire.text;
  }
  res.write(`data: ${JSON.stringify(scrubbed)}\n\n`);
}

/**
 * Forward one AgentEvent to the browser, widened to a plain record (not the
 * strict AgentEvent union — see routes/jobs.ts for why) so a "metrics" event
 * can carry an extra `gcodeId`. tools.ts's slice_model writes its G-code into
 * this session's own `slices/` (session-context.ts's `sessionSlicesDir`), and
 * this is the one place that file becomes ADDRESSABLE to the browser — without
 * it, a chat-driven slice could never be downloaded, or sent to a printer via
 * /api/printers/:id/send, which only accepts a gcodeId from the session's own
 * registry. Chained per-response so relocating a file (async) can never
 * reorder frames relative to the surrounding text/tool events.
 */
function makeEmit(session: SessionRecord, res: Response): { emit: (event: AgentEvent) => void; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: AgentEvent) => {
    // Record jobs the AGENT creates. Ownership was only recorded by the REST
    // /api/jobs route, so a job planned through chat belonged to nobody: the
    // UI's own follow-up requests for it (plate preview, re-open, re-run) came
    // back 404 from the very session that made it.
    if (event.type === "job" && event.job?.id) session.jobIds.add(event.job.id);
    chain = chain.then(async () => {
      if (event.type === "metrics" && event.metrics.gcodePath) {
        const adopted = await adoptGcodeFile(session, event.metrics.gcodePath).catch(() => undefined);
        if (adopted) {
          // `gcodePath` is dropped by `writeSse`'s scrub — the token is what the
          // client downloads and prints with, and it is right here.
          writeSse(session, res, { ...event, metrics: { ...event.metrics }, gcodeId: adopted.id });
          return;
        }
      }
      // An action pointing at a server-side file becomes a session-scoped
      // download. Without this the browser would be handed a path on someone
      // else's disk, and the button would 404.
      if (event.type === "action" && event.filePath) {
        const adopted = await adoptGcodeFile(session, event.filePath).catch(() => undefined);
        const { filePath: _dropped, ...rest } = event;
        writeSse(session, res, adopted ? { ...rest, href: `/api/gcode/${adopted.id}` } : rest);
        return;
      }
      writeSse(session, res, event as unknown as Record<string, unknown>);
    });
  };
  const flush = () => chain.catch(() => undefined);
  return { emit, flush };
}

/**
 * `makeAgent` defaults to a real `SlicelyAgent` (opens an Anthropic client
 * and talks to the real API). Tests should ALWAYS override it with a stub —
 * see routes/chat.test.ts — so exercising the SSE wire format never depends
 * on an API key or makes a live network call.
 */
export function createChatRouter(
  makeAgent: () => ChatAgent = () => new SlicelyAgent(),
  opts: RouteLimitOptions = {},
): Router {
  const router = Router();
  // Every turn is an Anthropic call the user pays for — the `chat` tier.
  const chatLimit = opts.limit ?? noLimit;

  router.post("/chat", chatLimit, async (req: Request, res: Response) => {
    const session = req.session!;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (session.busy) {
      // Same 409 status as "no key", so the code is what tells them apart: this
      // one is transient and the UI should re-enable the composer, not offer the
      // key card.
      res.status(409).json({ error: "This tab is still waiting on a previous reply.", code: "busy" });
      return;
    }
    // No key, no turn — and answered as plain JSON BEFORE the SSE headers go
    // out. An error delivered inside an already-open stream is far harder for
    // the client to act on (EventSource has read a 200 by then), and the one
    // thing the UI must do here is show the "connect your key" card.
    if (!getUserApiKey()) {
      sendError(res, new NoApiKeyError("Connect your Anthropic API key in Settings to chat."));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering on nginx-fronted deployments so events
      // reach the browser as they're written, not batched at proxy close.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    session.busy = true;
    const { emit, flush } = makeEmit(session, res);

    // Keep the stream alive through long silences.
    //
    // Slicing a plate can take 20 seconds or several minutes, during which the
    // turn emits nothing. A browser (and any proxy in front of it) can treat a
    // silent stream as dead and stop reading, which is exactly what happened:
    // the server finished the turn and saved the reply, while the page sat on
    // "Slicing plate 1…" forever. A comment line is ignored by the SSE parser
    // and costs nothing.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, KEEP_ALIVE_MS);

    // Cancel the turn when the BROWSER goes away — listen on `res`, never on
    // `req`. An IncomingMessage emits "close" as soon as its body has been
    // fully read (Node >= 16), which body-parser does before this handler even
    // runs, so `req.on("close")` fired ~1ms in and cancelled every single turn:
    // the browser got a bare {"type":"done"} and no reply. `res` stays open for
    // the life of the SSE stream, so its "close" means a real disconnect.
    // Guarded anyway, because res also emits "close" after a normal res.end().
    let turnFinished = false;
    const onClientClose = (): void => {
      if (!turnFinished) session.agent?.cancel();
    };
    res.on("close", onClientClose);

    try {
      if (!session.agent) {
        session.agent = makeAgent();
      }
      const agent = session.agent;
      // The request already runs inside this session's context (see
      // sessionMiddleware), so `sessionState` below IS this visitor's own
      // record — concurrent turns from other browsers cannot touch it.
      // Point it at this session's uploaded/imported file(s) before the turn.
      if (session.activeModelPaths.length > 0) {
        sessionState.lastModelPath =
          session.activeModelPaths[session.activeModelPaths.length - 1];
        sessionState.lastModelParts = session.activeModelPaths;
      }
      // Collect the reply so it can be saved with the conversation. The UI
      // gets it streamed either way; this is only for reopening later.
      let replyText = "";
      const emitAndRecord = (event: AgentEvent): void => {
        if (event.type === "text") replyText += event.text;
        emit(event);
      };
      await agent.send(message, emitAndRecord);
      // The reply is SCRUBBED WHOLE, here, where the stream's delta boundaries
      // no longer exist. `writeSse` scrubs each `text` frame on its way out, but
      // a path split across two deltas ("/data/sessi" + "ons/ab12/uploads/…")
      // matches nothing on either side — and `chats.json` is replayed verbatim
      // on every reopen of the conversation, so a path saved here leaks once
      // live and then for good. The assembled string is the only place the whole
      // path is guaranteed to be contiguous.
      //
      // DESKTOP keeps the path, for the same reason `writeSse` does: the saved
      // transcript is redrawn in the app on the user's own Mac, and a reopened
      // conversation that says "I sliced <file>" has lost the only name the user
      // could act on. Hosted still scrubs before anything touches chats.json.
      recordTurn(session, agent, message, isDesktop() ? replyText : stripPaths(replyText));
      // Pull back whatever the agent imported/downloaded/sliced this turn, so
      // a later turn — or a REST call like /api/slice — keeps working from
      // this session's file.
      if (sessionState.lastModelParts.length > 0) {
        session.activeModelPaths = sessionState.lastModelParts;
      } else if (sessionState.lastModelPath) {
        session.activeModelPaths = [sessionState.lastModelPath];
      }
    } catch (err) {
      // The stream is already open, so this cannot become an HTTP status —
      // it goes out as an in-band error event carrying the same mapped message
      // and stable code a JSON response would have had (a rejected key, a
      // rate-limited account, no credit), never the raw error text.
      const { body } = toWire(err);
      emit({ type: "error", message: body.error, code: body.code });
      emit({ type: "done" });
    } finally {
      clearInterval(keepAlive);
      turnFinished = true;
      await flush();
      session.busy = false;
      session.lastActiveAt = Date.now();
      res.off("close", onClientClose);
      res.end();
    }
  });

  router.post("/chat/cancel", (req: Request, res: Response) => {
    req.session?.agent?.cancel();
    res.json({ ok: true });
  });

  return router;
}

/**
 * Save a completed turn against the session's active chat.
 *
 * Both halves are stored: the transcript so it can be redrawn, and the agent's
 * own history so reopening the chat continues it. Failures here are swallowed —
 * a conversation that cannot be saved is a lost convenience, not a reason to
 * fail a reply the user already received.
 */
function recordTurn(
  session: SessionRecord,
  agent: ChatAgent,
  message: string,
  reply: string,
): void {
  try {
    const chats = loadChats(session.dir);
    let chat = chats.find((c) => c.id === session.activeChatId);
    if (!chat) {
      chat = newChat();
      chats.push(chat);
      session.activeChatId = chat.id;
    }
    appendTurn(chat, { role: "user", text: message });
    if (reply.trim()) appendTurn(chat, { role: "assistant", text: reply });
    chat.agentHistory = agent.exportHistory?.() ?? [];
    saveChats(session.dir, chats);
  } catch {
    /* saving history must never break the chat itself */
  }
}
