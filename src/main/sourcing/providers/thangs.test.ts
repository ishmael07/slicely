import { test } from "node:test";
import assert from "node:assert/strict";
import { thangsProvider } from "./thangs";

test("availability() is search-only and marked best-effort", () => {
  const a = thangsProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, false);
});

test("search() parses model links out of a (hypothetical, since the real site blocks bots) results page", async (t) => {
  const html = `
    <html><body>
      <div class="results">
        <a href="/3d-model/abc123-cool-bracket" title="Cool Bracket">
          <img src="https://cdn.thangs.com/thumb1.jpg" />
        </a>
        <a href="/3d-model/def456-another-part" title="Another Part">
          <img src="https://cdn.thangs.com/thumb2.jpg" />
        </a>
      </div>
    </body></html>`;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /thangs\.com\/search\/bracket/);
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  });

  const results = await thangsProvider.search("bracket", 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "abc123-cool-bracket");
  assert.equal(results[0].title, "Cool Bracket");
  assert.equal(results[0].webUrl, "https://thangs.com/3d-model/abc123-cool-bracket");
  assert.equal(results[0].downloadable, false);
});

test("search() throws a clear, honest error when Cloudflare's bot-check page is returned (verified live 2026-08-27)", async (t) => {
  const challenge = `<html><head><title>Just a moment...</title></head><body>Checking your browser...</body></html>`;
  t.mock.method(globalThis, "fetch", async () => new Response(challenge, { status: 403, headers: { "content-type": "text/html" } }));
  await assert.rejects(() => thangsProvider.search("bracket", 10), /blocked this request/);
});
