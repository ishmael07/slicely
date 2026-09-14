// Tests for the thumbnail proxy.
//
// It exists because several sources set Cross-Origin-Resource-Policy, so the
// browser refuses to paint their images in our page and every card falls back
// to a grey placeholder. But a proxy that fetches arbitrary URLs is an SSRF
// tool, so the guards are the important part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createThumbsRouter, THUMB_TIMEOUT_MS } from "./routes/thumbs";
import type { guardedFetch } from "../main/sourcing/net";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use("/api", createThumbsRouter());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const thumb = (base: string, url: string): Promise<Response> =>
  fetch(`${base}/api/thumb?url=${encodeURIComponent(url)}`);

test("a host that merely CONTAINS an allowed name is rejected", async () => {
  await withServer(async (base) => {
    // The classic allowlist bug: substring matching would pass this.
    for (const bad of [
      "https://evil-thingiverse.com/x.jpg",
      "https://thingiverse.com.attacker.net/x.jpg",
      "https://notmakerworld.com/x.jpg",
    ]) {
      const res = await thumb(base, bad);
      assert.equal(res.status, 403, `should have rejected ${bad}`);
    }
  });
});

test("a genuine subdomain of an allowed host is accepted for fetching", async () => {
  await withServer(async (base) => {
    // Reaches the fetch stage and fails there (no network in tests), which is
    // 502 — the point is that it was not rejected as 403.
    const res = await thumb(base, "https://cdn.thingiverse.com/x.jpg");
    assert.notEqual(res.status, 403);
  });
});

test("internal addresses are refused, so this cannot be used to probe the host", async () => {
  await withServer(async (base) => {
    for (const bad of [
      "http://127.0.0.1/healthz",
      "http://localhost/admin",
      "http://169.254.169.254/latest/meta-data/",
      "https://192.168.1.1/",
    ]) {
      const res = await thumb(base, bad);
      assert.equal(res.status, 403, `should have rejected ${bad}`);
    }
  });
});

test("plain http is refused even for an allowed host", async () => {
  await withServer(async (base) => {
    const res = await thumb(base, "http://cdn.thingiverse.com/x.jpg");
    assert.equal(res.status, 403);
  });
});

test("a missing or unparseable url is a bad request, not a crash", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/thumb`)).status, 400);
    assert.equal((await thumb(base, "not a url")).status, 400);
  });
});

test("the proxy waits the 15 s a full-resolution listing photo needs", async () => {
  // 8 s cut off real Printables/MyMiniFactory images (measured at 8.7 s and
  // 10.1 s for 2.6 MB / 3.4 MB), so three to five cards in a twelve-result
  // search rendered as placeholders. The constant AND its use are checked: a
  // timeout that is written down but not passed to the fetch is no timeout.
  assert.equal(THUMB_TIMEOUT_MS, 15_000);

  const seen: Array<{ url: string; timeout: number | undefined }> = [];
  const fakeFetch: typeof guardedFetch = async (url, _init, timeoutMs) => {
    seen.push({ url, timeout: timeoutMs });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  };

  const app = express();
  app.use("/api", createThumbsRouter({ fetch: fakeFetch }));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const resp = await thumb(`http://127.0.0.1:${port}`, "https://media.printables.com/big.jpg");
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "image/jpeg");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].timeout, THUMB_TIMEOUT_MS);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
