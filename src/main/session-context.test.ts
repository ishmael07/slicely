// Proves the session scoping actually isolates. This is the load-bearing
// guarantee for multi-user web Slicely: two visitors must never see each
// other's active model, preferences, or job.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig } from "./config";
import {
  runInSession,
  sessionContext,
  currentSessionId,
  DEFAULT_SESSION_ID,
  sessionSlicesDir,
  realPath,
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

// These tests deliberately create real session directories, and SLICELY_WORKDIR
// defaults to ~/Slicely — which on a case-insensitive filesystem is the repo
// itself. Clean up after ourselves so a test run never leaves workspace litter.
after(() => {
  for (const id of [
    "alice", "bob", "carol", "dave", "erin", "frank", "s1", "s2", "s3",
  ]) {
    rmSync(join(getConfig().workdir, "sessions", id), {
      recursive: true,
      force: true,
    });
  }
});

test("two sessions never share a slices directory", () => {
  // PrusaSlicer names output after the plate, so concurrent visitors all want
  // "plate-1.gcode". When that resolved to one shared directory, the second
  // slice overwrote the first before the server could adopt it, and the first
  // visitor downloaded the second's part.
  const a = sessionContext("sess-a", join(tmpdir(), "slicely-iso-a"));
  const b = sessionContext("sess-b", join(tmpdir(), "slicely-iso-b"));

  const dirA = runInSession(a, () => sessionSlicesDir());
  const dirB = runInSession(b, () => sessionSlicesDir());

  assert.notEqual(dirA, dirB);
  assert.ok(dirA.startsWith(a.dir), `${dirA} must live inside ${a.dir}`);
  assert.ok(dirB.startsWith(b.dir), `${dirB} must live inside ${b.dir}`);
  assert.ok(existsSync(dirA) && existsSync(dirB), "both directories must be created");

  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test("outside a session, slices still land where Electron has always put them", () => {
  // The desktop app has one user and an existing workdir; session scoping must
  // not relocate its output.
  assert.equal(sessionSlicesDir(), join(getConfig().workdir, "slices"));
});

test("realPath keeps the whole tail of a path that does not exist yet", () => {
  // A slice about to be written does not exist, so `realPath` resolves as far up
  // as it can and re-attaches the rest. The re-attaching used to be
  // `head.slice(parent.length + 1)`, which is right for every parent EXCEPT the
  // root: `dirname("/x")` is `"/"`, whose length is 1, so the slice started at
  // index 2 of a two-character string and produced `""`. `join` drops an empty
  // segment, so `realPath("/x")` came back as `"/"` — a path one level below the
  // root was judged as the root itself.
  assert.equal(realPath("/nonexistent-zzz"), "/nonexistent-zzz");
  assert.equal(realPath("/x"), "/x");
  // Deeper missing tails, where more than one segment has to survive the walk.
  assert.equal(realPath("/nonexistent-zzz/a/b.gcode"), "/nonexistent-zzz/a/b.gcode");
  // And an existing directory with a missing child still resolves the existing
  // part (realpathSync on tmpdir may unwrap a symlink, e.g. /var → /private/var).
  const parent = realpathSync(tmpdir());
  assert.equal(realPath(join(tmpdir(), "nonexistent-zzz.gcode")), join(parent, "nonexistent-zzz.gcode"));
});
