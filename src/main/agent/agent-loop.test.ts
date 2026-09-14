// The agent loop, with a FAKE provider: no network, no SDK, no API key beyond
// the one this test writes into its own temp session.
//
// What is being pinned down is the loop itself — the thing that used to be
// welded to Anthropic's streaming client: a tool_use comes back, the tool runs,
// its result is appended as a tool_result, the next turn ends with text, and the
// history that gets saved is neutral and TAGGED with the provider that produced
// it (so reopening a chat can tell whether it may be replayed at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInSession, sessionContext } from "../session-context";
import { setUserApiKey } from "../userkey";
import { resetKeyVaultForTests } from "../keyvault";
import { SlicelyAgent } from "./agent";
import type { AgentEvent, ProviderId } from "../../shared/types";
import type { Provider, StreamRequest, TurnResult } from "./provider";
import { getProvider } from "./provider";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
resetKeyVaultForTests();

const KEY = "sk-ant-api03-" + "a".repeat(40);

/** A temp session directory that is ALWAYS removed — awaited, so the rm runs
 *  after the test body, not after the first await inside it. */
async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A provider that replays a scripted list of turns and records what it was
 *  asked for. `getProvider("anthropic")` supplies the parts a fake need not
 *  reimplement (key pattern, help copy). */
function fakeProvider(turns: TurnResult[], id: ProviderId = "anthropic"): Provider & { seen: StreamRequest[] } {
  const real = getProvider(id);
  const seen: StreamRequest[] = [];
  let i = 0;
  return {
    id,
    label: real.label,
    keyPattern: real.keyPattern,
    keyHelp: real.keyHelp,
    seen,
    async stream(req, emit) {
      seen.push(structuredClone(req) as StreamRequest);
      const turn = turns[i++] ?? { assistant: [], toolCalls: [] };
      for (const block of turn.assistant) {
        if (block.type === "text") emit({ type: "text", text: block.text });
      }
      return turn;
    },
    async validateKey() {
      return "ok";
    },
    classifyError: real.classifyError,
  };
}

test("a tool_use runs the tool, feeds the result back, and ends on text", async () => {
  await withTempDir("agent-loop-", async (dir) => {
    // `get_slicer_status` is the one tool that needs neither the network nor a
    // model file: it reports whether PrusaSlicer is installed here, which is a
    // true answer either way.
    const provider = fakeProvider([
      {
        assistant: [{ type: "tool_use", id: "t1", name: "get_slicer_status", input: {} }],
        toolCalls: [{ id: "t1", name: "get_slicer_status", input: {} }],
      },
      { assistant: [{ type: "text", text: "All set." }], toolCalls: [] },
    ]);

    const events: AgentEvent[] = [];
    await runInSession(sessionContext("loop", dir), async () => {
      setUserApiKey("anthropic", KEY);
      const agent = new SlicelyAgent({ resolveProvider: () => provider });
      await agent.send("is the slicer there?", (e) => events.push(e));

      const types = events.map((e) => e.type);
      assert.deepEqual(
        types.filter((t) => t === "tool_start" || t === "tool_end" || t === "text" || t === "done"),
        ["tool_start", "tool_end", "text", "done"],
      );
      // The provider was asked twice, and the SECOND request carried the whole
      // exchange: the user turn, the assistant's tool_use, and its tool_result.
      assert.equal(provider.seen.length, 2);
      const second = provider.seen[1].messages;
      assert.equal(second.length, 3);
      assert.deepEqual(second[0].content, [{ type: "text", text: "is the slicer there?" }]);
      assert.equal(second[1].content[0].type, "tool_use");
      const result = second[2].content[0];
      assert.equal(result.type, "tool_result");
      assert.equal(result.type === "tool_result" && result.id, "t1");

      // The request carries the system prompt and the tools in neutral form.
      assert.match(provider.seen[0].system, /You are Slicely/);
      assert.ok(provider.seen[0].tools.length > 5);
      assert.ok(provider.seen[0].tools.every((t) => typeof t.schema === "object"));
      assert.equal(provider.seen[0].apiKey, KEY);
    });
  });
});

test("a failing tool comes back as an error tool_result with no absolute paths in it", async () => {
  await withTempDir("agent-fail-", async (dir) => {
    // plan_job on a path outside the session workspace throws, deterministically
    // and without a network: it is the shape of failure that used to hand the
    // MODEL a server path to quote back at the user in its own prose.
    const call = { id: "t9", name: "plan_job", input: { parts: [{ path: "/etc/passwd" }] } };
    const provider = fakeProvider([
      { assistant: [{ type: "tool_use", ...call }], toolCalls: [call] },
      { assistant: [{ type: "text", text: "sorry" }], toolCalls: [] },
    ]);
    await runInSession(sessionContext("fail", dir), async () => {
      setUserApiKey("anthropic", KEY);
      const agent = new SlicelyAgent({ resolveProvider: () => provider });
      const events: AgentEvent[] = [];
      await agent.send("break", (e) => events.push(e));
      const ended = events.find((e) => e.type === "tool_end");
      assert.equal(ended?.type === "tool_end" && ended.ok, false);
      const result = provider.seen[1].messages[2].content[0];
      assert.equal(result.type, "tool_result");
      assert.equal(result.type === "tool_result" && result.isError, true);
      const content = result.type === "tool_result" ? result.content : "";
      assert.match(content, /^Error: /, "the model has to be told it failed");
      assert.doesNotMatch(content, /\/Users|\/private|\/home|\/etc/);
    });
  });
});

test("exported history is tagged with its provider and version, and imports back", async () => {
  await withTempDir("agent-hist-", async (dir) => {
    const provider = fakeProvider([{ assistant: [{ type: "text", text: "hello" }], toolCalls: [] }]);
    await runInSession(sessionContext("hist", dir), async () => {
      setUserApiKey("anthropic", KEY);
      const agent = new SlicelyAgent({ resolveProvider: () => provider });
      await agent.send("hi", () => {});

      const exported = agent.exportHistory() as { version: number; provider: string; messages: unknown[] };
      assert.equal(exported.version, 2);
      assert.equal(exported.provider, "anthropic");
      assert.equal(exported.messages.length, 2);

      const reopened = new SlicelyAgent({ resolveProvider: () => provider });
      reopened.importHistory(exported);
      await reopened.send("again", () => {});
      // Turn two saw the restored exchange plus the new question.
      assert.equal(provider.seen[1].messages.length, 3);

      // An UNTAGGED history is the v1 Anthropic shape and is accepted as such.
      const v1 = new SlicelyAgent({ resolveProvider: () => provider });
      v1.importHistory([{ role: "user", content: "older chat" }]);
      await v1.send("carry on", () => {});
      assert.deepEqual(provider.seen[2].messages[0].content, [{ type: "text", text: "older chat" }]);
    });
  });
});

test("reset forgets the conversation, so the next turn starts clean", async () => {
  await withTempDir("agent-reset-", async (dir) => {
    const provider = fakeProvider([
      { assistant: [{ type: "text", text: "one" }], toolCalls: [] },
      { assistant: [{ type: "text", text: "two" }], toolCalls: [] },
    ]);
    await runInSession(sessionContext("reset", dir), async () => {
      setUserApiKey("anthropic", KEY);
      const agent = new SlicelyAgent({ resolveProvider: () => provider });
      await agent.send("first", () => {});
      agent.reset();
      await agent.send("second", () => {});
      assert.equal(provider.seen[1].messages.length, 1, "a reset chat sends only the new question");
    });
  });
});

test("switching provider mid-chat starts a fresh conversation, and says so", async () => {
  // A history holds reasoning blobs and tool ids only their own provider can
  // read, so replaying an Anthropic conversation at OpenAI is a 400 at best and
  // a silently wrong conversation at worst. The reset is deliberate; the user is
  // told, because they are about to notice the assistant has forgotten
  // everything.
  await withTempDir("agent-switch-", async (dir) => {
    const anthropic = fakeProvider([
      { assistant: [{ type: "text", text: "claude here" }], toolCalls: [] },
    ]);
    const openai = fakeProvider([{ assistant: [{ type: "text", text: "gpt here" }], toolCalls: [] }], "openai");

    await runInSession(sessionContext("switch", dir), async () => {
      setUserApiKey("anthropic", KEY);
      setUserApiKey("openai", "sk-proj-" + "o".repeat(40));

      let model = "claude-opus-4-8";
      const agent = new SlicelyAgent({
        resolveProvider: () => (model.startsWith("claude") ? anthropic : openai),
      });
      await agent.send("first", () => {});
      assert.equal((agent.exportHistory() as { provider: string }).provider, "anthropic");

      model = "gpt-5.6-terra";
      const events: AgentEvent[] = [];
      await agent.send("second", (e) => events.push(e));

      // The new provider got ONLY the new question.
      assert.equal(openai.seen.length, 1);
      assert.equal(openai.seen[0].messages.length, 1);
      assert.deepEqual(openai.seen[0].messages[0].content, [{ type: "text", text: "second" }]);
      // And the history now belongs to the new provider.
      assert.equal((agent.exportHistory() as { provider: string }).provider, "openai");

      const said = events
        .filter((e): e is AgentEvent & { type: "text" } => e.type === "text")
        .map((e) => e.text)
        .join("");
      assert.match(said, /OpenAI/);
      assert.match(said, /fresh conversation/i);
    });
  });
});

test("a model whose provider has no key fails as no_key, with the provider named", async () => {
  await withTempDir("agent-nokey-", async (dir) => {
    const openai = fakeProvider([], "openai");
    await runInSession(sessionContext("nokey2", dir), async () => {
      setUserApiKey("anthropic", KEY);
      // The agent is constructed while an Anthropic model is chosen...
      let model = "claude-opus-4-8";
      const anthropic = fakeProvider([{ assistant: [{ type: "text", text: "hi" }], toolCalls: [] }]);
      const agent = new SlicelyAgent({
        resolveProvider: () => (model.startsWith("claude") ? anthropic : openai),
      });
      // ...and the model changes to one this session has no key for.
      model = "gpt-5.6-terra";
      const events: AgentEvent[] = [];
      await agent.send("go", (e) => events.push(e));
      const failure = events.find((e) => e.type === "error");
      assert.equal(failure?.type === "error" && failure.code, "no_key");
      assert.match(failure?.type === "error" ? failure.message : "", /OpenAI/);
      assert.equal(openai.seen.length, 0, "nothing was sent without a key");
    });
  });
});
