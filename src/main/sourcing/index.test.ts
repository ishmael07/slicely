import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchModels,
  resolveUrl,
  listFiles,
  downloadModel,
  sourceAvailability,
} from "./index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("sourceAvailability reports one entry per registered provider, each with the required fields", () => {
  const all = sourceAvailability();
  assert.equal(all.length, 11);
  for (const a of all) {
    assert.equal(typeof a.id, "string");
    assert.equal(typeof a.label, "string");
    assert.equal(typeof a.searchable, "boolean");
    assert.equal(typeof a.downloadable, "boolean");
  }
  assert.ok(all.some((a) => a.id === "nih3d"));
});

test("resolveUrl on the façade passes straight through to the resolver (SSRF guard fires with no network access)", async () => {
  const result = await resolveUrl("http://127.0.0.1/secret.stl");
  assert.equal(result.kind, "unsupported");
  assert.match(result.message, /private\/loopback/);
});

test("listFiles throws a clear error for a source that doesn't support file listing", async () => {
  await assert.rejects(() => listFiles("thangs", "whatever"), /doesn't support file listing/);
});

test("downloadModel refuses a source that can't be downloaded in-app", async () => {
  await assert.rejects(() => downloadModel("makerworld", "12345"), /can't be downloaded in-app/);
});

// ── the required regression: one dead provider must never blank the whole
// federated search ─────────────────────────────────────────────────────
test("searchModels: one provider throwing/timing out never blanks results from a healthy one", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("makerworld.com")) {
      throw new Error("simulated network failure — MakerWorld is down");
    }
    if (url.includes("api.printables.com")) {
      return jsonResponse({
        data: {
          searchPrints2: {
            items: [
              {
                id: "118657",
                name: "Calibration Cube",
                slug: "calibration-cube",
                image: null,
                user: { publicUsername: "ItsMaxify" },
                license: { name: "CC BY 4.0" },
                premium: false,
                downloadCount: 72407,
              },
            ],
          },
        },
      });
    }
    throw new Error(`unexpected fetch in this test: ${url}`);
  });

  const outcome = await searchModels("calibration cube", { sources: ["makerworld", "printables"] });

  assert.equal(outcome.sources.length, 2);
  const mw = outcome.sources.find((s) => s.id === "makerworld")!;
  const pr = outcome.sources.find((s) => s.id === "printables")!;
  assert.equal(mw.ok, false);
  assert.match(mw.error ?? "", /simulated network failure/);
  assert.equal(pr.ok, true);
  assert.equal(pr.count, 1);

  // The dead source must not have blanked the live one's results.
  assert.ok(outcome.results.length > 0);
  assert.ok(outcome.results.some((r) => r.source === "printables" && r.id === "118657"));
});

test("searchModels restricted to a single dead source reports it as failed with an empty (not thrown) result set", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("MakerWorld unreachable");
  });
  const outcome = await searchModels("anything", { sources: ["makerworld"] });
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.sources.length, 1);
  assert.equal(outcome.sources[0].ok, false);
});

// ── end-to-end façade integration: downloadModel across the real
// provider -> download.ts pipeline, onto a real temp directory ──────────
test("downloadModel downloads every mesh file for a model by default (multi-part), writing real files to disk", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("3d.nih.gov/api/entries/")) {
      return jsonResponse({
        entryId: 999,
        threedpxId: "3DPX-000999",
        submissions: [
          {
            submissionId: 1,
            submissionStatus: "Published",
            metadata: { title: "Test Entry", license: "CC0" },
            outputFiles: [
              { fileId: 1, name: "part-a.stl", s3Location: "https://s3.example.test/part-a.stl", fileSize: 100 },
              { fileId: 2, name: "part-b.stl", s3Location: "https://s3.example.test/part-b.stl", fileSize: 100 },
            ],
          },
        ],
      });
    }
    if (url.startsWith("https://s3.example.test/")) {
      const stl = Buffer.alloc(84); // triangleCount 0 -> valid-shaped binary STL
      return new Response(new Uint8Array(stl), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const destDir = await mkdtemp(join(tmpdir(), "slicely-index-dl-"));
  try {
    const result = await downloadModel("nih3d", "999", { destDir });
    assert.equal(result.parts?.length, 2);
    const names = (result.parts ?? []).map((p) => p.fileName).sort();
    assert.deepEqual(names, ["part-a.stl", "part-b.stl"]);
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});
