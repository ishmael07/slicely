import { test } from "node:test";
import assert from "node:assert/strict";
import { smithsonianProvider } from "./smithsonian";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() works even without a real key (falls back to DEMO_KEY) but flags it", () => {
  delete process.env.SMITHSONIAN_API_KEY;
  const a = smithsonianProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, true);
  assert.match(a.blockedReason ?? "", /DEMO_KEY/);
});

test("search() uses the verified endpoint/param shape and the 3D-content facet filter", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /api\.si\.edu\/openaccess\/api\/v1\.0\/search/);
    const decodedQuery = decodeURIComponent(url).replace(/\+/g, " ");
    assert.match(decodedQuery, /online_media_type:"3D Models"/);
    assert.match(url, /api_key=/);
    // Envelope shape confirmed live 2026-08-27:
    // { status, responseCode, response: { rows, rowCount } }
    return jsonResponse({
      status: 200,
      responseCode: 1,
      response: {
        rowCount: 1,
        rows: [
          {
            id: "edanmdm:nmnhpaleobiology_1234",
            title: "Tyrannosaurus Rex Skull",
            unitCode: "NMNHPALEOBIOLOGY",
            content: {
              descriptiveNonRepeating: {
                title: { content: "Tyrannosaurus Rex Skull" },
                record_link: "https://www.si.edu/object/nmnhpaleobiology_1234",
                online_media: {
                  mediaCount: 1,
                  media: [
                    {
                      type: "3d",
                      thumbnail: "https://si-3d.s3.amazonaws.com/thumb.jpg",
                      resources: [
                        { url: "https://si-3d.s3.amazonaws.com/trex-skull.stl", label: "STL", fileSize: "10485760" },
                        { url: "https://si-3d.s3.amazonaws.com/trex-skull.usdz", label: "USDZ" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });
  });

  const results = await smithsonianProvider.search("trex skull", 10);
  assert.equal(results.length, 1);
  const [m] = results;
  assert.equal(m.id, "edanmdm:nmnhpaleobiology_1234");
  assert.equal(m.title, "Tyrannosaurus Rex Skull");
  assert.equal(m.webUrl, "https://www.si.edu/object/nmnhpaleobiology_1234");
  assert.equal(m.downloadable, true); // an .stl resource was found
  assert.equal(m.license, "CC0 (Smithsonian Open Access)");
});

test("search() degrades to downloadable:false when a record's media has no recognizable mesh resource (honest gap, not a guess)", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({
      response: {
        rows: [
          {
            id: "edanmdm:x",
            title: "Something With Only Images",
            content: {
              descriptiveNonRepeating: {
                online_media: { media: [{ type: "images", resources: [{ url: "https://example.com/photo.jpg" }] }] },
              },
            },
          },
        ],
      },
    }),
  );
  const results = await smithsonianProvider.search("something", 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].downloadable, false);
});

test("listFiles()/fileUrl() find the STL resource via /content/{id} and prefer it", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /\/content\/edanmdm(:|%3A)nmnhpaleobiology_1234/);
    return jsonResponse({
      response: {
        id: "edanmdm:nmnhpaleobiology_1234",
        content: {
          descriptiveNonRepeating: {
            online_media: {
              media: [
                {
                  resources: [
                    { url: "https://si-3d.s3.amazonaws.com/trex-skull.obj", label: "OBJ" },
                    { url: "https://si-3d.s3.amazonaws.com/trex-skull.stl", label: "STL" },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });

  const files = await smithsonianProvider.listFiles!("edanmdm:nmnhpaleobiology_1234");
  assert.equal(files.length, 2);

  const resolved = await smithsonianProvider.fileUrl!("edanmdm:nmnhpaleobiology_1234");
  assert.equal(resolved.url, "https://si-3d.s3.amazonaws.com/trex-skull.stl"); // .stl preferred over .obj
});
