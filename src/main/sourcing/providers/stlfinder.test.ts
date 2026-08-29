import { test } from "node:test";
import assert from "node:assert/strict";
import { stlfinderProvider } from "./stlfinder";

test("availability() is OFF by default — this source is bot-blocked in practice", () => {
  // Waiting on these engines added ~8s to every search and returned nothing,
  // so they are opt-in. See net.ts's scrapersEnabled().
  const prev = process.env.SLICELY_ENABLE_SCRAPERS;
  delete process.env.SLICELY_ENABLE_SCRAPERS;
  try {
    const a = stlfinderProvider.availability();
    assert.equal(a.searchable, false);
    assert.equal(a.downloadable, false);
    assert.match(a.blockedReason ?? "", /SLICELY_ENABLE_SCRAPERS/);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_ENABLE_SCRAPERS;
    else process.env.SLICELY_ENABLE_SCRAPERS = prev;
  }
});

test("availability() reports searchable again when explicitly enabled", () => {
  const prev = process.env.SLICELY_ENABLE_SCRAPERS;
  process.env.SLICELY_ENABLE_SCRAPERS = "1";
  try {
    assert.equal(stlfinderProvider.availability().searchable, true);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_ENABLE_SCRAPERS;
    else process.env.SLICELY_ENABLE_SCRAPERS = prev;
  }
});

test("search() parses result cards out of a (hypothetical) results page", async (t) => {
  const html = `
    <html><body>
      <article><a href="/model/999-cool-vase" title="Cool Vase"><img src="thumb.jpg"/></a></article>
    </body></html>`;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /stlfinder\.com\/search\?q=vase/);
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  });

  const results = await stlfinderProvider.search("vase", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Cool Vase");
  assert.equal(results[0].downloadable, false);
});

test("search() throws a clear error when Cloudflare blocks the request outright (verified live 2026-08-27 — even robots.txt is blocked)", async (t) => {
  const challenge = `<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>`;
  t.mock.method(globalThis, "fetch", async () => new Response(challenge, { status: 403, headers: { "content-type": "text/html" } }));
  await assert.rejects(() => stlfinderProvider.search("vase", 10), /blocked this request/);
});
