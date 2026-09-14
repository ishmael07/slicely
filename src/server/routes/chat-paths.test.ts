// ─────────────────────────────────────────────────────────────────────────────
// The DESKTOP exemption from the path scrub, and the hosted rule it does not
// touch (POST /api/chat).
//
// "Absolute filesystem paths never reach a client" is a rule about a SERVER's
// layout reaching a stranger. In the Mac app the client is a window on the very
// machine the files are on, and the file in question is one the user picked
// themselves — `~/Desktop/bracket.stl`, which has no workspace-relative
// spelling at all, so `workspaceRef` deliberately hands the model the full path
// (main/session-context.ts). Scrubbing it on the way back turned the app's own
// answer into "I sliced <file>", i.e. removed the name from the one reader
// entitled to it, and did the same to the saved transcript for good.
//
// Both halves are checked in both modes: the live SSE `text` frame and the
// reply persisted to chats.json.
//
// Hermetic: temp dirs, a stubbed ChatAgent (no Anthropic SDK, no network), an
// ephemeral port.
// ─────────────────────────────────────────────────────────────────────────────
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";
import { DESKTOP_HEADER } from "../desktop-token";
import { resetConfigForTests } from "../../main/config";

// Point every workdir-derived path (the cookie secret, the desktop session's
// own directory) at a temp tree before anything reads config.
const WORKDIR = mkdtempSync(join(tmpdir(), "slicely-chat-paths-work-"));
process.env.SLICELY_WORKDIR = WORKDIR;
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetConfigForTests();

const TOKEN = "token-for-this-launch";
const TEST_KEY = "sk-ant-api03-" + "c".repeat(40);
/** What the model says out loud: the user's own file, outside the workspace. */
const USER_PATH = "/Users/someone/Desktop/bracket.stl";
const REPLY = `Sliced ${USER_PATH} — 2 h 14 m.`;

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Outcome {
  /** The assembled `text` frames as the browser received them. */
  streamed: string;
  /** The assistant turn as it was written to chats.json. */
  persisted: string;
}

/** Run one turn whose reply names `USER_PATH`, in `mode`, and report what the
 *  browser saw and what was saved. */
async function oneTurn(mode: "hosted" | "desktop"): Promise<Outcome> {
  const prevMode = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  const root = mkdtempSync(join(tmpdir(), "slicely-chat-paths-"));
  const store = new SessionStore({
    sessionsRoot: join(root, "sessions"),
    secretDir: root,
    desktopDir: join(root, "desktop"),
    sweepIntervalMs: 0,
  });
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      // Two deltas, because that is how a real reply arrives. The split is
      // BEFORE the path, deliberately: a path cut across two deltas matches no
      // regex on either side, which is a documented limitation of the per-frame
      // scrub (errors.ts / session.ts) and not what this test is about.
      emit({ type: "text", text: REPLY.slice(0, 7) });
      emit({ type: "text", text: REPLY.slice(7) });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised here */
    },
  });
  const desktopHeaders: Record<string, string> =
    mode === "desktop" ? { [DESKTOP_HEADER]: TOKEN } : {};
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stub,
      keyValidator: async () => "ok",
      desktopToken: TOKEN,
    }),
  );
  try {
    const boot = await fetch(`${base}/api/config`, { headers: { ...desktopHeaders } });
    assert.equal(boot.status, 200);
    const cookie = boot.headers.get("set-cookie")!.split(";")[0];
    const headers = { ...desktopHeaders, cookie };

    const keyResp = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: TEST_KEY }),
    });
    assert.equal(keyResp.status, 200, await keyResp.text());

    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "slice it" }),
    });
    assert.equal(resp.status, 200);
    const streamed = (await resp.text())
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)) as { type: string; text?: string })
      .filter((f) => f.type === "text")
      .map((f) => f.text ?? "")
      .join("");

    // chats.json lives in the session's own directory — found through the
    // cookie, which in desktop mode signs the single default session id.
    const id = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    const session = store.get(id);
    assert.ok(session, "the boot call's cookie must name a live session");
    const chats = JSON.parse(readFileSync(join(session!.dir, "chats.json"), "utf8")) as Array<{
      turns: Array<{ role: string; text: string }>;
    }>;
    const assistant = chats.flatMap((c) => c.turns).filter((t) => t.role === "assistant");
    assert.equal(assistant.length, 1, "the turn must have been saved");
    return { streamed, persisted: assistant[0].text };
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prevMode;
  }
}

test("desktop: a path the user typed survives the reply, streamed and saved", async () => {
  const { streamed, persisted } = await oneTurn("desktop");
  assert.equal(streamed, REPLY, "the Mac app's own window gets the name the user gave it");
  assert.equal(persisted, REPLY, "and reopening the conversation still shows it");
  assert.ok(!streamed.includes("<file>"), "nothing was replaced");
});

test("hosted: the same reply is scrubbed, streamed and saved", async () => {
  const { streamed, persisted } = await oneTurn("hosted");
  assert.ok(!streamed.includes(USER_PATH), `path leaked into the stream: ${streamed}`);
  assert.match(streamed, /<file>/, "the path is replaced by the placeholder");
  assert.ok(!persisted.includes(USER_PATH), `path leaked into chats.json: ${persisted}`);
  assert.match(persisted, /<file>/);
});

after(() => rmSync(WORKDIR, { recursive: true, force: true }));
