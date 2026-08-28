import { test } from "node:test";
import assert from "node:assert/strict";
// Mockable the same way as net.test.ts's dns import — `import ... =
// require(...)` avoids TS's getter-based namespace-import wrapper, which
// `t.mock.method` can't intercept. Needed here because config.ts's
// getConfig() is memoized and this repo's real .env sets a real
// THINGIVERSE_APP_TOKEN — mocking getConfig lets both the "configured" and
// "not configured" cases be tested deterministically regardless of that.
import config = require("../../config");
import { thingiverseProvider } from "./thingiverse";

function fakeConfig(token: string) {
  return {
    anthropicApiKey: "",
    thingiverseToken: token,
    model: "",
    effort: "",
    prusaSlicerPath: "",
    prusaConfigIni: "",
    workdir: "/tmp",
    downloadsDir: "/tmp/downloads",
    slicesDir: "/tmp/slices",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() reflects whether THINGIVERSE_APP_TOKEN is configured", (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig(""));
  assert.equal(thingiverseProvider.availability().searchable, false);
  assert.equal(thingiverseProvider.availability().downloadable, false);

  t.mock.method(config, "getConfig", () => fakeConfig("real-token"));
  assert.equal(thingiverseProvider.availability().searchable, true);
  assert.equal(thingiverseProvider.availability().downloadable, true);
});

test("search() maps a realistic Thingiverse search payload to SourcedModel", async (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig("test-token"));
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /api\.thingiverse\.com\/search\/calibration%20cube/);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-token");
    return jsonResponse({
      hits: [
        {
          id: 118657,
          name: "Calibration Cube",
          public_url: "https://www.thingiverse.com/thing:118657",
          preview_image: "https://cdn.thingiverse.com/118657.jpg",
          creator: { name: "ItsMaxify" },
          license: "Creative Commons - Attribution",
          like_count: 500,
          download_count: 40000,
          collect_count: 1200,
        },
      ],
    });
  });

  const results = await thingiverseProvider.search("calibration cube", 10);
  assert.equal(results.length, 1);
  const [m] = results;
  assert.equal(m.id, "118657");
  assert.equal(m.source, "thingiverse");
  assert.equal(m.title, "Calibration Cube");
  assert.equal(m.creator, "ItsMaxify");
  assert.equal(m.webUrl, "https://www.thingiverse.com/thing:118657");
  assert.equal(m.downloadable, true);
  assert.equal(m.signals?.downloads, 40000);
  assert.equal(m.signals?.likes, 500);
});

test("search() returns [] (not an error) with no token configured, without ever calling fetch", async (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig(""));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call fetch with no token");
  });
  const results = await thingiverseProvider.search("anything", 5);
  assert.deepEqual(results, []);
});

test("search() returns [] on Thingiverse's documented 404-on-zero-matches behavior", async (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig("test-token"));
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  const results = await thingiverseProvider.search("zzzznomatches", 5);
  assert.deepEqual(results, []);
});

test("listFiles() keeps only mesh/archive files and reports the right extension", async (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig("test-token"));
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse([
      { id: 1, name: "part.stl", size: 12345, download_url: "https://cdn/part.stl" },
      { id: 2, name: "instructions.pdf", size: 999, download_url: "https://cdn/instructions.pdf" },
      { id: 3, name: "parts.zip", size: 55555, download_url: "https://cdn/parts.zip" },
    ]),
  );

  const files = await thingiverseProvider.listFiles!("118657");
  assert.equal(files.length, 2); // pdf excluded
  assert.deepEqual(
    files.map((f) => f.ext).sort(),
    [".stl", ".zip"],
  );
});

test("fileUrl() picks the requested file id and returns its signed download URL + auth header", async (t) => {
  t.mock.method(config, "getConfig", () => fakeConfig("test-token"));
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse([
      { id: 1, name: "part.stl", size: 100, download_url: "https://cdn/part-1.stl" },
      { id: 2, name: "part-b.stl", size: 200, download_url: "https://cdn/part-2.stl" },
    ]),
  );

  const resolved = await thingiverseProvider.fileUrl!("118657", "2");
  assert.equal(resolved.url, "https://cdn/part-2.stl");
  assert.equal(resolved.headers?.Authorization, "Bearer test-token");
  assert.equal(resolved.fileName, "part-b.stl");
});
