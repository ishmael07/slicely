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
import {
  createThumbsRouter,
  THUMB_MAX_CONCURRENT,
  THUMB_QUEUE_TIMEOUT_MS,
  THUMB_TIMEOUT_MS,
  type ThumbsRouterOptions,
} from "./routes/thumbs";
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

// ── Concurrency ─────────────────────────────────────────────────────────────
//
// A twelve-result search paints twelve cards, so the browser opens twelve of
// these AT ONCE, each allowed 15 s upstream (above). Unbounded, all twelve race
// that ceiling together — twelve sockets and up to twelve MAX_BYTES buffers —
// and one slow CDN in the set drags the whole grid to the timeout. The proxy
// therefore runs at most THUMB_MAX_CONCURRENT fetches and queues the rest.

/** A router with its own server, plus a fake upstream that holds each request
 *  open for `holdMs` and records the high-water mark of concurrent fetches. */
async function withSlowUpstream(
  opts: { holdMs: number } & Omit<ThumbsRouterOptions, "fetch">,
  fn: (base: string, peak: () => number) => Promise<void>,
): Promise<void> {
  let inFlight = 0;
  let peak = 0;
  const fakeFetch: typeof guardedFetch = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((r) => setTimeout(r, opts.holdMs));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    } finally {
      inFlight--;
    }
  };
  const app = express();
  app.use("/api", createThumbsRouter({ ...opts, fetch: fakeFetch }));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => peak);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("six concurrent thumbnails never put more than four fetches in flight", async () => {
  assert.equal(THUMB_MAX_CONCURRENT, 4);
  // The queue wait must stay BELOW the fetch ceiling: a request that has already
  // waited 10 s must not then be granted another 15 s upstream.
  assert.ok(THUMB_QUEUE_TIMEOUT_MS < THUMB_TIMEOUT_MS, "the queue wait is shorter than the fetch timeout");

  await withSlowUpstream({ holdMs: 60 }, async (base, peak) => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://media.printables.com/p${i}.jpg`);
    const results = await Promise.all(urls.map((u) => thumb(base, u)));
    for (const res of results) {
      assert.equal(res.status, 200, "every one of the six still gets its image");
      assert.equal(res.headers.get("content-type"), "image/jpeg");
    }
    assert.ok(peak() <= THUMB_MAX_CONCURRENT, `peak concurrency was ${peak()}, expected <= ${THUMB_MAX_CONCURRENT}`);
    assert.ok(peak() > 1, `the bound must not have serialized everything (peak ${peak()})`);
  });
});

test("a thumbnail that waits too long for a slot is 503 busy, not 502", async () => {
  // 502 says "this image is dead" and the card draws its placeholder for good;
  // `busy` says "the server is full", which is true and retryable. Driven with a
  // one-slot, 20 ms queue so the real 10 s wait isn't spent in the test suite.
  await withSlowUpstream({ holdMs: 400, maxConcurrent: 1, queueTimeoutMs: 20 }, async (base) => {
    const first = thumb(base, "https://media.printables.com/slow.jpg");
    // Behind it in the queue, and it will time out there.
    const second = await thumb(base, "https://media.printables.com/queued.jpg");
    assert.equal(second.status, 503);
    const body = (await second.json()) as { error?: string; code?: string };
    assert.equal(body.code, "busy");
    assert.ok(body.error && body.error.length > 0, "a wire error always carries a sentence");

    // The holder still finishes, and its permit goes back.
    assert.equal((await first).status, 200);
    const after = await thumb(base, "https://media.printables.com/later.jpg");
    assert.equal(after.status, 200, "the slot must be reusable once the queue drains");
  });
});
