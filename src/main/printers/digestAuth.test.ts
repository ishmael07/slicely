import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigestHeader, parseDigestChallenge } from "./digestAuth";

test("parseDigestChallenge extracts realm/nonce/qop/opaque from a real header", () => {
  const header =
    'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
    'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
  const challenge = parseDigestChallenge(header);
  assert.ok(challenge);
  assert.equal(challenge.realm, "testrealm@host.com");
  assert.equal(challenge.nonce, "dcd98b7102dd2f0e8b11d0f600bfb0c093");
  assert.equal(challenge.qop, "auth,auth-int");
  assert.equal(challenge.opaque, "5ccc069c403ebaf9f0171e9517f40e41");
});

test("parseDigestChallenge rejects non-Digest / malformed headers", () => {
  assert.equal(parseDigestChallenge(null), undefined);
  assert.equal(parseDigestChallenge('Basic realm="x"'), undefined);
  assert.equal(parseDigestChallenge('Digest realm="onlyrealm"'), undefined); // no nonce
});

test("buildDigestHeader matches RFC 2617's worked example exactly", () => {
  // This is the canonical example from RFC 2617 §3.5 — Mufasa/Circle Of Life
  // against testrealm@host.com — used here as a known-correct vector rather
  // than trusting our own math against itself.
  const challenge = {
    realm: "testrealm@host.com",
    nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
    qop: "auth",
    opaque: "5ccc069c403ebaf9f0171e9517f40e41",
  };
  const header = buildDigestHeader(
    challenge,
    "Mufasa",
    "Circle Of Life",
    "GET",
    "/dir/index.html",
    "00000001",
    "0a4f113b",
  );

  assert.match(header, /^Digest /);
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /username="Mufasa"/);
  assert.match(header, /realm="testrealm@host\.com"/);
  assert.match(header, /uri="\/dir\/index\.html"/);
  assert.match(header, /qop=auth/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test("buildDigestHeader falls back to RFC 2069 form when qop is absent", () => {
  const challenge = { realm: "r", nonce: "n" };
  const header = buildDigestHeader(challenge, "u", "p", "PUT", "/x", "00000001", "c");
  assert.doesNotMatch(header, /qop=/);
  assert.doesNotMatch(header, /nc=/);
});
