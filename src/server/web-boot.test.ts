// Tests for the browser client's BOOT ORDER (src/web/api.ts).
//
// The client is browser ESM, but tsconfig.json also compiles it to CommonJS
// under dist/web, so the one module that owns every HTTP call can be driven
// directly here with a stubbed `fetch` — which is the only way to assert the
// thing that actually went wrong in the K1 verification: not what any single
// request does, but the ORDER they leave the page in.
//
// What used to happen: every module fetched what it needed as soon as it
// loaded, so seven to twelve cookieless requests left in the same tick and the
// server minted a workspace for each one. The cookie the browser kept was the
// last one, so the other six-to-eleven workspaces were orphaned, and anything
// done during those first seconds (attaching a model, most importantly) was
// filed under a session the page then abandoned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  codeMessage,
  del,
  errorMessage,
  getJson,
  postForm,
  postJson,
  rateLimitedCopy,
  ready,
  resetSession,
} from "../web/api";

interface Recorded {
  url: string;
  method: string;
}

/**
 * Install a `fetch` stub that records every call and answers from `reply`.
 *
 * The config call's answer is held back behind a promise the test resolves by
 * hand, because that is the whole question here: what does the client do in the
 * window between asking for a session and being given one?
 */
function stubFetch(reply: (url: string, method: string) => Promise<Response>): {
  calls: Recorded[];
  restore: () => void;
} {
  const calls: Recorded[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    return reply(url, method);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("every call waits for ONE GET /api/config, so a page load mints one workspace", async () => {
  resetSession();
  let releaseConfig: (() => void) | undefined;
  const configGate = new Promise<void>((resolve) => (releaseConfig = resolve));

  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/api/config") {
      await configGate; // the server hasn't answered yet
      return json({ mode: "hosted", hasKey: false });
    }
    return json({ ok: true });
  });

  try {
    // Exactly the boot fan-out app.ts starts: several independent modules each
    // asking for what they need, all in one tick.
    const inFlight = Promise.all([
      getJson("/api/status"),
      getJson("/api/settings"),
      getJson("/api/printers"),
      getJson("/api/sources"),
      postJson("/api/chats", {}),
      // A file dropped on the page while it is still booting — the case that
      // used to attach the model to a workspace the browser then abandoned.
      postForm("/api/upload", new FormData()),
      del("/api/key"),
    ]);

    // Nothing has been allowed out except the boot call itself.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      calls.map((c) => c.url),
      ["/api/config"],
      `only the boot call may go out before the cookie exists, got ${calls.map((c) => c.url).join(", ")}`,
    );

    releaseConfig!();
    await inFlight;

    // And afterwards: one config call, ever, with the seven others behind it.
    assert.equal(calls.filter((c) => c.url === "/api/config").length, 1, "one boot call, not one per module");
    assert.equal(calls.length, 8);
  } finally {
    restore();
    resetSession();
  }
});

test("the config call is shared, not repeated, however many callers ask for it", async () => {
  resetSession();
  const { calls, restore } = stubFetch(async () => json({ mode: "hosted" }));
  try {
    await Promise.all([ready(), ready(), getJson("/api/status"), ready()]);
    assert.equal(calls.filter((c) => c.url === "/api/config").length, 1);
  } finally {
    restore();
    resetSession();
  }
});

test("a 429 on boot is the server's answer, not an unreachable server", async () => {
  // D-3: the mint cap's 429 was reported to the user as "Can't reach the Slicely
  // server. Check your connection." — telling them to debug their own network
  // over something that clears up by waiting. The distinction the banner needs
  // is exactly this: an ApiError means the server answered and said why.
  resetSession();
  const { restore } = stubFetch(async () =>
    json({ error: "Too many new sessions from this address. Try again later.", code: "rate_limited" }, 429),
  );
  try {
    const err = await getJson("/api/status").then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError, "a 429 must arrive as an ApiError, not a network failure");
    assert.equal((err as ApiError).status, 429);
    assert.equal((err as ApiError).code, "rate_limited");
    assert.equal(errorMessage(err), "Slow down a little — try again in a few seconds");
  } finally {
    restore();
    resetSession();
  }
});

test("a network failure on boot is NOT an ApiError, so the offline banner still has its case", async () => {
  resetSession();
  const { restore } = stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const err = await getJson("/api/status").then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof ApiError), "fetch throwing is an outage, not an answer");
  } finally {
    restore();
    resetSession();
  }
});

test("a failed boot is retried by the next call rather than poisoning the page", async () => {
  resetSession();
  let attempt = 0;
  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/api/config") {
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return json({ mode: "hosted" });
    }
    return json({ ok: true });
  });
  try {
    await assert.rejects(() => getJson("/api/status"));
    // The next attempt (the 15 s status poll, or the user pressing something)
    // boots again — a page that came up during a blip must not stay broken.
    await getJson("/api/status");
    assert.equal(calls.filter((c) => c.url === "/api/config").length, 2);
  } finally {
    restore();
    resetSession();
  }
});

test("a session the server has forgotten is re-booted once, transparently", async () => {
  // The session table is in memory, so a server restart makes every live cookie
  // name nothing. The honest recovery is to boot again and repeat the request,
  // not to tell the user to reload a page that would work.
  resetSession();
  let statusCalls = 0;
  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/api/config") return json({ mode: "hosted" });
    statusCalls += 1;
    if (statusCalls === 1) {
      return json({ error: "This page hasn't started a session yet.", code: "no_session" }, 401);
    }
    return json({ installed: true });
  });
  try {
    const status = (await getJson("/api/status")) as { installed: boolean };
    assert.equal(status.installed, true);
    assert.equal(calls.filter((c) => c.url === "/api/config").length, 2, "it booted again");
    assert.equal(statusCalls, 2, "and repeated the request once");
  } finally {
    restore();
    resetSession();
  }
});

// ── The `rate_limited` sentence follows the server's own Retry-After ──────────

test("rate_limited copy says minutes when the server asked for minutes", () => {
  // ONE wire code, TWO very different waits. The per-session tier limiter
  // refills in a second or two; the per-IP session-mint cap (20 an hour) sends
  // `Retry-After: 180`, and that is the 429 a first-time visitor actually hits.
  // "Try again in a few seconds" there reads as a broken site and invites a
  // reload loop that cannot succeed, so the sentence follows the header.
  assert.equal(rateLimitedCopy(180), "Slow down a little — try again in about 3 minutes");
  assert.equal(rateLimitedCopy(3600), "Slow down a little — try again in about 60 minutes");
  // Rounded, not floored: 100s is closer to 2 minutes than to 1.
  assert.equal(rateLimitedCopy(100), "Slow down a little — try again in about 2 minutes");
  assert.equal(rateLimitedCopy(90), "Slow down a little — try again in about 2 minutes");
  assert.equal(rateLimitedCopy(61), "Slow down a little — try again in about 1 minute");

  // A minute or less keeps the short line: "about 1 minute" would be a worse way
  // of saying "a few seconds".
  const short = "Slow down a little — try again in a few seconds";
  assert.equal(rateLimitedCopy(10), short);
  assert.equal(rateLimitedCopy(60), short);
  assert.equal(rateLimitedCopy(0), short);
  assert.equal(rateLimitedCopy(undefined), short);
  assert.equal(rateLimitedCopy(Number.NaN), short);

  // And the same sentence is what the UI reaches through its own two doors.
  assert.equal(codeMessage("rate_limited", 180), rateLimitedCopy(180));
  assert.equal(codeMessage("rate_limited"), short);
  assert.equal(codeMessage("no_session", 180), "Reload Slicely to start a new session.");
});

test("a 429's Retry-After reaches the copy through ApiError", () => {
  // The header has to survive the trip from `fetch` to the banner. Same-origin,
  // so no `Access-Control-Expose-Headers` is involved — corsGuard refuses a
  // cross-origin request outright, and that header only governs those.
  resetSession();
  const { restore } = stubFetch(async () =>
    new Response(JSON.stringify({ error: "Too many new sessions from this address.", code: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "Retry-After": "180" },
    }),
  );
  try {
    return getJson("/api/config").then(
      () => assert.fail("a 429 should reject"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 429);
        assert.equal(err.code, "rate_limited");
        assert.equal(err.retryAfterSec, 180);
        assert.equal(errorMessage(err), "Slow down a little — try again in about 3 minutes");
      },
    );
  } finally {
    restore();
    resetSession();
  }
});
