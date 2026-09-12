import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, KeyVaultError, loadMasterKey, resetKeyVaultForTests } from "./keyvault";

const k1 = randomBytes(32);
const k2 = randomBytes(32);

test("round-trips, and the ciphertext never contains the plaintext", () => {
  const blob = encryptSecret("sk-ant-api03-hello", k1);
  assert.equal(decryptSecret(blob, k1), "sk-ant-api03-hello");
  assert.ok(!blob.includes("sk-ant"));
  assert.ok(blob.startsWith("v1:"));
});

test("two encryptions of the same value differ (fresh IV each time)", () => {
  assert.notEqual(encryptSecret("x", k1), encryptSecret("x", k1));
});

test("the wrong master key, or a tampered blob, is an error — never silent garbage", () => {
  const blob = encryptSecret("secret", k1);
  assert.throws(() => decryptSecret(blob, k2), KeyVaultError);
  const parts = blob.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":"), k1), KeyVaultError);
  assert.throws(() => decryptSecret("not-a-blob", k1), KeyVaultError);
});

test("hosted mode refuses to boot without a real 32-byte SLICELY_MASTER_KEY", () => {
  process.env.SLICELY_MODE = "hosted";
  delete process.env.SLICELY_MASTER_KEY;
  resetKeyVaultForTests();
  assert.throws(() => loadMasterKey(), /SLICELY_MASTER_KEY/);
  process.env.SLICELY_MASTER_KEY = Buffer.from("short").toString("base64");
  resetKeyVaultForTests();
  assert.throws(() => loadMasterKey(), /32 bytes/);
  process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
  resetKeyVaultForTests();
  assert.equal(loadMasterKey().length, 32);
  delete process.env.SLICELY_MASTER_KEY;
  delete process.env.SLICELY_MODE;
  resetKeyVaultForTests();
});
