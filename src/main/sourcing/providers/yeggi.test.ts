import { test } from "node:test";
import assert from "node:assert/strict";
import { yeggiProvider } from "./yeggi";

test("availability() is OFF by default — this source is bot-blocked in practice", () => {
  // Waiting on these engines added ~8s to every search and returned nothing,
  // so they are opt-in. See net.ts's scrapersEnabled().
  const prev = process.env.SLICELY_ENABLE_SCRAPERS;
  delete process.env.SLICELY_ENABLE_SCRAPERS;
  try {
    const a = yeggiProvider.availability();
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
    assert.equal(yeggiProvider.availability().searchable, true);
  } finally {
    if (prev === undefined) delete process.env.SLICELY_ENABLE_SCRAPERS;
    else process.env.SLICELY_ENABLE_SCRAPERS = prev;
  }
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
