import { test } from "node:test";
import assert from "node:assert/strict";
import { yeggiProvider } from "./yeggi";

test("availability() is search-only and notes the robots.txt/bot-check split", () => {
  const a = yeggiProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, false);
});

test("search() parses result cards out of a (hypothetical) results page", async (t) => {
  const html = `
    <html><body>
      <a class="item" href="/q/heart/12345/" title="Heart Model">
        <img src="https://cdn.yeggi.com/thumb.jpg" />
      </a>
    </body></html>`;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /www\.yeggi\.com\/q\/heart/);
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  });

  const results = await yeggiProvider.search("heart", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "12345");
  assert.equal(results[0].title, "Heart Model");
  assert.equal(results[0].downloadable, false);
});

test("search() throws a clear error when yeggi's JS bot-check page is returned (its exact live wording, captured 2026-08-27)", async (t) => {
  const challenge = `<html><body>Please wait a moment while we check whether you are human or a bot. You will then be automatically redirected.</body></html>`;
  t.mock.method(globalThis, "fetch", async () => new Response(challenge, { status: 200, headers: { "content-type": "text/html" } }));
  await assert.rejects(() => yeggiProvider.search("heart", 10), /bot-check challenge/);
});
