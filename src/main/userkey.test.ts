import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInSession, sessionContext } from "./session-context";
import {
  getUserApiKey,
  setUserApiKey,
  clearUserApiKey,
  userKeyHint,
  hasAnyUserApiKey,
  disposeSessionUserKey,
} from "./userkey";
import { resetKeyVaultForTests } from "./keyvault";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

// The developer's own .env (loaded by config.ts) may carry a provider key and
// the operator flag; a hosted-mode test must never see either. A real
// OPENAI_API_KEY in particular must never be reachable from a test.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
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
    setUserApiKey("anthropic", GOOD);
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
      assert.throws(() => setUserApiKey("anthropic", "sk-ant-oat01-" + "x".repeat(40)), /API key|subscription token/i);
      assert.throws(() => setUserApiKey("anthropic", "hello"), /API key|subscription token/i);
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
        setUserApiKey("anthropic", GOOD);
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
        setUserApiKey("anthropic", GOOD);
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
        setUserApiKey("anthropic", GOOD);
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
      setUserApiKey("anthropic", GOOD);
      clearUserApiKey();
      setUserApiKey("anthropic", GOOD);
    });
    const stray = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(stray, [], `no .tmp litter: ${stray.join(", ")}`);
  });
});

// ── two providers, two keys ──────────────────────────────────────────────────
// A user may connect Anthropic, OpenAI, or both. The two must be completely
// independent: connecting one cannot disturb the other, and disconnecting one
// must not disconnect the other or silently reinstate it from the operator's
// environment.

const OPENAI_GOOD = "sk-proj-" + "o".repeat(40);

test("the two providers' keys are stored, hinted and cleared independently", () => {
  withTempDir("uk-p-", (dir) => {
    runInSession(sessionContext("P", dir), () => {
      setUserApiKey("anthropic", GOOD);
      setUserApiKey("openai", OPENAI_GOOD);
      assert.equal(getUserApiKey("anthropic"), GOOD);
      assert.equal(getUserApiKey("openai"), OPENAI_GOOD);
      assert.equal(userKeyHint("anthropic"), "…" + GOOD.slice(-4));
      assert.equal(userKeyHint("openai"), "…" + OPENAI_GOOD.slice(-4));
      assert.equal(hasAnyUserApiKey(), true);

      // Both live in the one encrypted file, neither in plaintext.
      const onDisk = readFileSync(join(dir, "secrets.json"), "utf8");
      assert.ok(!onDisk.includes(GOOD));
      assert.ok(!onDisk.includes(OPENAI_GOOD));
      const parsed = JSON.parse(onDisk) as Record<string, unknown>;
      assert.equal(typeof parsed.anthropicKey, "string");
      assert.equal(typeof parsed.openaiKey, "string");

      // Disconnecting one leaves the other exactly as it was.
      clearUserApiKey("openai");
      assert.equal(getUserApiKey("openai"), undefined);
      assert.equal(getUserApiKey("anthropic"), GOOD, "the other key must survive");
      assert.equal(hasAnyUserApiKey(), true, "one key is still a key");
    });
    // And it survives a cache drop, which is what proves the tombstone is on disk.
    disposeSessionUserKey("P");
    runInSession(sessionContext("P", dir), () => {
      assert.equal(getUserApiKey("openai"), undefined);
      assert.equal(getUserApiKey("anthropic"), GOOD);
    });
  });
});

test("the default provider is anthropic, so every old caller keeps working", () => {
  withTempDir("uk-q-", (dir) => {
    runInSession(sessionContext("Q", dir), () => {
      setUserApiKey("anthropic", GOOD);
      assert.equal(getUserApiKey(), GOOD);
      assert.equal(userKeyHint(), "…" + GOOD.slice(-4));
      clearUserApiKey();
      assert.equal(getUserApiKey(), undefined);
      assert.equal(hasAnyUserApiKey(), false);
    });
  });
});

test("an Anthropic key is not accepted as an OpenAI key, or the other way round", () => {
  withTempDir("uk-r-", (dir) => {
    runInSession(sessionContext("R", dir), () => {
      assert.throws(() => setUserApiKey("openai", GOOD), /Anthropic key/i);
      assert.throws(() => setUserApiKey("anthropic", OPENAI_GOOD), /Anthropic API key/i);
      // An Admin key would only ever produce a confusing 401 at chat time.
      assert.throws(() => setUserApiKey("openai", "sk-admin-" + "a".repeat(40)), /Admin/i);
      assert.equal(hasAnyUserApiKey(), false, "nothing was stored");
    });
  });
});

test("the operator fallback is per provider, under the same one gate", () => {
  withTempDir("uk-s-", (dir) => {
    const OP_ANTHROPIC = "sk-ant-api03-" + "s".repeat(40);
    const OP_OPENAI = "sk-proj-" + "s".repeat(40);
    process.env.SLICELY_MODE = "hosted";
    process.env.ANTHROPIC_API_KEY = OP_ANTHROPIC;
    process.env.OPENAI_API_KEY = OP_OPENAI;
    delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
    try {
      runInSession(sessionContext("S", dir), () => {
        // A stray OPENAI_API_KEY in a hosted environment — for a script, a
        // sibling service, a copied .env — must not be spent on visitors either.
        assert.equal(getUserApiKey("openai"), undefined);
        assert.equal(getUserApiKey("anthropic"), undefined);
      });

      process.env.SLICELY_ALLOW_OPERATOR_KEY = "1";
      disposeSessionUserKey("S");
      runInSession(sessionContext("S", dir), () => {
        assert.equal(getUserApiKey("openai"), OP_OPENAI, "the same flag grants both");
        assert.equal(getUserApiKey("anthropic"), OP_ANTHROPIC);
        // And the operator's key is never described by its last four characters.
        assert.equal(userKeyHint("openai"), "this server's key");

        // An explicit disconnect of ONE still beats the fallback for that one.
        clearUserApiKey("openai");
        assert.equal(getUserApiKey("openai"), undefined);
        assert.equal(getUserApiKey("anthropic"), OP_ANTHROPIC);
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
      process.env.SLICELY_MODE = "hosted";
    }
  });
});

test("a secrets file written by a future version keeps its own version number", () => {
  // `readSecrets` used to stamp `version: 1` over whatever the file said and then
  // write that back, so the first key change on a machine running a newer
  // Slicely would quietly downgrade the file's own format marker — and a future
  // migration keyed on that number would then skip it.
  withTempDir("uk-ver-", (dir) => {
    runInSession(sessionContext("V", dir), () => {
      const path = join(dir, "secrets.json");
      writeFileSync(path, JSON.stringify({ version: 7, somethingNew: "keep me" }), { mode: 0o600 });
      setUserApiKey("anthropic", GOOD);
      const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.equal(after.version, 7, "the file's own version survives a write");
      assert.equal(after.somethingNew, "keep me", "and so does everything else in it");
      assert.equal(typeof after.anthropicKey, "string");
    });
  });
});
