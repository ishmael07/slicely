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
import { sessionState } from "../../main/agent/state";
import type { AgentEvent } from "../../shared/types";
import { adoptGcodeFile, type ChatAgent, type SessionRecord } from "../session";
import { loadChats, saveChats, newChat, appendTurn } from "../chats";

function writeSse(res: Response, wire: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(wire)}\n\n`);
}

/**
 * Forward one AgentEvent to the browser, widened to a plain record (not the
 * strict AgentEvent union — see routes/jobs.ts for why) so a "metrics" event
 * can carry an extra `gcodeId`. tools.ts's slice_model writes its G-code
 * straight into the GLOBAL shared slices directory (it predates sessions);
 * this is the one place that file becomes reachable from THIS session at all
 * — without it, a chat-driven slice could never be sent to a printer via
 * /api/printers/:id/send, which only accepts a gcodeId from the session's own
 * registry. Chained per-response so relocating a file (async) can never
 * reorder frames relative to the surrounding text/tool events.
 */
function makeEmit(session: SessionRecord, res: Response): { emit: (event: AgentEvent) => void; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: AgentEvent) => {
    chain = chain.then(async () => {
      if (event.type === "metrics" && event.metrics.gcodePath) {
        const adopted = await adoptGcodeFile(session, event.metrics.gcodePath).catch(() => undefined);
        if (adopted) {
          writeSse(res, { ...event, metrics: { ...event.metrics, gcodePath: adopted.path }, gcodeId: adopted.id });
          return;
        }
      }
      writeSse(res, event as unknown as Record<string, unknown>);
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
export function createChatRouter(makeAgent: () => ChatAgent = () => new SlicelyAgent()): Router {
  const router = Router();

  router.post("/chat", async (req: Request, res: Response) => {
    const session = req.session!;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (session.busy) {
      res.status(409).json({ error: "This tab is still waiting on a previous reply." });
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
      recordTurn(session, agent, message, replyText);
      // Pull back whatever the agent imported/downloaded/sliced this turn, so
      // a later turn — or a REST call like /api/slice — keeps working from
      // this session's file.
      if (sessionState.lastModelParts.length > 0) {
        session.activeModelPaths = sessionState.lastModelParts;
      } else if (sessionState.lastModelPath) {
        session.activeModelPaths = [sessionState.lastModelPath];
      }
    } catch (err) {
      emit({ type: "error", message: (err as Error).message ?? String(err) });
      emit({ type: "done" });
    } finally {
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
