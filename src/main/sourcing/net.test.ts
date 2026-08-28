import { test } from "node:test";
import assert from "node:assert/strict";
// Deliberately `import ... = require(...)` (not `import * as dns from`) so
// this resolves to the exact same raw CommonJS module object net.ts's own
// compiled `require("node:dns/promises")` uses — TS's `import * as`
// namespace-import emits a getter-based rebinding wrapper that
// `t.mock.method` can't intercept (it only replaces plain data properties).
import dns = require("node:dns/promises");
import { isPrivateHost, assertPublicHttpUrl, clamp } from "./net";

test("isPrivateHost rejects loopback, RFC1918, link-local, and localhost forms", () => {
  const shouldBePrivate = [
    "127.0.0.1",
    "127.5.5.5",
    "10.0.0.5",
    "10.255.255.255",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.1.1",
    "localhost",
    "foo.localhost",
    "printer.local",
    "::1",
    "fe80::1",
    "fc00::1",
  ];
  for (const h of shouldBePrivate) {
    assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
  }
});

test("isPrivateHost accepts real public hosts/IPs", () => {
  const shouldBePublic = ["example.com", "api.github.com", "8.8.8.8", "172.15.0.1", "172.32.0.1"];
  for (const h of shouldBePublic) {
    assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
  }
});

test("assertPublicHttpUrl rejects private IP-literal URLs without any DNS lookup", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/admin"), /private\/loopback/);
  await assert.rejects(() => assertPublicHttpUrl("http://192.168.1.5:8080/x"), /private\/loopback/);
  await assert.rejects(() => assertPublicHttpUrl("http://localhost:3000/"), /private\/loopback/);
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/x"), /private\/loopback/);
});

test("assertPublicHttpUrl rejects non-http(s) schemes", async () => {
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /Unsupported URL scheme/);
  await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/x"), /Unsupported URL scheme/);
});

test("assertPublicHttpUrl rejects garbage input", async () => {
  await assert.rejects(() => assertPublicHttpUrl("not a url"), /Not a valid URL/);
});

test("assertPublicHttpUrl rejects a hostname that DNS-resolves to a private address", async (t) => {
  t.mock.method(dns, "lookup", async () => ({ address: "127.0.0.1", family: 4 }));
  await assert.rejects(
    () => assertPublicHttpUrl("http://evil-rebind.example.test/x"),
    /resolves to a private address/,
  );
});

test("assertPublicHttpUrl allows a hostname that DNS-resolves to a public address", async (t) => {
  t.mock.method(dns, "lookup", async () => ({ address: "93.184.216.34", family: 4 }));
  const url = await assertPublicHttpUrl("http://example.test/model.stl");
  assert.equal(url.hostname, "example.test");
});

test("assertPublicHttpUrl does not block on a DNS lookup failure (lets the real fetch fail later)", async (t) => {
  t.mock.method(dns, "lookup", async () => {
    throw new Error("ENOTFOUND");
  });
  const url = await assertPublicHttpUrl("http://does-not-resolve.example.test/x");
  assert.equal(url.hostname, "does-not-resolve.example.test");
});

test("clamp bounds a number into [lo, hi]", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-5, 1, 10), 1);
  assert.equal(clamp(50, 1, 10), 10);
});
