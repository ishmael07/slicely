// ─────────────────────────────────────────────────────────────────────────────
// account-credit-event.test.ts — applyCreditEvent's fallback when the store
// thinks nobody is signed in.
//
// `applyCreditEvent` is fed by the `credit` frame at the end of a metered chat
// turn. The server only sends that frame to somebody it is actually billing, so
// if this tab's `account()` store disagrees — a stale boot fetch, a session
// that outlived a page it never told — the frame is still news, not noise. The
// fix under test: instead of silently discarding it, ask the server who is
// signed in (`refreshAccount()` → `GET /api/me`) and adopt that answer.
//
// Runs in Node, no DOM: `account.ts` touches the DOM only inside functions that
// build or query specific elements, none of which this test calls.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { account, onAccountChange, resetSession, setAccount } from "./api.js";
import { applyCreditEvent } from "./account.js";

interface Recorded {
  url: string;
}

function stubFetch(reply: (url: string) => Promise<Response>): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    return reply(url);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("a credit frame while the store thinks nobody is signed in asks the server, instead of being dropped", async () => {
  resetSession();
  setAccount({ signedIn: false });

  // Resolved when the store actually lands the signed-in answer — not just when
  // the /api/me fetch is issued, since setAccount lags it by a couple of
  // microtask hops through withSession/readBody.
  let resolveSettled: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
  onAccountChange((me) => {
    if (me.signedIn) resolveSettled?.();
  });

  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/api/config") return json({ mode: "hosted", hasKey: false, accountsEnabled: true });
    if (url === "/api/me") {
      return json({
        signedIn: true,
        account: {
          email: "jane@example.com",
          initial: "J",
          balanceMicros: 100000,
          balanceLabel: "$0.10",
          grantedMicros: 500000,
          grantedLabel: "$0.50",
          chatsToday: 3,
          chatsPerDay: 40,
          exhausted: false,
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    // The frame this test is about: a balance update for an account the store
    // does not believe exists.
    applyCreditEvent({ balanceLabel: "$0.37", balanceMicros: 370000 });

    // refreshAccount() actually asked and the answer landed — race a timeout so
    // a regression (the frame silently dropped) fails fast instead of hanging.
    await Promise.race([
      settled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("account never refreshed")), 2000)),
    ]);

    assert.ok(
      calls.some((c) => c.url === "/api/me"),
      "applyCreditEvent must refresh from the server when nobody was believed signed in",
    );
    const me = account();
    assert.equal(me.signedIn, true);
    assert.equal(me.account?.email, "jane@example.com");
    // The frame's own numbers are NOT applied on top of a store that had no
    // account to update — the server's answer is authoritative here, not a
    // patch onto a guess.
    assert.equal(me.account?.balanceLabel, "$0.10");
  } finally {
    restore();
    resetSession();
  }
});

test("a credit frame while somebody IS signed in still just updates the balance in place (no refetch)", async () => {
  resetSession();
  setAccount({
    signedIn: true,
    account: {
      email: "jane@example.com",
      initial: "J",
      balanceMicros: 420000,
      balanceLabel: "$0.42",
      grantedMicros: 500000,
      grantedLabel: "$0.50",
      chatsToday: 6,
      chatsPerDay: 40,
      exhausted: false,
    },
  });

  const { calls, restore } = stubFetch(async (url) => {
    throw new Error(`no fetch expected, got: ${url}`);
  });

  try {
    applyCreditEvent({ balanceLabel: "$0.37", balanceMicros: 370000 });
    assert.equal(calls.length, 0, "an account already on record is updated locally, not refetched");
    assert.equal(account().account?.balanceLabel, "$0.37");
  } finally {
    restore();
    resetSession();
  }
});
