// Tests for the static allow-list (Task D8), driven with real HTTP requests
// against the real app — because what is being tested is precisely what a
// stranger's `curl` can reach, and a unit test of the table would have agreed
// with itself while `express.static` happily kept serving the directory.
//
// Hermetic: an ephemeral port, a temp-dir session store, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./index";
import { SessionStore } from "./session";

async function withServer(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "slicely-static-"));
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const server: Server = createServer(createApp({ sessionStore: store }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A request sent with the path EXACTLY as written — `fetch()` normalises
 *  `..` segments away before they leave the client, which would quietly turn a
 *  traversal test into a test of something else. */
function rawGet(base: string, target: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "GET", path: target },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the app shell, its stylesheet and its modules are served", async () => {
  await withServer(async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /<title>Slicely<\/title>/);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const js = await fetch(`${base}/web/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const icon = await fetch(`${base}/favicon.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);
  });
});

test("the legal pages answer as HTML at their linked paths", async () => {
  await withServer(async (base) => {
    for (const path of ["/terms", "/privacy", "/terms.html", "/privacy.html"]) {
      const resp = await fetch(`${base}${path}`);
      assert.equal(resp.status, 200, `${path} should be served`);
      assert.match(resp.headers.get("content-type") ?? "", /text\/html/, `${path} content type`);
      assert.match(await resp.text(), /<html/i, `${path} should be a page`);
    }
  });
});

test("sourcemaps, TypeScript sources and dotfiles are not published", async () => {
  await withServer(async (base) => {
    // The sourcemap re-publishes every original source, so it is the first
    // thing an allow-list has to refuse.
    assert.equal((await fetch(`${base}/web/app.js.map`)).status, 404);
    // src/web is the SOURCE directory — express.static used to serve it whole.
    assert.equal((await fetch(`${base}/app.ts`)).status, 404);
    assert.equal((await fetch(`${base}/api.ts`)).status, 404);
    assert.equal((await fetch(`${base}/web/app.ts`)).status, 404);
    // A dotfile, and a directory listing.
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/web/.env`)).status, 404);
    assert.equal((await fetch(`${base}/web/`)).status, 404);
    assert.equal((await fetch(`${base}/web`)).status, 404);
  });
});

test("a path outside the allow-list cannot be reached, traversal included", async () => {
  await withServer(async (base) => {
    // Sent raw, un-normalised, exactly as a hostile client would.
    for (const target of [
      "/web/../package.json",
      "/web/..%2fpackage.json",
      "/web/%2e%2e/package.json",
      "/../package.json",
      "/package.json",
      "/.session-secret",
      "/sessions/whoever/secrets.json",
      "/web/sub/nested.js",
    ]) {
      const { status, body } = await rawGet(base, target);
      assert.equal(status, 404, `${target} answered ${status}`);
      assert.ok(!body.includes("\"dependencies\""), `${target} leaked package.json`);
    }
  });
});

test("a static path answers GET and HEAD only", async () => {
  await withServer(async (base) => {
    const head = await fetch(`${base}/styles.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    // A write to a file is not a thing this server does; it must not be
    // answered as if it had worked.
    const post = await fetch(`${base}/styles.css`, { method: "POST" });
    assert.equal(post.status, 404);
  });
});

test("the shell and its assets are revalidated, so a redeploy is not cached away", async () => {
  await withServer(async (base) => {
    for (const path of ["/", "/styles.css", "/web/app.js"]) {
      const resp = await fetch(`${base}${path}`);
      assert.match(
        resp.headers.get("cache-control") ?? "",
        /no-cache/,
        `${path} must be revalidated — its filename is not content-hashed`,
      );
    }
  });
});
