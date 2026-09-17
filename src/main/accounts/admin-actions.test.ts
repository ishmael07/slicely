import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { accountExistsFor, findOrCreateAccount, getAccount, isRetired, resetAccountsForTests, balanceMicros } from "./store";
import { normalizeEmail } from "./email";
import { addCredit, AdminActionError, removeAccount, setBlocked, zeroBalance } from "./admin-actions";

process.env.SLICELY_MODE = "hosted";

function fresh(): () => void {
  const root = mkdtempSync(join(tmpdir(), "slicely-admin-actions-"));
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  resetAccountsForTests();
  return () => {
    delete process.env.SLICELY_WORKDIR;
    resetConfigForTests();
    resetAccountsForTests();
    rmSync(root, { recursive: true, force: true });
  };
}

const GRANT = 50_000_000; // 50¢

function person(email = "p@example.com") {
  const out = findOrCreateAccount(
    { provider: "github", providerUserId: email, email, normalizedEmail: normalizeEmail(email).normalized },
    GRANT,
  );
  assert.ok(out.account);
  return out.account;
}

test("block and unblock flip the flag and persist", async () => {
  const done = fresh();
  try {
    const a = person();
    assert.equal((await setBlocked(a.id, true)).blocked, true);
    resetAccountsForTests(); // reread from disk
    assert.equal(getAccount(a.id)?.blocked, true);
    await setBlocked(a.id, false);
    assert.equal("blocked" in (getAccount(a.id) ?? {}), false);
  } finally {
    done();
  }
});

test("a top-up raises the grant, within bounds", async () => {
  const done = fresh();
  try {
    const a = person();
    const after = await addCredit(a.id, 25_000_000);
    assert.equal(balanceMicros(after), GRANT + 25_000_000);
    await assert.rejects(addCredit(a.id, 0), (e) => e instanceof AdminActionError && e.code === "bad_amount");
    await assert.rejects(addCredit(a.id, 1.5), (e) => e instanceof AdminActionError && e.code === "bad_amount");
    await assert.rejects(addCredit(a.id, 51 * 100 * 1_000_000), (e) => e instanceof AdminActionError && e.code === "bad_amount");
    await assert.rejects(addCredit("nope", 1), (e) => e instanceof AdminActionError && e.code === "not_found");
  } finally {
    done();
  }
});

test("zeroing leaves nothing to spend and a top-up brings it back", async () => {
  const done = fresh();
  try {
    const a = person();
    assert.equal(balanceMicros(await zeroBalance(a.id)), 0);
    assert.equal(balanceMicros(await addCredit(a.id, 10_000_000)), 10_000_000);
  } finally {
    done();
  }
});

test("deleting retires the e-mail so it cannot claim credit again", async () => {
  const done = fresh();
  try {
    const a = person("gone@example.com");
    await removeAccount(a.id);
    assert.equal(getAccount(a.id), undefined);
    assert.equal(isRetired(a.normalizedEmail), true);
    assert.equal(accountExistsFor(a.normalizedEmail), false);
    await assert.rejects(removeAccount(a.id), (e) => e instanceof AdminActionError && e.code === "not_found");
  } finally {
    done();
  }
});
