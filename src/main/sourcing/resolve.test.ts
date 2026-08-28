import { test } from "node:test";
import assert from "node:assert/strict";
// See net.test.ts for why this uses `import ... = require(...)` rather than
// `import * as dns from` — only the former is mockable with `t.mock.method`.
import dns = require("node:dns/promises");
import { resolveUrl } from "./resolve";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockPublicDns(t: { mock: { method: Function } }) {
  // Every resolve.test.ts URL uses a real-looking hostname (needed for the
  // marketplace/git-host regex matches); this keeps the SSRF guard's
  // best-effort DNS re-check hermetic instead of hitting real DNS.
  t.mock.method(dns, "lookup", async () => ({ address: "93.184.216.34", family: 4 as const }));
}

function binaryStl(triangleCount: number): Buffer {
  const buf = Buffer.alloc(84 + triangleCount * 50);
  buf.writeUInt32LE(triangleCount, 80);
  return buf;
}

test("resolveUrl classifies a direct .stl link as direct-mesh (confirmed by sniffing real bytes)", async (t) => {
  const stl = binaryStl(1);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(stl), { status: 200 }));

  const result = await resolveUrl("http://93.184.216.34/parts/model.stl");
  assert.equal(result.kind, "direct-mesh");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].ext, ".stl");
});

test("resolveUrl classifies a .zip link as archive without downloading it", async (t) => {
  // No fetch stub needed/registered — archive classification is pure
  // extension routing and must not touch the network.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("resolveUrl should not fetch a .zip just to classify it");
  });

  const result = await resolveUrl("http://93.184.216.34/parts/model.zip");
  assert.equal(result.kind, "archive");
  assert.equal(result.files[0].ext, ".zip");
});

test("resolveUrl classifies a known marketplace URL as model-page and lists its files", async (t) => {
  mockPublicDns(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /api\.thingiverse\.com\/things\/123456\/files/);
    return jsonResponse([
      { id: 1, name: "part.stl", size: 1000, download_url: "https://cdn.example.com/part.stl" },
    ]);
  });

  const result = await resolveUrl("https://www.thingiverse.com/thing:123456");
  assert.equal(result.kind, "model-page");
  assert.equal(result.model?.source, "thingiverse");
  assert.equal(result.model?.id, "123456");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "part.stl");
});

test("resolveUrl classifies a GitHub blob URL as git-repo", async (t) => {
  mockPublicDns(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("a direct blob URL should not need an extra API call");
  });

  const result = await resolveUrl("https://github.com/someorg/somerepo/blob/main/parts/bracket.stl");
  assert.equal(result.kind, "git-repo");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "bracket.stl");
  assert.match(result.files[0].url ?? "", /raw\.githubusercontent\.com\/someorg\/somerepo\/main\/parts\/bracket\.stl/);
});

test("resolveUrl classifies an arbitrary page with mesh links as scraped-page", async (t) => {
  mockPublicDns(t);
  const html = `
    <html><body>
      <a href="/files/cool-bracket.stl">Download STL</a>
      <a href="/files/readme.txt">Readme</a>
    </body></html>`;
  t.mock.method(globalThis, "fetch", async () => new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  }));

  const result = await resolveUrl("https://example.com/downloads");
  assert.equal(result.kind, "scraped-page");
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].url ?? "", /cool-bracket\.stl$/);
});

test("resolveUrl reports unsupported (with a clear message) for a page with no downloadable links", async (t) => {
  mockPublicDns(t);
  const html = `<html><head><title>My Blog</title></head><body><p>just words</p></body></html>`;
  t.mock.method(globalThis, "fetch", async () => new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  }));

  const result = await resolveUrl("https://example.com/blog-post");
  assert.equal(result.kind, "unsupported");
  assert.match(result.message, /No downloadable mesh or archive links/);
});

test("resolveUrl reports unsupported with an explanatory message for a private/loopback URL (SSRF guard)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must never reach fetch for an SSRF-blocked URL");
  });

  const result = await resolveUrl("http://127.0.0.1:8080/secret.stl");
  assert.equal(result.kind, "unsupported");
  assert.match(result.message, /private\/loopback/);
});

test("resolveUrl reports unsupported for a bot-protection challenge page", async (t) => {
  mockPublicDns(t);
  const challenge = "<html><head><title>Just a moment...</title></head><body>Checking your browser...</body></html>";
  t.mock.method(globalThis, "fetch", async () => new Response(challenge, {
    status: 403,
    headers: { "content-type": "text/html" },
  }));

  const result = await resolveUrl("https://example.com/protected-search");
  assert.equal(result.kind, "unsupported");
});
