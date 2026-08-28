import { test } from "node:test";
import assert from "node:assert/strict";
import { makerworldProvider } from "./makerworld";

test("availability() reports search-only with a login-required blockedReason", () => {
  const a = makerworldProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, false);
  assert.match(a.blockedReason ?? "", /Bambu account/);
});

test("search() maps a realistic search-service payload, always downloadable:false", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /makerworld\.com\/api\/v1\/search-service\/select\/design/);
    assert.match(url, /query=candle%20holder/);
    return new Response(
      JSON.stringify({
        total: 10000,
        hits: [
          {
            id: 3217578,
            title: "Oogie Boogie Candle Holder",
            slug: "oogie-boogie-candle-holder",
            cover: "https://makerworld.bblmw.com/cover.jpg",
            designCreator: { name: "December roots" },
            license: "Standard Digital File License",
            likeCount: 449,
            downloadCount: 251,
            printCount: 21,
            commentCount: 29,
            createTime: "2026-08-25T12:06:47Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const results = await makerworldProvider.search("candle holder", 10);
  assert.equal(results.length, 1);
  const [m] = results;
  assert.equal(m.id, "3217578");
  assert.equal(m.source, "makerworld");
  assert.equal(m.creator, "December roots");
  assert.equal(m.webUrl, "https://makerworld.com/en/models/3217578");
  assert.equal(m.downloadable, false);
  assert.equal(m.signals?.likes, 449);
  assert.equal(m.signals?.makes, 21);
});

test("search() surfaces a non-ok response as a thrown error (so the federated search can report it, not swallow it)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  await assert.rejects(() => makerworldProvider.search("x", 5), /MakerWorld search failed \(503\)/);
});
