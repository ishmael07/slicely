import { test } from "node:test";
import assert from "node:assert/strict";
import { nih3dProvider } from "./nih3d";

// Trimmed-down but structurally faithful version of a REAL response captured
// live 2026-08-27 from https://3d.nih.gov/api/entries/21858 (entry
// 3DPX-021858, "Mechanisms Behind Celiac Disease").
function realisticEntry() {
  return {
    entryId: 21858,
    threedpxId: "3DPX-021858",
    category: "Biomacromolecules",
    keywords: ["celiac", "autoimmune"],
    submissions: [
      {
        submissionId: 29574,
        submissionStatus: "Published",
        metadata: {
          title: "Mechanisms Behind Celiac Disease",
          license: "CC-BY",
          description: "<p>In celiac disease...</p>",
        },
        inputFiles: [],
        outputFiles: [
          {
            fileId: 764015,
            s3Location: "https://persist-3d-media.s3.amazonaws.com/764015/1s9v_glutenpep_hladq2_surface_NIH3D.stl",
            name: "1s9v_glutenpep_hladq2_surface_NIH3D.stl",
            fileSize: 32184084,
            fileType: "Output",
            fileFormat: "STL",
          },
          {
            fileId: 764017,
            s3Location: "https://persist-3d-media.s3.amazonaws.com/764017/1s9v_glutenpep_hladq2_surface_NIH3D.glb",
            name: "1s9v_glutenpep_hladq2_surface_NIH3D.glb",
            fileSize: 12917164,
            fileType: "Output",
            fileFormat: "GLB",
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() is always fully open — no auth", () => {
  const a = nih3dProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, true);
  assert.equal(a.blockedReason, undefined);
});

test("search() resolves an exact entry when the query is a 3DPX id (its real 'search' shortcut)", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /3d\.nih\.gov\/api\/entries\/3DPX-021858/i);
    return jsonResponse(realisticEntry());
  });

  const results = await nih3dProvider.search("3DPX-021858", 5);
  assert.equal(results.length, 1);
  const [m] = results;
  assert.equal(m.id, "21858");
  assert.equal(m.source, "nih3d");
  assert.equal(m.title, "Mechanisms Behind Celiac Disease");
  assert.equal(m.license, "CC-BY");
  assert.equal(m.webUrl, "https://3d.nih.gov/entries/3DPX-021858");
  assert.equal(m.downloadable, true);
  assert.equal(m.signals?.fileCount, 1); // only the .stl counts as a mesh; .glb doesn't
});

test("search() also resolves a bare numeric id and a full 3d.nih.gov entry URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(realisticEntry()));
  const byId = await nih3dProvider.search("21858", 5);
  assert.equal(byId.length, 1);
  const byUrl = await nih3dProvider.search("https://3d.nih.gov/entries/3DPX-021858", 5);
  assert.equal(byUrl.length, 1);
});

test("search() returns [] for ordinary free-text (the honest documented gap — no search endpoint was found)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call the network for a non-id query");
  });
  const results = await nih3dProvider.search("heart valve model", 5);
  assert.deepEqual(results, []);
});

test("listFiles() keeps only the mesh-extension outputs (drops .glb) and prefers .stl", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(realisticEntry()));
  const files = await nih3dProvider.listFiles!("21858");
  assert.equal(files.length, 1);
  assert.equal(files[0].ext, ".stl");
  assert.equal(files[0].url, "https://persist-3d-media.s3.amazonaws.com/764015/1s9v_glutenpep_hladq2_surface_NIH3D.stl");
  assert.equal(files[0].preferred, true);
});

test("fileUrl() returns the entry's open S3 URL directly (no auth headers needed)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(realisticEntry()));
  const resolved = await nih3dProvider.fileUrl!("21858");
  assert.equal(resolved.url, "https://persist-3d-media.s3.amazonaws.com/764015/1s9v_glutenpep_hladq2_surface_NIH3D.stl");
  assert.equal(resolved.headers, undefined);
});

test("listFiles() throws a clear error for an unknown entry (404 from the API)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  await assert.rejects(() => nih3dProvider.listFiles!("99999999"), /not found/);
});
