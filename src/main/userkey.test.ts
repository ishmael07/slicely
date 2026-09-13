import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInSession, sessionContext } from "./session-context";
import { getUserApiKey, setUserApiKey, clearUserApiKey, userKeyHint, disposeSessionUserKey } from "./userkey";
import { resetKeyVaultForTests } from "./keyvault";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

// The developer's own .env (loaded by config.ts) may carry an ANTHROPIC_API_KEY
// and the operator flag; a hosted-mode test must never see either.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
resetKeyVaultForTests();

const GOOD = "sk-ant-api03-" + "a".repeat(40);

/** A temp session directory that is ALWAYS removed. These tests used to leak
 *  one per run per test; a few hundred of them were still in $TMPDIR. */
function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a key is stored encrypted and only readable inside its own session", () => {
  withTempDir("uk-a-", (dirA) => withTempDir("uk-b-", (dirB) => {
  runInSession(sessionContext("A", dirA), () => {
    setUserApiKey(GOOD);
    assert.equal(getUserApiKey(), GOOD);
    assert.equal(userKeyHint(), "…" + GOOD.slice(-4));
    const onDisk = readFileSync(join(dirA, "secrets.json"), "utf8");
    assert.ok(!onDisk.includes(GOOD), "plaintext key must never hit disk");
  });
  runInSession(sessionContext("B", dirB), () => {
    assert.equal(getUserApiKey(), undefined);
  });
  disposeSessionUserKey("A");
  runInSession(sessionContext("A", dirA), () => {
    assert.equal(getUserApiKey(), GOOD, "survives a cache drop by re-reading disk");
    clearUserApiKey();
    assert.equal(getUserApiKey(), undefined);
  });
  }));
});

test("malformed keys are rejected before anything is written", () => {
  withTempDir("uk-c-", (dir) => {
    runInSession(sessionContext("C", dir), () => {
      assert.throws(() => setUserApiKey("sk-ant-oat01-" + "x".repeat(40)), /format|Anthropic API key/i);
      assert.throws(() => setUserApiKey("hello"), /format|Anthropic API key/i);
      assert.equal(getUserApiKey(), undefined);
    });
  });
});

test("disconnecting beats the operator fallback — 'no' means no", () => {
  // Desktop mode falls back to the operator's own ANTHROPIC_API_KEY. Without a
  // tombstone, DELETE /api/key would report hasKey:false and the very next
  // /api/config would report hasKey:true again, with chat quietly spending that
  // key after the user asked it to stop.
  withTempDir("uk-d-", (dir) => {
    const OPERATOR = "sk-ant-api03-" + "d".repeat(40);
    process.env.SLICELY_MODE = "desktop";
    process.env.ANTHROPIC_API_KEY = OPERATOR;
    try {
      runInSession(sessionContext("D", dir), () => {
        assert.equal(getUserApiKey(), OPERATOR, "the fallback applies when nothing is stored");
        clearUserApiKey();
        assert.equal(getUserApiKey(), undefined, "an explicit disconnect must stick");
        assert.equal(userKeyHint(), undefined);
      });
      disposeSessionUserKey("D");
      runInSession(sessionContext("D", dir), () => {
        assert.equal(getUserApiKey(), undefined, "and it survives a cache drop");
        // Connecting a key again lifts the disconnect.
        setUserApiKey(GOOD);
        assert.equal(getUserApiKey(), GOOD);
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.SLICELY_MODE = "hosted";
    }
  });
});

// ── who pays for chat ───────────────────────────────────────────────────────
// The operator's key is a loaded gun on a public server: every visitor's chat
// bills the person who deployed it. Reading the standard variable name is only
// safe because the name is not the permission — the flag is.

test("a hosted server ignores the operator's ANTHROPIC_API_KEY unless it opts in", () => {
  withTempDir("uk-f-", (dir) => {
    const OPERATOR = "sk-ant-api03-" + "f".repeat(40);
    process.env.SLICELY_MODE = "hosted";
    process.env.ANTHROPIC_API_KEY = OPERATOR;
    delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
    try {
      runInSession(sessionContext("F", dir), () => {
        assert.equal(
          getUserApiKey(),
          undefined,
          "a stray ANTHROPIC_API_KEY in a hosted environment must not be spent on visitors",
        );
        assert.equal(userKeyHint(), undefined);
      });

      // The explicit opt-in, and only the exact value.
      for (const bad of ["0", "", "true", "yes"]) {
        process.env.SLICELY_ALLOW_OPERATOR_KEY = bad;
        disposeSessionUserKey("F");
        runInSession(sessionContext("F", dir), () => {
          assert.equal(getUserApiKey(), undefined, `"${bad}" is not the opt-in`);
        });
      }

      process.env.SLICELY_ALLOW_OPERATOR_KEY = "1";
      disposeSessionUserKey("F");
      runInSession(sessionContext("F", dir), () => {
        assert.equal(getUserApiKey(), OPERATOR, "the flag is what grants it");
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
      process.env.SLICELY_MODE = "hosted";
    }
  });
});

test("the operator's key is never described by its last four characters", () => {
  withTempDir("uk-g-", (dir) => {
    const OPERATOR = "sk-ant-api03-" + "g".repeat(36) + "9xyz";
    process.env.SLICELY_MODE = "desktop";
    process.env.ANTHROPIC_API_KEY = OPERATOR;
    try {
      runInSession(sessionContext("G", dir), () => {
        // Four characters of the owner's credential are four characters a
        // visitor has no business seeing — and "…9xyz" would also read as "the
        // key I pasted" to someone who pasted nothing.
        assert.equal(userKeyHint(), "this server's key");
        assert.doesNotMatch(String(userKeyHint()), /9xyz/);

        // A key the user actually connected is still identified the usual way.
        setUserApiKey(GOOD);
        assert.equal(userKeyHint(), "…" + GOOD.slice(-4));
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.SLICELY_MODE = "hosted";
    }
  });
});

test("a session's own key always wins over the operator's", () => {
  withTempDir("uk-h-", (dir) => {
    const OPERATOR = "sk-ant-api03-" + "h".repeat(40);
    process.env.SLICELY_MODE = "desktop";
    process.env.ANTHROPIC_API_KEY = OPERATOR;
    try {
      runInSession(sessionContext("H", dir), () => {
        setUserApiKey(GOOD);
        assert.equal(getUserApiKey(), GOOD, "the visitor pays for their own chat");
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.SLICELY_MODE = "hosted";
    }
  });
});

test("secrets.json is replaced atomically, leaving no temp files behind", () => {
  withTempDir("uk-e-", (dir) => {
    runInSession(sessionContext("E", dir), () => {
      setUserApiKey(GOOD);
      clearUserApiKey();
      setUserApiKey(GOOD);
    });
    const stray = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(stray, [], `no .tmp litter: ${stray.join(", ")}`);
  });
});
