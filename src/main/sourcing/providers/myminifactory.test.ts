import { test } from "node:test";
import assert from "node:assert/strict";
import { myminifactoryProvider } from "./myminifactory";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const result = fn();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return undefined;
}

test("availability() without credentials points at the free API key signup", () => {
  withEnv({ MYMINIFACTORY_API_KEY: undefined, MYMINIFACTORY_ACCESS_TOKEN: undefined }, () => {
    const a = myminifactoryProvider.availability();
    assert.equal(a.searchable, false);
    assert.equal(a.downloadable, false);
  });
});

test("availability() with only an API key: searchable, but NOT downloadable (per the verified spec correction)", () => {
  withEnv({ MYMINIFACTORY_API_KEY: "test-key", MYMINIFACTORY_ACCESS_TOKEN: undefined }, () => {
    const a = myminifactoryProvider.availability();
    assert.equal(a.searchable, true);
    assert.equal(a.downloadable, false);
    assert.equal(a.status, "search_only");
    assert.match(a.operatorHint ?? "", /reduced preview mesh/);
    assert.match(a.blockedReason ?? "", /reduced preview mesh/);
  });
});

test("availability() with an OAuth access token: fully downloadable", () => {
  withEnv({ MYMINIFACTORY_API_KEY: undefined, MYMINIFACTORY_ACCESS_TOKEN: "oauth-token" }, () => {
    const a = myminifactoryProvider.availability();
    assert.equal(a.downloadable, true);
  });
});

test("search() maps the documented Object[] shape and uses the `key` query param", async (t) => {
  await withEnv({ MYMINIFACTORY_API_KEY: "test-key", MYMINIFACTORY_ACCESS_TOKEN: undefined }, async () => {
    t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.match(url, /myminifactory\.com\/api\/v2\/search/);
      assert.match(url, /key=test-key/);
      assert.match(url, /q=dragon/);
      return new Response(
        JSON.stringify({
          total_count: 1,
          items: [
            {
              id: 12345,
              url: "https://www.myminifactory.com/object/3d-print-dragon-12345",
              name: "Low Poly Dragon",
              description: "A cool dragon",
              designer: { username: "creator1" },
              images: [{ thumbnail_url: "https://cdn.myminifactory.com/thumb.jpg" }],
              files: [{ id: 1, filename: "dragon.stl" }],
              license: "CC BY-NC",
              likes: 42,
              published_at: "2020-01-01",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const results = await myminifactoryProvider.search("dragon", 10);
    assert.equal(results.length, 1);
    const [m] = results;
    assert.equal(m.id, "12345");
    assert.equal(m.creator, "creator1");
    assert.equal(m.webUrl, "https://www.myminifactory.com/object/3d-print-dragon-12345");
    // Per the verified spec correction: API-key-only search results are NOT
    // downloadable (only an OAuth user token gets a real download_url).
    assert.equal(m.downloadable, false);
    assert.equal(m.signals?.fileCount, 1);
  });
});

test("search() returns [] with no credentials at all, without calling fetch", async (t) => {
  await withEnv({ MYMINIFACTORY_API_KEY: undefined, MYMINIFACTORY_ACCESS_TOKEN: undefined }, async () => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not fetch with no credentials");
    });
    const results = await myminifactoryProvider.search("x", 5);
    assert.deepEqual(results, []);
  });
});

test("fileUrl() refuses to resolve a download without an OAuth access token", async () => {
  await withEnv({ MYMINIFACTORY_API_KEY: "test-key", MYMINIFACTORY_ACCESS_TOKEN: undefined }, async () => {
    await assert.rejects(() => myminifactoryProvider.fileUrl!("12345"), /OAuth-authenticated user/);
  });
});

test("fileUrl() with an OAuth token uses the Bearer header (not `key=`) and returns download_url", async (t) => {
  await withEnv({ MYMINIFACTORY_API_KEY: undefined, MYMINIFACTORY_ACCESS_TOKEN: "oauth-token" }, async () => {
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.doesNotMatch(url, /key=/);
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer oauth-token");
      return new Response(
        JSON.stringify([{ id: 1, filename: "dragon.stl", download_url: "https://cdn.myminifactory.com/real/dragon.stl" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const resolved = await myminifactoryProvider.fileUrl!("12345");
    assert.equal(resolved.url, "https://cdn.myminifactory.com/real/dragon.stl");
  });
});
