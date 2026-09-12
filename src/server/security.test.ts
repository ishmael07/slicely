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
import { rateLimiter } from "./security";
import { createPrintersRouter } from "./routes/printers";
import type { PrintersApi } from "./facades";

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("rateLimiter answers 429 once a key's burst budget is spent", async () => {
  const app = express();
  // capacity 2, zero refill: exactly two requests ever succeed from one key.
  app.use(rateLimiter({ capacity: 2, refillPerSec: 0 }));
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
