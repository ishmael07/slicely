// Tests for the static allow-list (Task D8), driven with real HTTP requests
// against the real app — because what is being tested is precisely what a
// stranger's `curl` can reach, and a unit test of the table would have agreed
// with itself while `express.static` happily kept serving the directory.
//
// Hermetic: an ephemeral port, a temp-dir session store, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./index";
import { SessionStore } from "./session";
import express from "express";
import { webStatic } from "./static";

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

    const css = await fetch(`${base}/app.css`);
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

test("the stylesheet the legal pages ask for is the one that styles them", async () => {
  await withServer(async (base) => {
    // `site/terms.html` links a RELATIVE `styles.css`, so a browser on `/terms`
    // asks this server for `/styles.css`. That used to be the APP shell's
    // stylesheet, which has no `.legal` rules at all — the legal text rendered
    // as unstyled black-on-white prose. The two stylesheets now have separate
    // URLs, and the relative one has to be the site's.
    const site = await fetch(`${base}/styles.css`);
    assert.equal(site.status, 200);
    assert.match(site.headers.get("content-type") ?? "", /text\/css/);
    const siteCss = await site.text();
    assert.match(siteCss, /\.legal\b/, "/styles.css must be the site CSS, which has the .legal rules");

    // And the app shell's own stylesheet is still served, at the URL the shell
    // actually links.
    assert.match(await (await fetch(`${base}/app.css`)).text(), /./);
    assert.match(
      await (await fetch(`${base}/`)).text(),
      /href="\/app\.css"/,
      "the shell must link /app.css, not /styles.css",
    );
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
    for (const path of ["/", "/app.css", "/web/app.js"]) {
      const resp = await fetch(`${base}${path}`);
      assert.match(
        resp.headers.get("cache-control") ?? "",
        /no-cache/,
        `${path} must be revalidated — its filename is not content-hashed`,
      );
    }
  });
});

test("a checkout under a DOTTED ancestor still serves every URL", async () => {
  // `res.sendFile(abs, { dotfiles: "deny" })` with no `root` makes `send` apply
  // the dotfile test to the WHOLE absolute path — every segment of it, including
  // the ones above the repo. So a checkout at `~/.local/share/slicely` (which is
  // exactly where an unpacked release lands) 404'd every single URL: the deny
  // fired on `.local`, a directory this server never named. The fix is to name
  // the file RELATIVE to `root`, so the rule only ever sees the part of the path
  // the allow-list chose.
  //
  // Built as a fake repo root rather than by moving the real one: what is under
  // test is the path computation, and it only needs files to exist.
  const tmp = mkdtempSync(join(tmpdir(), "slicely-dotted-"));
  const root = join(tmp, ".local", "share", "slicely");
  mkdirSync(join(root, "src", "web"), { recursive: true });
  mkdirSync(join(root, "site"), { recursive: true });
  mkdirSync(join(root, "dist-web", "web"), { recursive: true });
  writeFileSync(join(root, "src", "web", "index.html"), "<html><title>Slicely</title></html>");
  writeFileSync(join(root, "src", "web", "styles.css"), "body{color:red}");
  writeFileSync(join(root, "site", "styles.css"), ".legal{}");
  writeFileSync(join(root, "site", "favicon.svg"), "<svg/>");
  writeFileSync(join(root, "site", "terms.html"), "<html>terms</html>");
  writeFileSync(join(root, "site", "privacy.html"), "<html>privacy</html>");
  writeFileSync(join(root, "dist-web", "web", "app.js"), "export {};");

  const app = express();
  app.use(webStatic(root));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const path of [
      "/",
      "/index.html",
      "/app.css",
      "/styles.css",
      "/favicon.svg",
      "/terms",
      "/privacy",
      "/web/app.js",
    ]) {
      const resp = await fetch(`${base}${path}`);
      assert.equal(resp.status, 200, `${path} must be served from a dotted checkout`);
    }
    // The dotfile refusal is still ON for anything the table could name badly,
    // and the allow-list still refuses everything it does not name.
    assert.equal((await fetch(`${base}/web/.hidden.js`)).status, 404);
    assert.equal((await fetch(`${base}/web/app.js.map`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  }
});
