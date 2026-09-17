import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config";
import { centsToMicros } from "../pricing";
import {
  findOrCreateAccount, getAccount, writeAccount, balanceMicros,
  deleteAccount, isRetired, accountExistsFor, withAccountLock, recordSignin,
  resetAccountsForTests, type Account, type SignInProfile,
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

test("a returning visitor is not a signup — accountExistsFor says which is which", () => {
  const dir = freshWorkdir();
  try {
    // The question the sign-in route asks BEFORE creating anything, so a
    // returning visitor behind a busy NAT is not refused as somebody else's
    // fourth signup of the day.
    assert.equal(accountExistsFor("janedoe@gmail.com"), false, "nobody yet");
    const { account } = findOrCreateAccount(profile(), GRANT);
    assert.equal(accountExistsFor("janedoe@gmail.com"), true, "now a returning visitor");
    assert.equal(accountExistsFor("someone.else@example.com"), false);

    resetAccountsForTests();                 // as if the server restarted
    assert.equal(accountExistsFor("janedoe@gmail.com"), true, "read off disk, not from memory");

    // A retired email has no account: signing up again DOES create a record —
    // with no money in it — and that record is what the cap counts.
    deleteAccount(account.id);
    assert.equal(isRetired("janedoe@gmail.com"), true);
    assert.equal(accountExistsFor("janedoe@gmail.com"), false);
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

test("a missing index.json is rebuilt from the account files, so nobody is granted twice", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    const other = findOrCreateAccount(
      profile({ providerUserId: "222", email: "sam@example.com", normalizedEmail: "sam@example.com" }),
      GRANT,
    ).account;

    // A crash between the account write and the index write — or a hand-deleted
    // index — leaves the by-id/ files as the only truth. They are enough.
    rmSync(indexFile(), { force: true });
    resetAccountsForTests();

    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.account.id, account.id, "found by rebuilding from by-id/");
    assert.equal(again.granted, false, "and NOT granted a second fifty cents");
    assert.equal(again.account.grantedMicros, GRANT, "still the one grant it always had");
    assert.equal(accountExistsFor("sam@example.com"), true, "every account file is indexed, not just one");
    assert.equal(getAccount(other.id)!.id, other.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleting an account retires its email even when the account file is unreadable", () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    // The file is gone, or unreadable: the index still knows which email pointed
    // at this id, and that is the thing that must be retired.
    rmSync(accountFile(account.id), { force: true });
    resetAccountsForTests();

    deleteAccount(account.id);
    assert.equal(isRetired("janedoe@gmail.com"), true, "the reverse index is enough to retire by");
    assert.equal(accountExistsFor("janedoe@gmail.com"), false);
    const again = findOrCreateAccount(profile(), GRANT);
    assert.equal(again.granted, false);
    assert.equal(again.account.grantedMicros, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── sign-in history ──────────────────────────────────────────────────────────

/** `recordSignin` returns void and does its work under the account lock, so a
 *  test waits by taking the same lock afterwards: the chain runs in order. */
function settled(id: string): Promise<unknown> {
  return withAccountLock(id, async () => undefined);
}

test("a sign-in is recorded newest first, with the hashed address and the session", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    recordSignin(account.id, { ipHash: "a".repeat(32), sid: "sid-one" });
    await settled(account.id);
    recordSignin(account.id, { ipHash: "b".repeat(32), sid: "sid-two" });
    await settled(account.id);

    resetAccountsForTests();
    const stored = getAccount(account.id)!;
    assert.equal(stored.signins?.length, 2);
    assert.equal(stored.signins![0].sid, "sid-two", "newest first");
    assert.equal(stored.signins![0].ipHash, "b".repeat(32));
    assert.equal(stored.signins![1].sid, "sid-one");
    assert.ok(Number.isSafeInteger(stored.signins![0].at) && stored.signins![0].at > 0);
    assert.ok(stored.signins![0].at >= stored.signins![1].at, "time does not run backwards");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only the last twenty sign-ins are kept", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    for (let i = 0; i < 25; i += 1) {
      recordSignin(account.id, { ipHash: "c".repeat(32), sid: `sid-${i}` });
    }
    await settled(account.id);

    resetAccountsForTests();
    const stored = getAccount(account.id)!;
    assert.equal(stored.signins?.length, 20, "the history is capped, not unbounded");
    assert.equal(stored.signins![0].sid, "sid-24", "the newest survives");
    assert.equal(stored.signins![19].sid, "sid-5", "the oldest five fell off the end");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an account written before sign-in history existed records its first one", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    // An old record on disk: no `signins` key at all. Reading it must work, and
    // the first sign-in after the upgrade must start the list rather than throw.
    const old = { ...account } as Partial<Account> & { signins?: unknown };
    delete old.signins;
    writeAccount(old as Account);
    resetAccountsForTests();
    assert.equal(getAccount(account.id)!.signins, undefined, "an old record simply has none");

    recordSignin(account.id, { ipHash: "d".repeat(32), sid: "sid-after" });
    await settled(account.id);
    resetAccountsForTests();
    assert.deepEqual(
      getAccount(account.id)!.signins!.map((s) => s.sid),
      ["sid-after"],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleting an account takes its sign-in history with it", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    recordSignin(account.id, { ipHash: "e".repeat(32), sid: "sid-gone" });
    await settled(account.id);
    assert.ok(readFileSync(accountFile(account.id), "utf8").includes("sid-gone"));

    deleteAccount(account.id);
    assert.equal(existsSync(accountFile(account.id)), false, "the whole record goes, history included");
    resetAccountsForTests();
    assert.equal(getAccount(account.id), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recording a sign-in for an account that is gone is a no-op, not a throw", async () => {
  const dir = freshWorkdir();
  try {
    const { account } = findOrCreateAccount(profile(), GRANT);
    deleteAccount(account.id);
    recordSignin(account.id, { ipHash: "f".repeat(32), sid: "sid-nowhere" });
    await settled(account.id);
    assert.equal(existsSync(accountFile(account.id)), false, "nothing is resurrected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
