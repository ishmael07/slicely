// Proves the session scoping actually isolates. This is the load-bearing
// guarantee for multi-user web Slicely: two visitors must never see each
// other's active model, preferences, or job.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runInSession,
  sessionContext,
  currentSessionId,
  DEFAULT_SESSION_ID,
} from "./session-context";
import { sessionState } from "./agent/state";
import { getSettings, updateSettings } from "./settings";

test("outside runInSession, the ambient session is the default (Electron's path)", () => {
  assert.equal(currentSessionId(), DEFAULT_SESSION_ID);
});

test("two sessions do not see each other's conversation state", () => {
  runInSession(sessionContext("alice"), () => {
    sessionState.lastModelPath = "/tmp/alice.stl";
    sessionState.lastModelParts = ["/tmp/alice.stl"];
  });
  runInSession(sessionContext("bob"), () => {
    sessionState.lastModelPath = "/tmp/bob.stl";
  });

  runInSession(sessionContext("alice"), () => {
    assert.equal(sessionState.lastModelPath, "/tmp/alice.stl");
    assert.deepEqual(sessionState.lastModelParts, ["/tmp/alice.stl"]);
  });
  runInSession(sessionContext("bob"), () => {
    assert.equal(sessionState.lastModelPath, "/tmp/bob.stl");
    // Bob never set parts, so he sees his own empty default — not Alice's.
    assert.deepEqual(sessionState.lastModelParts, []);
  });
});

test("session state survives an await boundary inside the same session", async () => {
  await runInSession(sessionContext("carol"), async () => {
    sessionState.lastJobId = "job-carol";
    await new Promise((r) => setTimeout(r, 1));
    // AsyncLocalStorage must carry the context across the await.
    assert.equal(sessionState.lastJobId, "job-carol");
    assert.equal(currentSessionId(), "carol");
  });
});

test("concurrent interleaved sessions keep their own state", async () => {
  const run = (id: string, path: string) =>
    runInSession(sessionContext(id), async () => {
      sessionState.lastModelPath = path;
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return sessionState.lastModelPath;
    });

  const results = await Promise.all([
    run("s1", "/a.stl"),
    run("s2", "/b.stl"),
    run("s3", "/c.stl"),
  ]);
  assert.deepEqual(results, ["/a.stl", "/b.stl", "/c.stl"]);
});

test("settings are per-session: one visitor's model choice does not leak", () => {
  const alt = "claude-haiku-4-5";
  const dflt = runInSession(sessionContext("dave"), () => getSettings().model);

  runInSession(sessionContext("erin"), () => {
    updateSettings({ model: alt });
    assert.equal(getSettings().model, alt);
  });

  runInSession(sessionContext("dave"), () => {
    assert.equal(
      getSettings().model,
      dflt,
      "Dave's model must be unchanged by Erin's update",
    );
  });
});

test("mutating state in the default session does not touch a named session", () => {
  sessionState.lastModelPath = "/electron.stl";
  runInSession(sessionContext("frank"), () => {
    assert.notEqual(sessionState.lastModelPath, "/electron.stl");
  });
  assert.equal(sessionState.lastModelPath, "/electron.stl");
});
