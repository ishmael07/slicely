import { test } from "node:test";
import assert from "node:assert/strict";
// Deliberately `import ... = require(...)` (not `import * as dns from`) so
// this resolves to the exact same raw CommonJS module object net.ts's own
// compiled `require("node:dns/promises")` uses — TS's `import * as`
// namespace-import emits a getter-based rebinding wrapper that
// `t.mock.method` can't intercept (it only replaces plain data properties).
import dns = require("node:dns/promises");
import { isPrivateHost, isPrivateAddress, assertPublicHttpUrl, guardedFetch, clamp } from "./net";

/** A `lookup` for the injected guard: every test that uses a HOSTNAME passes
 *  one of these, so no test in this file ever touches real DNS. */
function fakeLookup(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host: string) => {
    const found = map[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  };
}

const PUBLIC_ONLY = fakeLookup({ "public.test": ["93.184.216.34"] });

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
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(
    () => assertPublicHttpUrl("http://evil-rebind.example.test/x"),
    /resolves to a private address/,
  );
});

test("assertPublicHttpUrl allows a hostname that DNS-resolves to a public address", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const url = await assertPublicHttpUrl("http://example.test/model.stl");
  assert.equal(url.hostname, "example.test");
});

// ── Task D3 ─────────────────────────────────────────────────────────────────
// Ranges, ports, numeric hosts, a lookup that can't be trusted, and — the one
// that made the rest decorative — redirects.

test("isPrivateAddress covers the ranges an SSRF probe reaches for once RFC1918 is closed", () => {
  for (const ip of [
    "100.64.1.1", // carrier-grade NAT
    "224.0.0.1", // multicast
    "198.18.0.1", // benchmarking
    "192.0.0.1", // IETF protocol assignments
    "192.0.2.7", // documentation
    "240.0.0.1", // reserved
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254", // the cloud metadata service
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:10.0.0.1", // IPv4-mapped IPv6 — the same private address, spelled differently
  ]) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} to be private`);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1"]) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} to be public`);
  }
});

test("assertPublicHttpUrl rejects a hostname whose records are only PARTLY public", async () => {
  // One public A record and one internal one: checking just the first address
  // (what the guard used to do) waves this straight through.
  const lookup = fakeLookup({ "evil.test": ["93.184.216.34", "10.0.0.5"] });
  await assert.rejects(
    () => assertPublicHttpUrl("https://evil.test/", { lookup }),
    /resolves to a private address \(10\.0\.0\.5\)/,
  );
});

test("assertPublicHttpUrl rejects an IP address written as a number, without resolving anything", async () => {
  let looked = 0;
  const lookup = async (): Promise<string[]> => {
    looked += 1;
    return ["93.184.216.34"];
  };
  // Every one of these is 127.0.0.1 spelled so that isIP() says "not an
  // address". The WHATWG URL parser canonicalises them back to the literal, so
  // they are caught as loopback rather than by the numeric-host rule — either
  // message is fine, the property under test is that they do not get through
  // and that nothing is resolved.
  for (const u of ["http://2130706433/", "http://0x7f000001/", "http://0177.1/"]) {
    await assert.rejects(() => assertPublicHttpUrl(u, { lookup }), /numeric host|private\/loopback/, u);
  }
  // A dotted-numeric host the parser did NOT canonicalise is the numeric rule's
  // own job (it can only arrive from a caller that didn't go through new URL).
  assert.equal(looked, 0, "a numeric host is refused outright — there is nothing to resolve");
});

test("assertPublicHttpUrl rejects a non-http(s) port", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl("http://public.test:6379/", { lookup: PUBLIC_ONLY }),
    /port 6379/,
  );
  // …and allows the ordinary ones, including an implicit 443.
  for (const u of ["https://public.test/", "http://public.test:8080/x", "https://public.test:8443/x"]) {
    await assertPublicHttpUrl(u, { lookup: PUBLIC_ONLY });
  }
});

test("assertPublicHttpUrl blocks when the lookup fails — an unverifiable name is not fetched", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl("http://does-not-resolve.test/x", { lookup: PUBLIC_ONLY }),
    /could not be resolved/,
  );
  await assert.rejects(
    () => assertPublicHttpUrl("http://empty.test/x", { lookup: async () => [] }),
    /could not be resolved/,
  );
});

test("guardedFetch re-checks every redirect hop, so a 302 can't walk it into the private network", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/meta" } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => guardedFetch("https://public.test/model.stl", { fetchImpl, guard: { lookup: PUBLIC_ONLY } }),
    /private|blocked/i,
  );
  assert.equal(calls, 1, "the internal address is never requested — only the public origin was");
});

test("guardedFetch resolves a Location relative to the URL it came from", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (u: string) => {
    seen.push(String(u));
    if (seen.length === 1) {
      return new Response(null, { status: 302, headers: { location: "/second/step" } });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await guardedFetch("https://public.test/first", { fetchImpl, guard: { lookup: PUBLIC_ONLY } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://public.test/first", "https://public.test/second/step"]);
});

test("guardedFetch gives up on a redirect chain that never ends", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: `https://public.test/${calls}` } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => guardedFetch("https://public.test/0", { fetchImpl, guard: { lookup: PUBLIC_ONLY } }),
    /too many redirects/i,
  );
  assert.equal(calls, 6, "the first request plus five followed hops, and no more");
});

test("clamp bounds a number into [lo, hi]", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-5, 1, 10), 1);
  assert.equal(clamp(50, 1, 10), 10);
});
