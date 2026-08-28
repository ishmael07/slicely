import { test } from "node:test";
import assert from "node:assert/strict";
import { nasaProvider } from "./nasa";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() is fully open — GitHub Contents API needs no token", () => {
  const a = nasaProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, true);
});

test("search() filters the real 106-folder '3D Printing' catalog listing by query substring, and caches it for an empty-query 'browse'", async (t) => {
  // nasa.ts caches the folder listing in-process for an hour (kind to
  // GitHub's rate limit) — both calls below must therefore only trigger ONE
  // fetch, which this asserts via the call counter.
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls += 1;
    assert.match(url, /api\.github\.com\/repos\/nasa\/NASA-3D-Resources\/contents\/3D%20Printing/);
    // Trimmed real shape, captured live 2026-08-27.
    return jsonResponse([
      { name: "CubeSat", path: "3D Printing/CubeSat", type: "dir" },
      { name: "Curiosity Rover (Detailed)", path: "3D Printing/Curiosity Rover (Detailed)", type: "dir" },
      { name: "Apollo 11 - Landing Site", path: "3D Printing/Apollo 11 - Landing Site", type: "dir" },
      { name: "README.md", path: "3D Printing/README.md", type: "file" }, // not a dir — must be excluded
    ]);
  });

  const results = await nasaProvider.search("cube", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "CubeSat");
  assert.equal(results[0].source, "nasa");
  assert.equal(results[0].downloadable, true);

  const browseAll = await nasaProvider.search("", 10);
  assert.equal(browseAll.length, 3); // the 3 dirs, README.md still excluded
  assert.equal(calls, 1); // second call served from the in-process cache
});

test("listFiles() keeps only mesh files and carries the real download_url straight through (verified live shape)", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /contents\/3D%20Printing%2FCubeSat/);
    // Real shape captured live from
    // .../contents/3D%20Printing/CubeSat on 2026-08-27.
    return jsonResponse([
      {
        name: "CubeSat bottom.stl",
        path: "3D Printing/CubeSat/CubeSat bottom.stl",
        type: "file",
        size: 237684,
        download_url: "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Printing/CubeSat/CubeSat%20bottom.stl",
      },
      {
        name: "CubeSat.png",
        path: "3D Printing/CubeSat/CubeSat.png",
        type: "file",
        size: 1528601,
        download_url: "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Printing/CubeSat/CubeSat.png",
      },
    ]);
  });

  const files = await nasaProvider.listFiles!("CubeSat");
  assert.equal(files.length, 1); // .png excluded
  assert.equal(files[0].ext, ".stl");
  assert.equal(
    files[0].url,
    "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Printing/CubeSat/CubeSat%20bottom.stl",
  );
});

test("fileUrl() picks the .stl as preferred among several mesh files", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse([
      { name: "a.obj", path: "3D Printing/X/a.obj", type: "file", download_url: "https://raw/a.obj" },
      { name: "b.stl", path: "3D Printing/X/b.stl", type: "file", download_url: "https://raw/b.stl" },
    ]),
  );
  const resolved = await nasaProvider.fileUrl!("X");
  assert.equal(resolved.url, "https://raw/b.stl");
});
