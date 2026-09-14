// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/chats — saved conversations for this session.
//
// Starting a new chat has to clear the MODEL's memory, not just the transcript
// on screen; reopening one has to restore that memory, not just redraw the
// words. Both are handled here so the UI only has to call an endpoint.
//
// READING AND SWITCHING ARE TWO DIFFERENT ENDPOINTS (Task D7). `GET
// /api/chats/:id` used to do both: it answered with the chat AND made it this
// session's active one, reloading the agent's memory from it. A GET that
// rewrites state is reachable by accident — a browser prefetch, a link
// preview, a `<link rel=prefetch>`, any other page's `<img src>` — so the
// user's live conversation could be swapped out from under them by something
// that never intended to. The read is now read-only; `POST
// /api/chats/:id/activate` is the one that switches.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadChats, saveChats, newChat, summarise } from "../chats";
import { sendError, WireError } from "../errors";
import type { ChatRecord } from "../chats";

export function createChatsRouter(): Router {
  const router = Router();

  /** Every saved chat, newest first, plus which one is currently active. */
  router.get("/chats", (req: Request, res: Response) => {
    const session = req.session!;
    res.json({
      chats: summarise(loadChats(session.dir)),
      activeId: session.activeChatId,
    });
  });

  /** Start a fresh conversation. */
  router.post("/chats", (req: Request, res: Response) => {
    const session = req.session!;
    const chats = loadChats(session.dir);
    const chat = newChat();
    chats.push(chat);
    saveChats(session.dir, chats);
    session.activeChatId = chat.id;

    // The transcript is only half of it: without clearing the agent, the next
    // message still carries every earlier turn.
    session.agent?.reset?.();
    // A new chat is also a new working context; the previous chat's imported
    // model should not silently become this one's subject.
    session.activeModelPaths = [];

    res.json({ chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, turns: 0 } });
  });

  /** Read one chat's transcript. SAFE AND IDEMPOTENT: it does not touch
   *  `session.activeChatId` and does not reload the agent's memory. */
  router.get("/chats/:id", (req: Request, res: Response) => {
    const session = req.session!;
    try {
      const chat = mustFind(session.dir, req.params.id);
      res.json({ id: chat.id, title: chat.title, turns: chat.turns });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Switch to a chat: make it this session's active one AND restore the
   *  model's memory of it, so the next message continues the conversation
   *  rather than restarting it with the words merely redrawn. Answers with the
   *  same body the read does, so a client that is opening a chat needs one
   *  request, not two. */
  router.post("/chats/:id/activate", (req: Request, res: Response) => {
    const session = req.session!;
    try {
      const chat = mustFind(session.dir, req.params.id);
      session.activeChatId = chat.id;
      session.agent?.importHistory?.(chat.agentHistory ?? []);
      res.json({ id: chat.id, title: chat.title, turns: chat.turns });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete("/chats/:id", (req: Request, res: Response) => {
    const session = req.session!;
    const chats = loadChats(session.dir).filter((c) => c.id !== req.params.id);
    saveChats(session.dir, chats);
    if (session.activeChatId === req.params.id) {
      session.activeChatId = undefined;
      session.agent?.reset?.();
    }
    res.json({ ok: true });
  });

  return router;
}

/** This session's chat by id, or a 404 `not_found` — the chats file is per
 *  session, so another visitor's id is simply absent and gets the same answer
 *  an id that never existed gets. */
function mustFind(sessionDir: string, id: string): ChatRecord {
  const chat = loadChats(sessionDir).find((c) => c.id === id);
  if (!chat) throw new WireError(404, "No such chat.", "not_found");
  return chat;
}
