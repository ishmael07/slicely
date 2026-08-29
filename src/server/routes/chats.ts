// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/chats — saved conversations for this session.
//
// Starting a new chat has to clear the MODEL's memory, not just the transcript
// on screen; reopening one has to restore that memory, not just redraw the
// words. Both are handled here so the UI only has to call an endpoint.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { loadChats, saveChats, newChat, summarise } from "../chats";

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

  /** Reopen a chat: its transcript, and the model's memory of it. */
  router.get("/chats/:id", (req: Request, res: Response) => {
    const session = req.session!;
    const chats = loadChats(session.dir);
    const chat = chats.find((c) => c.id === req.params.id);
    if (!chat) {
      res.status(404).json({ error: "No such chat." });
      return;
    }
    session.activeChatId = chat.id;
    // Continue the conversation rather than restarting it with the words
    // merely redrawn.
    session.agent?.importHistory?.(chat.agentHistory ?? []);
    res.json({ id: chat.id, title: chat.title, turns: chat.turns });
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
