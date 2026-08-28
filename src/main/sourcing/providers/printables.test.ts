import { test } from "node:test";
import assert from "node:assert/strict";
import { printablesProvider } from "./printables";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("availability() is always true — search and the common download path are unauthenticated", () => {
  const a = printablesProvider.availability();
  assert.equal(a.searchable, true);
  assert.equal(a.downloadable, true);
});

test("search() maps a realistic searchPrints2 payload, including the premium->not-downloadable flag", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.printables.com/graphql/");
    const body = JSON.parse(init.body as string);
    assert.equal(body.variables.q, "calibration cube");
    return jsonResponse({
      data: {
        searchPrints2: {
          items: [
            {
              id: "118657",
              name: "Calibration Cube",
              slug: "calibration-cube",
              image: { filePath: "media/prints/118657/images/x/cube.png" },
              user: { publicUsername: "ItsMaxify" },
              license: { name: "CC BY 4.0" },
              premium: false,
              likesCount: 300,
              downloadCount: 72407,
              datePublished: "2019-01-01T00:00:00Z",
            },
            {
              id: "999",
              name: "Store Exclusive Model",
              slug: "store-exclusive-model",
              image: null,
              user: { publicUsername: "designer" },
              license: { name: "Standard Digital File License" },
              premium: true,
            },
          ],
          totalCount: 2,
        },
      },
    });
  });

  const results = await printablesProvider.search("calibration cube", 10);
  assert.equal(results.length, 2);

  const free = results.find((r) => r.id === "118657")!;
  assert.equal(free.title, "Calibration Cube");
  assert.equal(free.webUrl, "https://www.printables.com/model/118657-calibration-cube");
  assert.equal(free.thumbnail, "https://media.printables.com/media/prints/118657/images/x/cube.png");
  assert.equal(free.downloadable, true);
  assert.equal(free.signals?.downloads, 72407);

  const premium = results.find((r) => r.id === "999")!;
  assert.equal(premium.downloadable, false);
  assert.equal(premium.printability?.flags.restrictiveLicence, true);
});

test("search() throws a descriptive error on a GraphQL error response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ errors: [{ message: "query cost exceeded" }] }),
  );
  await assert.rejects(() => printablesProvider.search("x", 5), /query cost exceeded/);
});

test("listFiles() excludes gcode and reports stl/other files", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({
      data: {
        model: {
          id: "118657",
          stls: [{ id: "487902", name: "Calibration Cube.3mf", fileSize: 4583, folder: "" }, { id: "487903", name: "Calibration Cube.stl", fileSize: 12684, folder: "" }],
          gcodes: [{ id: "1", name: "cube_0.2mm.gcode", fileSize: 99999, folder: "" }],
          otherFiles: [],
        },
      },
    }),
  );

  const files = await printablesProvider.listFiles!("118657");
  assert.equal(files.length, 2);
  assert.ok(!files.some((f) => f.ext === ".gcode"));
});

test("fileUrl() calls GetDownloadLink unauthenticated and returns the live CDN link (matches the verified live behavior)", async (t) => {
  let sawMutation = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.query.includes("ModelFiles")) {
      return jsonResponse({
        data: {
          model: {
            id: "118657",
            stls: [{ id: "487903", name: "Calibration Cube.stl", fileSize: 12684, folder: "" }],
            gcodes: [],
            otherFiles: [],
          },
        },
      });
    }
    if (body.query.includes("GetDownloadLink")) {
      sawMutation = true;
      assert.equal(init.headers && (init.headers as Record<string, string>).Cookie, undefined);
      return jsonResponse({
        data: {
          getDownloadLink: {
            ok: true,
            errors: null,
            output: {
              link: "https://files.printables.com/media/prints/118657/stls/x/calibration-cube.stl",
              count: 1,
              ttl: 86400,
            },
          },
        },
      });
    }
    throw new Error(`unexpected query: ${url}`);
  });

  const resolved = await printablesProvider.fileUrl!("118657");
  assert.equal(sawMutation, true);
  assert.equal(resolved.url, "https://files.printables.com/media/prints/118657/stls/x/calibration-cube.stl");
});

test("fileUrl() retries with a session cookie when PRINTABLES_TOKEN is set and the unauthenticated attempt fails", async (t) => {
  process.env.PRINTABLES_TOKEN = "fake-session-id";
  t.after(() => {
    delete process.env.PRINTABLES_TOKEN;
  });

  let attempt = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.query.includes("ModelFiles")) {
      return jsonResponse({ data: { model: { id: "1", stls: [{ id: "f1", name: "part.stl", fileSize: 1 }], gcodes: [], otherFiles: [] } } });
    }
    attempt += 1;
    const headers = init.headers as Record<string, string> | undefined;
    if (attempt === 1) {
      assert.equal(headers?.Cookie, undefined);
      return jsonResponse({ data: { getDownloadLink: { ok: false, errors: [{ messages: ["Login required"] }] } } });
    }
    assert.equal(headers?.Cookie, "sessionid=fake-session-id");
    return jsonResponse({ data: { getDownloadLink: { ok: true, output: { link: "https://files.printables.com/gated/part.stl" } } } });
  });

  const resolved = await printablesProvider.fileUrl!("1");
  assert.equal(resolved.url, "https://files.printables.com/gated/part.stl");
  assert.equal(attempt, 2);
});
