// Tests for security.ts's rate limiter and the SLICELY_MODE LAN guard.
// The LAN-guard test stubs the printers façade entirely (its discoverPrinters
// throws if called at all) so it proves the guard short-circuits BEFORE ever
// reaching real mDNS/network code — not just that the façade happens to
// return nothing in this environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rateLimiter, TokenBuckets } from "./security";
import { createApp, type CreateAppOptions } from "./index";
import { SessionStore } from "./session";
import { createPrintersRouter } from "./routes/printers";
import type { PrintersApi } from "./facades";
import type { PrinterConnection } from "../shared/printers";

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A real app (so the session middleware, the /api mount order and the tiers
 *  are all exercised as shipped) on a throwaway sessions directory, with the
 *  rate-limit tiers narrowed so a test doesn't have to fire 60 requests. */
function testApp(limits: CreateAppOptions["limits"]): {
  app: express.Express;
  store: SessionStore;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "slicely-ratelimit-"));
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const app = createApp({ sessionStore: store, limits });
  return {
    app,
    store,
    cleanup: () => {
      store.stopSweep();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A syntactically plausible but unsigned cookie — what an attacker who wants
 *  a fresh bucket per request would send. Sent under BOTH spellings of the
 *  cookie name (the hosted `__Host-` prefix and the bare desktop one) so the
 *  test keeps pinning the bug whichever name the server is issuing. */
function forgedCookie(): Record<string, string> {
  const value = `${randomBytes(16).toString("hex")}.${randomBytes(32).toString("hex")}`;
  return { cookie: `slicely_sid=${value}; __Host-slicely_sid=${value}` };
}

test("rateLimiter answers 429 once a key's burst budget is spent", async () => {
  const app = express();
  // capacity 2, zero refill: exactly two requests ever succeed from one key.
  app.use(rateLimiter({ name: "test", capacity: 2, refillPerSec: 0 }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  const { base, close } = await listen(app);
  try {
    const r1 = await fetch(`${base}/ping`);
    const r2 = await fetch(`${base}/ping`);
    const r3 = await fetch(`${base}/ping`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.ok(r3.headers.get("retry-after"), "a 429 should tell the client when to retry");
  } finally {
    await close();
  }
});

function unusedPrinterApi(): PrintersApi {
  const fail = (name: string) => async () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    listPrinters: async () => [],
    getPrinter: fail("getPrinter") as unknown as PrintersApi["getPrinter"],
    addPrinter: fail("addPrinter") as unknown as PrintersApi["addPrinter"],
    updatePrinter: fail("updatePrinter") as unknown as PrintersApi["updatePrinter"],
    removePrinter: async () => undefined,
    testPrinter: fail("testPrinter") as unknown as PrintersApi["testPrinter"],
    allStatuses: async () => [],
    printerStatus: fail("printerStatus") as unknown as PrintersApi["printerStatus"],
    sendToPrinter: fail("sendToPrinter") as unknown as PrintersApi["sendToPrinter"],
    controlPrinter: fail("controlPrinter") as unknown as PrintersApi["controlPrinter"],
    discoverPrinters: async () => {
      throw new Error("discoverPrinters must never be invoked in hosted mode");
    },
    setActivePrinter: async () => undefined,
    setAutoStart: async () => undefined,
    driverLabels: () => [],
  };
}

// ── A rejecting façade call must answer JSON, never crash (fix round 1) ─────
// Every `/printers/:id` route awaited `ownPrinter`'s lookup outside any
// try/catch, and DELETE and the autostart toggle awaited their own write the
// same way. A rejection there (a disk error, a driver bug) became an
// unhandled promise rejection with no process-wide handler to catch it — able
// to take the whole server down over a single failed call. These stand in for
// "the façade rejected" and check the HTTP response, which is what changed:
// before the fix, node's own unhandled-rejection handling means the process
// itself doesn't survive making this same request.

/** A working PrintersApi stub — every method resolves normally, standing in
 *  for the real façade so exactly one method can be overridden to reject. */
function okPrinterApi(overrides: Partial<PrintersApi> = {}): PrintersApi {
  const printer: PrinterConnection = { id: "p1", label: "Test", transport: "octoprint", enabled: true };
  return {
    listPrinters: async () => [printer],
    getPrinter: async (id: string) => (id === printer.id ? printer : undefined),
    addPrinter: async () => ({ printer, test: { ok: true, message: "ok" } }),
    updatePrinter: async () => printer,
    removePrinter: async () => undefined,
    testPrinter: async () => ({ ok: true, message: "ok" }),
    allStatuses: async () => [],
    printerStatus: async () => ({ id: printer.id, state: "idle" as const, observedAt: new Date().toISOString() }),
    sendToPrinter: async () => ({ ok: true, started: false, message: "ok" }),
    controlPrinter: async () => ({ ok: true, started: false, message: "ok" }),
    discoverPrinters: async () => [],
    setActivePrinter: async () => undefined,
    setAutoStart: async () => undefined,
    driverLabels: () => [],
    ...overrides,
  };
}

async function expectJsonErrorNotCrash(app: express.Express, path: string, init?: RequestInit): Promise<void> {
  const { base, close } = await listen(app);
  try {
    const resp = await fetch(`${base}${path}`, init);
    assert.ok(resp.status >= 400, `expected an error status for ${path}, got ${resp.status}`);
    const body = (await resp.json()) as { error?: string };
    assert.ok(body.error, "a JSON error body, not a dropped connection");
  } finally {
    await close();
  }
}

test("a rejecting removePrinter on DELETE answers JSON, not a crash", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createPrintersRouter(
      okPrinterApi({
        removePrinter: async () => {
          throw new Error("disk exploded");
        },
      }),
    ),
  );
  await expectJsonErrorNotCrash(app, "/api/printers/p1", { method: "DELETE" });
});

test("a rejecting setAutoStart on the autostart toggle answers JSON, not a crash", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createPrintersRouter(
      okPrinterApi({
        setAutoStart: async () => {
          throw new Error("disk exploded");
        },
      }),
    ),
  );
  await expectJsonErrorNotCrash(app, "/api/printers/p1/autostart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ armed: true }),
  });
});

test("a rejecting getPrinter lookup answers JSON on a :id route, not a crash", async () => {
  // getPrinter backs ownPrinter, the guard shared by every "/printers/:id"
  // route (PATCH here stands in for all seven).
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createPrintersRouter(
      okPrinterApi({
        getPrinter: async () => {
          throw new Error("registry read failed");
        },
      }),
    ),
  );
  await expectJsonErrorNotCrash(app, "/api/printers/p1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "x" }),
  });
});

test("a rejecting listPrinters on the plain listing answers JSON, not a crash", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createPrintersRouter(
      okPrinterApi({
        listPrinters: async () => {
          throw new Error("disk exploded");
        },
      }),
    ),
  );
  await expectJsonErrorNotCrash(app, "/api/printers");
});

test("SLICELY_MODE=hosted disables LAN discovery without ever calling the façade", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createPrintersRouter(unusedPrinterApi()));
  const { base, close } = await listen(app);
  const prev = process.env.SLICELY_MODE;
  try {
    process.env.SLICELY_MODE = "hosted";
    const resp = await fetch(`${base}/api/printers/discover`);
    const data = (await resp.json()) as { error: string };
    assert.equal(resp.status, 403);
    assert.match(data.error, /disabled/i);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    await close();
  }
});

test("SLICELY_MODE=hosted refuses the folder transport with its own code, façade untouched", async () => {
  // "Save to a folder" on a hosted server means the OPERATOR's disk, which the
  // visitor can neither see nor collect a file from — so it is refused before
  // the façade is asked, and with the code the UI branches on (not the LAN
  // advice, which is nonsense for a transport with no network).
  const app = express();
  app.use(express.json());
  app.use("/api", createPrintersRouter(unusedPrinterApi()));
  const { base, close } = await listen(app);
  const prev = process.env.SLICELY_MODE;
  try {
    process.env.SLICELY_MODE = "hosted";
    const resp = await fetch(`${base}/api/printers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport: "file", label: "Folder", outputDir: "/etc" }),
    });
    assert.equal(resp.status, 403);
    const body = (await resp.json()) as { error: string; code?: string };
    assert.equal(body.code, "forbidden_in_hosted_mode");
    assert.match(body.error, /Mac app/);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    await close();
  }
});

test("SLICELY_MODE=desktop allows LAN discovery through to the façade", async () => {
  const app = express();
  app.use(express.json());
  const stub = unusedPrinterApi();
  // Override just for this test — desktop mode SHOULD reach the façade.
  (stub as { discoverPrinters: PrintersApi["discoverPrinters"] }).discoverPrinters = async () => [];
  app.use("/api", createPrintersRouter(stub));
  const { base, close } = await listen(app);
  const prev = process.env.SLICELY_MODE;
  try {
    process.env.SLICELY_MODE = "desktop";
    const resp = await fetch(`${base}/api/printers/discover`);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), []);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
    await close();
  }
});

// ── The verified-session rate-limit key (spec §2) ────────────────────────────
// The bug these four tests pin down: the limiter used to key on the RAW
// `slicely_sid` cookie string, so anyone could hand themselves an unlimited
// budget by writing a new random cookie value before every request.

test("rotating a FORGED session cookie does not reset the bucket", async () => {
  const { app, cleanup } = testApp({ api: { capacity: 2, refillPerSec: 0 } });
  const { base, close } = await listen(app);
  try {
    const r1 = await fetch(`${base}/api/config`, { headers: forgedCookie() });
    const r2 = await fetch(`${base}/api/config`, { headers: forgedCookie() });
    const r3 = await fetch(`${base}/api/config`, { headers: forgedCookie() });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, "an unverifiable cookie must fall back to the caller's IP bucket");
  } finally {
    await close();
    cleanup();
  }
});

test("X-Forwarded-For is ignored unless SLICELY_TRUST_PROXY=1", async () => {
  const prev = process.env.SLICELY_TRUST_PROXY;
  delete process.env.SLICELY_TRUST_PROXY;
  const { app, cleanup } = testApp({ api: { capacity: 2, refillPerSec: 0 } });
  const { base, close } = await listen(app);
  try {
    const spoof = (n: number) => ({ "x-forwarded-for": `203.0.113.${n}` });
    const r1 = await fetch(`${base}/api/config`, { headers: spoof(1) });
    const r2 = await fetch(`${base}/api/config`, { headers: spoof(2) });
    const r3 = await fetch(`${base}/api/config`, { headers: spoof(3) });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, "a header anyone can set must not choose the bucket");
  } finally {
    await close();
    cleanup();
    if (prev === undefined) delete process.env.SLICELY_TRUST_PROXY;
    else process.env.SLICELY_TRUST_PROXY = prev;
  }
});

test("two genuine sessions from one address get independent buckets", async () => {
  // capacity 2 with no refill: the two cookie-less mint requests spend the
  // shared IP bucket exactly, and each minted session then starts fresh.
  const { app, cleanup } = testApp({ api: { capacity: 2, refillPerSec: 0 } });
  const { base, close } = await listen(app);
  try {
    const mint = async (): Promise<string> => {
      const resp = await fetch(`${base}/api/config`);
      assert.equal(resp.status, 200);
      const raw = resp.headers.get("set-cookie");
      assert.ok(raw, "a cookie-less /api request should mint a session");
      return raw!.split(";")[0];
    };
    const a = await mint();
    const b = await mint();
    assert.notEqual(a, b);

    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: a } })).status, 200);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: a } })).status, 200);
    assert.equal(
      (await fetch(`${base}/api/config`, { headers: { cookie: a } })).status,
      429,
      "session A spends only its own budget",
    );
    assert.equal(
      (await fetch(`${base}/api/config`, { headers: { cookie: b } })).status,
      200,
      "session B must not be starved by session A",
    );
  } finally {
    await close();
    cleanup();
  }
});

test("a 429 carries Retry-After and the rate_limited wire code", async () => {
  // 1 token, refilling at 1 per 10s: the deficit is a full token, so the
  // advertised wait is 10 seconds.
  const { app, cleanup } = testApp({ api: { capacity: 1, refillPerSec: 1 / 10 } });
  const { base, close } = await listen(app);
  try {
    const cookie = forgedCookie();
    assert.equal((await fetch(`${base}/api/config`, { headers: cookie })).status, 200);
    const resp = await fetch(`${base}/api/config`, { headers: cookie });
    assert.equal(resp.status, 429);
    const retryAfter = Number(resp.headers.get("retry-after"));
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, `Retry-After should be >= 1, got ${retryAfter}`);
    const body = (await resp.json()) as { error: string; code: string };
    assert.equal(body.code, "rate_limited");
    assert.match(body.error, /slow down/i);
  } finally {
    await close();
    cleanup();
  }
});

test("the chat and heavy tiers are mounted on their routes, with separate budgets", async () => {
  // One token each, no refill: the second request of a kind is refused, and
  // spending `chat` must not spend `heavy`.
  const { app, cleanup } = testApp({
    api: { capacity: 50 },
    chat: { capacity: 1, refillPerSec: 0 },
    heavy: { capacity: 1, refillPerSec: 0 },
  });
  const { base, close } = await listen(app);
  try {
    const mint = await fetch(`${base}/api/config`);
    const cookie = mint.headers.get("set-cookie")!.split(";")[0];
    const post = async (path: string, body: unknown): Promise<number> => {
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await resp.text(); // never leave a response body unread
      return resp.status;
    };

    // The first of each is answered by the route (any status but 429 — with no
    // key and no model these are rejections, which is fine: the point is that
    // the LIMITER let them through).
    assert.notEqual(await post("/api/chat", { message: "hello" }), 429);
    assert.equal(await post("/api/chat", { message: "hello again" }), 429, "chat tier should be spent");
    assert.notEqual(await post("/api/slice", {}), 429, "the heavy tier has its own budget");
    assert.equal(await post("/api/slice", {}), 429, "heavy tier should be spent");
  } finally {
    await close();
    cleanup();
  }
});

test("a slow-refilling bucket is not reset by being idle — idling never buys tokens", async () => {
  // Two tokens refilling one per hour: shaped like the per-IP session-mint
  // budget, whose full recovery (here two hours) is longer than the 30-minute
  // memory-saving eviction window buckets used to be swept on. Evicting a
  // bucket resets it to FULL, so that window handed an idling caller a free
  // second budget.
  const buckets = new TokenBuckets({ capacity: 2, refillPerSec: 1 / 3600 });
  const t0 = Date.now();
  const minute = 60 * 1000;

  assert.equal(buckets.take("mint:203.0.113.7", t0), undefined);
  assert.equal(buckets.take("mint:203.0.113.7", t0 + 1000), undefined, "both tokens are spendable");

  // 31 minutes later: past the old sweep window, but only half a token has
  // refilled, so this must still be refused.
  const denied = buckets.take("mint:203.0.113.7", t0 + 31 * minute);
  assert.ok(denied !== undefined, "idling past the sweep window must not refill the bucket");
  assert.ok(denied! >= 1);

  // Two hours in, the bucket really has refilled, and is spendable again.
  assert.equal(
    buckets.take("mint:203.0.113.7", t0 + 121 * minute),
    undefined,
    "a genuinely refilled bucket still works",
  );
});
