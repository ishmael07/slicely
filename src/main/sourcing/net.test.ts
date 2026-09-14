import { test } from "node:test";
import assert from "node:assert/strict";
// Deliberately `import ... = require(...)` (not `import * as dns from`) so
// this resolves to the exact same raw CommonJS module object net.ts's own
// compiled `require("node:dns/promises")` uses — TS's `import * as`
// namespace-import emits a getter-based rebinding wrapper that
// `t.mock.method` can't intercept (it only replaces plain data properties).
import dns = require("node:dns/promises");
import {
  isPrivateHost,
  isPrivateAddress,
  isLocalOrLinkLocalAddress,
  normalizeIp,
  assertPublicHttpUrl,
  guardedFetch,
  clamp,
} from "./net";

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
  for (const ip of [
    "8.8.8.8",
    "93.184.216.34",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "2606:4700::1",
    // The IPv6 documentation prefix has never been in these ranges; it is here
    // to pin that the range logic hasn't quietly started swallowing real IPv6.
    "2001:db8::1",
  ]) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} to be public`);
  }
});

// The bypass fix round 1 was opened for: WHATWG URL prints an IPv4-mapped IPv6
// address in HEX, so every guard that matched only "::ffff:10.0.0.1" was blind
// to the form the URL parser actually hands it.
test("an IPv4-mapped or IPv4-compatible IPv6 address is classified as the IPv4 address it is", () => {
  const cases: [string, string][] = [
    ["::ffff:7f00:1", "127.0.0.1"], // what new URL("http://[::ffff:127.0.0.1]/") produces
    ["::ffff:a9fe:a9fe", "169.254.169.254"], // …and the cloud metadata address
    ["::ffff:a00:1", "10.0.0.1"],
    ["0:0:0:0:0:ffff:10.0.0.1", "10.0.0.1"],
    ["::ffff:10.0.0.1", "10.0.0.1"],
    ["::7f00:1", "127.0.0.1"], // deprecated IPv4-compatible form
    ["[::ffff:7f00:1]", "127.0.0.1"], // bracketed, as a URL hostname arrives
    ["::ffff:7f00:1%en0", "127.0.0.1"], // with a zone id
    ["::FFFF:7F00:1", "127.0.0.1"], // upper case
  ];
  for (const [spelling, expected] of cases) {
    assert.equal(normalizeIp(spelling), expected, `${spelling} normalises to ${expected}`);
    assert.equal(isPrivateAddress(spelling), true, `expected ${spelling} to be private`);
    assert.equal(isLocalOrLinkLocalAddress(spelling), expected.startsWith("10.") ? false : true, spelling);
  }
  // Not mapped addresses: these stay IPv6 and keep their own classification.
  assert.equal(normalizeIp("::1"), "::1");
  assert.equal(normalizeIp("::"), "::");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(isLocalOrLinkLocalAddress("0:0:0:0:0:0:0:1"), true, "::1 written out in full");
  assert.equal(isLocalOrLinkLocalAddress("2001:db8::1"), false);
  // A hostname is not an address and must pass through untouched.
  assert.equal(normalizeIp("Example.COM"), "example.com");
});

test("assertPublicHttpUrl rejects a hex-spelled IPv4-mapped IPv6 URL", async () => {
  let looked = 0;
  const lookup = async (): Promise<string[]> => {
    looked += 1;
    return ["93.184.216.34"];
  };
  for (const u of [
    "http://[::ffff:7f00:1]:8080/admin", // loopback, on a port an admin UI uses
    "http://[::ffff:a9fe:a9fe]/latest/meta-data/iam/security-credentials/",
    "http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data/",
    "http://[::7f00:1]/x",
  ]) {
    await assert.rejects(() => assertPublicHttpUrl(u, { lookup }), /private\/loopback/, u);
  }
  assert.equal(looked, 0, "an IP literal is decided on the spot — nothing is resolved");
});

test("assertPublicHttpUrl rejects a name whose AAAA record is a mapped internal address", async () => {
  const lookup = fakeLookup({ "rebind.test": ["93.184.216.34", "::ffff:7f00:1"] });
  await assert.rejects(
    () => assertPublicHttpUrl("https://rebind.test/", { lookup }),
    /resolves to a private address/,
  );
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
  for (const u of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.1/",
    "http://127.1/", // the two-part short form
    "http://0177.0.0.1/", // one octet in octal, the rest decimal
  ]) {
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
    // Same scheme as the origin, so this test is about the ADDRESS and not
    // about the https→http downgrade rule below.
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/meta" } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => guardedFetch("https://public.test/model.stl", { fetchImpl, guard: { lookup: PUBLIC_ONLY } }),
    /private|blocked/i,
  );
  assert.equal(calls, 1, "the internal address is never requested — only the public origin was");
});

test("guardedFetch refuses a hop to a hex-spelled IPv4-mapped loopback address", async () => {
  for (const location of ["http://[::ffff:7f00:1]/meta", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"]) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location } });
    }) as unknown as typeof fetch;

    // An http origin, so the downgrade rule is not what refuses this.
    await assert.rejects(
      () => guardedFetch("http://public.test/model.stl", { fetchImpl, guard: { lookup: PUBLIC_ONLY } }),
      /private|blocked/i,
      location,
    );
    assert.equal(calls, 1, `${location} is never requested — only the public origin was`);
  }
});

test("guardedFetch refuses a hop that downgrades https to http", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://public.test/model.stl" } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => guardedFetch("https://public.test/start", { fetchImpl, guard: { lookup: PUBLIC_ONLY } }),
    /downgrad|blocked/i,
  );
  assert.equal(calls, 1, "the plaintext hop is never made");
});

test("guardedFetch resolves a Location relative to the URL it came from, and releases the 3xx body", async () => {
  const seen: string[] = [];
  const redirects: Response[] = [];
  const fetchImpl = (async (u: string) => {
    seen.push(String(u));
    if (seen.length === 1) {
      // A real 3xx often carries a short HTML body nobody will ever read; left
      // undrained it holds the connection until the agent times it out.
      const first = new Response("<html>moved</html>", { status: 302, headers: { location: "/second/step" } });
      redirects.push(first);
      return first;
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await guardedFetch("https://public.test/first", { fetchImpl, guard: { lookup: PUBLIC_ONLY } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://public.test/first", "https://public.test/second/step"]);
  assert.equal(redirects[0].bodyUsed, true, "the redirect's body was cancelled before the next hop");
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

// ── Extras E2–E4: two more spellings of the same address, and no throwing ─────

test("an IPv6 address that CARRIES an IPv4 address is judged by the address it carries", () => {
  // NAT64's well-known prefix. An IPv6-only host reaches 127.0.0.1 as
  // 64:ff9b::7f00:1, and the gateway on the path does the translation — none of
  // the IPv6 range rules would have noticed, because no IPv6 range contains it.
  assert.equal(normalizeIp("64:ff9b::7f00:1"), "127.0.0.1");
  assert.equal(isPrivateAddress("64:ff9b::7f00:1"), true);
  assert.equal(isLocalOrLinkLocalAddress("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateAddress("64:ff9b::a9fe:a9fe"), true, "the cloud metadata address, via NAT64");
  assert.equal(isPrivateAddress("64:ff9b::c0a8:101"), true, "192.168.1.1, via NAT64");

  // 6to4 keeps the IPv4 address in hextets 1–2.
  assert.equal(normalizeIp("2002:7f00:1::1"), "127.0.0.1");
  assert.equal(isPrivateAddress("2002:7f00:1::1"), true);
  assert.equal(isPrivateAddress("2002:a9fe:a9fe::1"), true, "169.254.169.254, via 6to4");

  // And the folding cuts both ways — which is the point. A 6to4 address whose
  // embedded IPv4 is public IS public, and must stay fetchable.
  assert.equal(normalizeIp("2002:808:808::1"), "8.8.8.8");
  assert.equal(isPrivateAddress("2002:808:808::1"), false);
  assert.equal(isPrivateAddress("2002:0808:0808::"), false);
  // Real IPv6 that merely starts nearby is untouched.
  assert.equal(isPrivateAddress("2001:db8::1"), false);
  assert.equal(isPrivateAddress("2606:4700::1"), false);
});

test("a trailing DNS root dot does not walk past the hostname rules", async () => {
  // `localhost.` is the fully-qualified spelling of `localhost` and resolves to
  // the loopback everywhere — but it is a different STRING, so the name lists
  // missed it and the guard fell through to a DNS lookup for a name it should
  // have refused outright. Two dots got past even a single-dot strip.
  for (const host of ["localhost.", "localhost..", "LocalHost."]) {
    assert.equal(isPrivateHost(host), true, `${host} should read as loopback`);
  }
  assert.equal(isPrivateHost("printer.local."), true);

  // A BRACKETED IPv6 literal with the root dot after the bracket. This is the
  // case the old code missed by construction: it stripped the brackets first,
  // and in `[::1].` the `]` is not the last character, so `\]$` never matched.
  // What came out was `::1]`, which `isIP` does not recognise — so the loopback
  // literal was classified "a real hostname" and sent to the resolver.
  for (const host of ["[::1].", "[::1]..", "[::ffff:127.0.0.1].", "[fc00::1]."]) {
    assert.equal(isPrivateHost(host), true, `${host} should read as private`);
  }
  // Undotted and unbracketed spellings of the same hosts still work.
  assert.equal(isPrivateHost("[::1]"), true);
  assert.equal(isPrivateHost("::1."), true);

  // The refusal happens on the NAME: the lookup below throws if it is reached,
  // so this also proves no DNS query was made.
  const neverCalled = async (h: string): Promise<string[]> => {
    throw new Error(`no lookup should have happened, got ${h}`);
  };
  for (const url of ["http://localhost./x", "http://localhost..", "http://127.0.0.1./x"]) {
    await assert.rejects(
      () => assertPublicHttpUrl(url, { lookup: neverCalled }),
      /private\/loopback|numeric host/,
      `${url} should be refused by the hostname rule`,
    );
  }
});

test("malformed near-IPv6 input is returned verbatim rather than throwing", () => {
  // These reach normalizeIp from hostile input and from `new URL` alike. The
  // requirement is only that the guards stay UP and the process stays ALIVE: a
  // throw here would turn "refuse this host" into a 500 (or an unhandled
  // rejection) on every code path that classifies an address.
  for (const bad of [":::1", "1:2:3:4:5:6:7:8:9", "1::", "::", "1:2:3:4:5:6:7:8:", "2002:", "64:ff9b:::1", "", "::ffff:1.2.3.4.5", "[]", "%eth0"]) {
    assert.doesNotThrow(() => normalizeIp(bad), `normalizeIp threw on ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => isPrivateAddress(bad), `isPrivateAddress threw on ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => isLocalOrLinkLocalAddress(bad), `isLocalOrLinkLocalAddress threw on ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => isPrivateHost(bad), `isPrivateHost threw on ${JSON.stringify(bad)}`);
    assert.equal(typeof normalizeIp(bad), "string");
  }
  // Unrecognised text comes back as itself (lowercased, de-bracketed), and is
  // then simply "not an address" to every range check.
  assert.equal(normalizeIp(":::1"), ":::1");
  assert.equal(normalizeIp("1:2:3:4:5:6:7:8:9"), "1:2:3:4:5:6:7:8:9");
  assert.equal(isPrivateAddress(":::1"), false);
  // …and it can never become a socket target, because the URL parser refuses it.
  assert.throws(() => new URL("http://:::1/"));
  assert.throws(() => new URL("http://1:2:3:4:5:6:7:8:9/"));
});
