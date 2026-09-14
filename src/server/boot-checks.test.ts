// ─────────────────────────────────────────────────────────────────────────────
// boot-checks.test.ts — the accounts environment, judged at boot.
//
// Two decisions, both pure: which SLICELY_PUBLIC_URL values can carry an OAuth
// redirect, and which half-configured deployment deserves the one warning line.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountsBootWarning, publicOriginProblem, runAccountsBootChecks } from "./boot-checks";

test("a usable public origin is https, or http on loopback", () => {
  for (const ok of [
    "https://slicely.fly.dev",
    "https://slicely.fly.dev/",
    "https://app.slicely.example:8443",
    "http://localhost:3000",
    "http://127.0.0.1:59806",
    "http://[::1]:3000",
    // Unset is not this function's business: no OAuth is a supported shape.
    "",
    "   ",
  ]) {
    assert.equal(publicOriginProblem(ok), undefined, `${JSON.stringify(ok)} is usable`);
  }
});

test("the values that would silently break a redirect URI are named, not guessed at", () => {
  // Each of these builds a redirect URI that looks plausible in a log and
  // matches nothing the provider has registered.
  const bad: Array<[string, RegExp]> = [
    ["slicely.fly.dev", /not a URL/],
    ["//slicely.fly.dev", /not a URL/],
    ["http://slicely.fly.dev", /must be https/],
    ["ftp://slicely.fly.dev", /must be https/],
    ["https://user:pw@slicely.fly.dev", /username or password/],
    ["https://slicely.fly.dev/app", /bare origin/],
    ["https://slicely.fly.dev/?x=1", /bare origin/],
    ["https://slicely.fly.dev/#top", /bare origin/],
  ];
  for (const [value, expected] of bad) {
    const problem = publicOriginProblem(value);
    assert.ok(problem, `${value} must be refused`);
    assert.match(problem, expected);
  }
});

test("no OAuth client means no warning: bring-your-own-key is a supported product", () => {
  assert.equal(
    accountsBootWarning({ oauthSecretsSet: false, publicUrl: "", ownerKeySet: false }),
    undefined,
  );
  // Nor does a key on its own imply anybody wanted accounts.
  assert.equal(
    accountsBootWarning({ oauthSecretsSet: false, publicUrl: "", ownerKeySet: true }),
    undefined,
  );
});

test("an OAuth client with nothing to redirect to, or nothing to fund, says so once", () => {
  const noOrigin = accountsBootWarning({ oauthSecretsSet: true, publicUrl: "", ownerKeySet: true });
  assert.ok(noOrigin);
  assert.match(noOrigin, /DISABLED/);
  assert.match(noOrigin, /SLICELY_PUBLIC_URL/);

  const noKey = accountsBootWarning({
    oauthSecretsSet: true,
    publicUrl: "https://slicely.fly.dev",
    ownerKeySet: false,
  });
  assert.ok(noKey);
  assert.match(noKey, /DISABLED/);
  assert.match(noKey, /ANTHROPIC_API_KEY/);

  // ONE line, never two: the missing origin is the earlier gate and is reported
  // alone, because an owner reading two paragraphs about the same dead feature
  // reads neither.
  const both = accountsBootWarning({ oauthSecretsSet: true, publicUrl: "", ownerKeySet: false });
  assert.equal(both, noOrigin);

  // Fully configured: nothing to say.
  assert.equal(
    accountsBootWarning({
      oauthSecretsSet: true,
      publicUrl: "https://slicely.fly.dev",
      ownerKeySet: true,
    }),
    undefined,
  );
});

/** Run the env-reading wrapper with exactly these variables set, and put the
 *  environment back however it goes. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of ["SLICELY_PUBLIC_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(vars)) if (value !== undefined) process.env[name] = value;
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a broken public URL refuses to boot — but only when somebody wanted OAuth", () => {
  const logs: string[] = [];
  // The same bad value with no OAuth client is an unused variable, and killing a
  // working deploy over one would be the wrong trade.
  withEnv({ SLICELY_PUBLIC_URL: "slicely.fly.dev" }, () => {
    runAccountsBootChecks((m) => logs.push(m));
  });
  assert.deepEqual(logs, [], "no OAuth, nothing to say");

  assert.throws(
    () =>
      withEnv({ SLICELY_PUBLIC_URL: "slicely.fly.dev", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, () =>
        runAccountsBootChecks(() => undefined),
      ),
    /SLICELY_PUBLIC_URL is not usable/,
  );
});

test("the wrapper logs the one line, prefixed so it is greppable", () => {
  const logs: string[] = [];
  withEnv({ SLICELY_PUBLIC_URL: "https://slicely.fly.dev", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" }, () => {
    runAccountsBootChecks((m) => logs.push(m));
  });
  assert.equal(logs.length, 1, "exactly one line at boot");
  assert.match(logs[0], /^\[accounts] accounts are DISABLED/);
  assert.match(logs[0], /ANTHROPIC_API_KEY/);

  // And nothing at all when the three ingredients are all present.
  const quiet: string[] = [];
  withEnv(
    {
      SLICELY_PUBLIC_URL: "https://slicely.fly.dev",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "s",
      ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
    },
    () => runAccountsBootChecks((m) => quiet.push(m)),
  );
  assert.deepEqual(quiet, []);
});
