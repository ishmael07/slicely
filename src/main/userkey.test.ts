import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInSession, sessionContext } from "./session-context";
import { getUserApiKey, setUserApiKey, clearUserApiKey, userKeyHint, disposeSessionUserKey } from "./userkey";
import { resetKeyVaultForTests } from "./keyvault";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

const GOOD = "sk-ant-api03-" + "a".repeat(40);

test("a key is stored encrypted and only readable inside its own session", () => {
  const dirA = mkdtempSync(join(tmpdir(), "uk-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "uk-b-"));
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
});

test("malformed keys are rejected before anything is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "uk-c-"));
  runInSession(sessionContext("C", dir), () => {
    assert.throws(() => setUserApiKey("sk-ant-oat01-" + "x".repeat(40)), /format|Anthropic API key/i);
    assert.throws(() => setUserApiKey("hello"), /format|Anthropic API key/i);
    assert.equal(getUserApiKey(), undefined);
  });
});
