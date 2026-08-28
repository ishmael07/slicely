import { test } from "node:test";
import assert from "node:assert/strict";
import { githubProvider, listMeshFilesInGithubUrl } from "./github";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() requires GITHUB_TOKEN — GitHub's code-search 401s with none at all (verified live)", () => {
  withEnv({ GITHUB_TOKEN: undefined }, () => {
    const a = githubProvider.availability();
    assert.equal(a.searchable, false);
    assert.equal(a.downloadable, false);
  });
  withEnv({ GITHUB_TOKEN: "ghp_test" }, () => {
    const a = githubProvider.availability();
    assert.equal(a.searchable, true);
  });
});

test("search() returns [] with no token, without calling fetch", async (t) => {
  await withEnv({ GITHUB_TOKEN: undefined }, async () => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not call fetch with no GITHUB_TOKEN");
    });
    const results = await githubProvider.search("bracket", 5);
    assert.deepEqual(results, []);
  });
});

test("search() finds repos, then lists their meshes (code search cannot do this)", async (t) => {
  await withEnv({ GITHUB_TOKEN: "ghp_test" }, async () => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url.includes("/search/repositories")) {
        assert.equal(headers.Authorization, "Bearer ghp_test");
        // The query is biased toward printable projects, since a bare word
        // like "dragon" is mostly software on GitHub.
        assert.match(decodeURIComponent(url), /3d print/);
        return jsonResponse({
          total_count: 1,
          items: [
            {
              full_name: "tobbelobb/hangprinter",
              description: "An RepRap printer",
              default_branch: "main",
              stargazers_count: 412,
              html_url: "https://github.com/tobbelobb/hangprinter",
              owner: { login: "tobbelobb" },
            },
          ],
        });
      }

      if (url.includes("/git/trees/")) {
        assert.match(url, /recursive=1/);
        return jsonResponse({
          tree: [
            { path: "README.md", type: "blob", size: 10 },
            { path: "stl/landing_brackets.stl", type: "blob", size: 2048 },
            { path: "stl/nozzle.stl", type: "blob", size: 1024 },
          ],
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    const results = await githubProvider.search("bracket", 5);

    assert.ok(
      !calls.some((u) => u.includes("/search/code")),
      "code search is never used: it matches file CONTENT, and a binary STL has none",
    );
    assert.equal(results.length, 2, "only the mesh files, not the README");
    const [m] = results;
    assert.equal(m.source, "github");
    assert.equal(m.creator, "tobbelobb");
    assert.match(m.title, /landing_brackets\.stl/);
    assert.match(m.title, /tobbelobb\/hangprinter/);
    assert.equal(m.downloadable, true);
    assert.equal(m.signals?.likes, 412, "repo stars carry over as a popularity signal");

    // The id round-trips to a raw URL pinned at the ref we listed.
    const files = await githubProvider.listFiles!(m.id);
    assert.equal(files.length, 1);
    assert.match(
      files[0].url!,
      /raw\.githubusercontent\.com\/tobbelobb\/hangprinter\/.+\/stl\/landing_brackets\.stl/,
    );
    const resolved = await githubProvider.fileUrl!(m.id);
    assert.equal(resolved.url, files[0].url);
  });
});

test("listMeshFilesInGithubUrl resolves a direct blob URL without any API call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("a blob URL must not need a network call");
  });
  const files = await listMeshFilesInGithubUrl(
    "https://github.com/someorg/somerepo/blob/main/parts/bracket.stl",
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "bracket.stl");
  assert.equal(
    files[0].url,
    "https://raw.githubusercontent.com/someorg/somerepo/main/parts/bracket.stl",
  );
});

test("listMeshFilesInGithubUrl enumerates a tree URL via the recursive git-trees API (verified live shape)", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /repos\/nasa\/NASA-3D-Resources\/git\/trees\/master\?recursive=1/);
    // Trimmed real shape captured live 2026-08-27.
    return jsonResponse({
      truncated: false,
      tree: [
        { path: "3D Models/1999 RQ36 asteroid", type: "tree", sha: "aa6" },
        { path: "3D Models/1999 RQ36 asteroid/1999 RQ36 asteroid.glb", type: "blob", size: 329596, sha: "f79" },
        { path: "3D Printing/CubeSat/CubeSat bottom.stl", type: "blob", size: 237684, sha: "abc" },
      ],
    });
  });

  const files = await listMeshFilesInGithubUrl(
    "https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Printing",
  );
  assert.equal(files.length, 1);
  assert.match(files[0].name, /CubeSat bottom\.stl/);
});

test("listMeshFilesInGithubUrl resolves a bare repo-root URL's HEAD to the real default branch first", async (t) => {
  let sawRepoMetaCall = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (/api\.github\.com\/repos\/owner\/repo$/.test(url)) {
      sawRepoMetaCall = true;
      return jsonResponse({ default_branch: "main" });
    }
    assert.match(url, /git\/trees\/main\?recursive=1/);
    return jsonResponse({ tree: [{ path: "model.stl", type: "blob", size: 100 }] });
  });

  const files = await listMeshFilesInGithubUrl("https://github.com/owner/repo");
  assert.equal(sawRepoMetaCall, true);
  assert.equal(files.length, 1);
});
