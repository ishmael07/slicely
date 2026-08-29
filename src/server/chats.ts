// ─────────────────────────────────────────────────────────────────────────────
// Saved conversations, so a visitor can start a new chat without losing the
// last one and can go back to something they were working on.
//
// Two things are stored per chat, and both matter:
//   • the TRANSCRIPT, to redraw what the user saw, and
//   • the agent's own message history, so reopening a chat CONTINUES it.
// Storing only the transcript would redraw the words while the model started
// from nothing, which is worse than not offering history at all.
//
// Scoped to a session and kept on that session's own disk, like everything else
// a visitor touches.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** One turn as the UI needs to redraw it. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatRecord {
  id: string;
  /** Derived from the first thing the user said. */
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  /** The agent's own history, opaque here — shape belongs to the SDK. */
  agentHistory: unknown[];
}

/** Chats kept per session. Older ones are dropped rather than growing forever. */
const MAX_CHATS = 30;
/** Turns kept per chat. A long session is still bounded on disk. */
const MAX_TURNS = 200;

function fileFor(sessionDir: string): string {
  return join(sessionDir, "chats.json");
}

export function loadChats(sessionDir: string): ChatRecord[] {
  try {
    const raw = readFileSync(fileFor(sessionDir), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatRecord[]) : [];
  } catch {
    // Missing or corrupt: start empty rather than failing the request.
    return [];
  }
}

export function saveChats(sessionDir: string, chats: ChatRecord[]): void {
  const trimmed = chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);
  const path = fileFor(sessionDir);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(trimmed), "utf8");
    renameSync(tmp, path); // atomic, so a crash can't leave a half-written file
  } catch {
    // Persistence is a convenience; losing it must not fail the chat itself.
  }
}

/** A short, recognisable name taken from the opening message. */
export function titleFrom(message: string): string {
  const clean = message.trim().replace(/\s+/g, " ");
  if (!clean) return "New chat";
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

export function newChat(): ChatRecord {
  const now = Date.now();
  return {
    id: randomBytes(8).toString("hex"),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    turns: [],
    agentHistory: [],
  };
}

/** Append a turn, naming the chat from the first thing the user said. */
export function appendTurn(chat: ChatRecord, turn: ChatTurn): void {
  if (chat.turns.length === 0 && turn.role === "user") {
    chat.title = titleFrom(turn.text);
  }
  chat.turns.push(turn);
  if (chat.turns.length > MAX_TURNS) {
    chat.turns.splice(0, chat.turns.length - MAX_TURNS);
  }
  chat.updatedAt = Date.now();
}

/** Listing shape: everything the sidebar needs, without the bulky bodies. */
export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
}

export function summarise(chats: ChatRecord[]): ChatSummary[] {
  return chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.turns.length }));
}
