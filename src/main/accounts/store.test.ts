import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { centsToMicros } from "../pricing";
import {
  findOrCreateAccount, getAccount, writeAccount, balanceMicros,
  deleteAccount, isRetired, withAccountLock, resetAccountsForTests,
  type SignInProfile,
} from "./store";
import { accountFile, indexFile, utcDay } from "./paths";

function freshWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "slicely-accounts-"));
  process.env.SLICELY_WORKDIR = dir;
  resetConfigForTests();
  resetAccountsForTests();
  return dir;
}

const GRANT = centsToMicros(50);

function profile(over: Partial<SignInProfile> = {}): SignInProfile {
  return {
    provider: "google",
    providerUserId: "107812345",
    email: "Jane.Doe@gmail.com",
    normalizedEmail: "janedoe@gmail.com",
    name: "Jane Doe",
    ...over,
  };
}

test("a first sign-in creates an account with the grant, and says it granted", () => {
  const dir = freshWorkdir();
  try {
    const { account, granted } = findOrCreateAccount(profile(), GRANT);
    assert.equal(granted, true);
    assert.equal(account.grantedMicros, GRANT);
    assert.equal(account.spentMicros, 0);
    assert.equal(balanceMicros(account), GRANT);
    assert.equal(account.email, "Jane.Doe@gmail.com", "the display email is kept verbatim");
    assert.equal(account.normalizedEmail, "janedoe@gmail.com");
    assert.equal(account.chatDay, utcDay());
    assert.equal(account.chatCount, 0);
    assert.ok(/^[0-9a-f]{32}$/.test(account.id), "ids are 16 random bytes in hex");
    assert.ok(existsSync(accountFile(account.id)));
    assert.ok(existsSync(indexFile()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("signing in again finds the same account and grants nothing more", () => {
  const dir = freshWorkdir();
  try {
    const first = findOrCreateAccount(profile(), GRANT);
    first.account.spentMicros = 30_000_000;
    writeAccount(first.account);

    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.granted, false);
    assert.equal(again.account.id, first.account.id);
    assert.equal(again.account.grantedMicros, GRANT, "the grant is not topped up");
    assert.equal(again.account.spentMicros, 30_000_000, "spend survives a re-sign-in");
    assert.equal(balanceMicros(again.account), 20_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same human on a second provider is the same account — one grant per person", () => {
  const dir = freshWorkdir();
  try {
    const viaGoogle = findOrCreateAccount(profile(), GRANT);
    const viaGithub = findOrCreateAccount(
      profile({ provider: "github", providerUserId: "99", email: "janedoe@gmail.com" }),
      GRANT,
    );
    assert.equal(viaGithub.granted, false);
    assert.equal(viaGithub.account.id, viaGoogle.account.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh process re-reads the index off disk", () => {
  const dir = freshWorkdir();
  try {
    const first = findOrCreateAccount(profile(), GRANT);
    resetAccountsForTests();                 // as if the server restarted
    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.account.id, first.account.id);
    assert.equal(again.granted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleting an account retires the email, so credit is never granted twice", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    deleteAccount(account.id);
    assert.equal(getAccount(account.id), undefined);
    assert.equal(existsSync(accountFile(account.id)), false);
    assert.equal(isRetired("janedoe@gmail.com"), true);

    const back = findOrCreateAccount(profile(), GRANT);
    assert.notEqual(back.account.id, account.id, "a new record …");
    assert.equal(back.granted, false, "… but no new credit");
    assert.equal(back.account.grantedMicros, 0);
    assert.equal(balanceMicros(back.account), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an account file holds no secret and no IP", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    const raw = readFileSync(accountFile(account.id), "utf8");
    for (const forbidden of ["access_token", "id_token", "sk-", "Bearer", "127.0.0.1", "verifier"]) {
      assert.ok(!raw.includes(forbidden), `${forbidden} must never reach an account file`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent charges under the lock land exactly once each", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withAccountLock(account.id, async () => {
          const live = getAccount(account.id)!;
          live.spentMicros += 1_000;
          await new Promise((r) => setTimeout(r, 1));   // force interleaving
          writeAccount(live);
        }),
      ),
    );
    resetAccountsForTests();
    assert.equal(getAccount(account.id)!.spentMicros, 20_000, "no lost update");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
