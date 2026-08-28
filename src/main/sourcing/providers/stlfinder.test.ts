import { test } from "node:test";
import assert from "node:assert/strict";
import { stlfinderProvider } from "./stlfinder";

test("availability() is search-only and notes STLfinder's Cloudflare edge block", () => {
  const a = stlfinderProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, false);
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
