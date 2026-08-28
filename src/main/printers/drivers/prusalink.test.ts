import { test } from "node:test";
import assert from "node:assert/strict";
import { prusalinkDriver } from "./prusalink";
import { buildDigestHeader } from "../digestAuth";
import type { ResolvedPrinter } from "../../../shared/printers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("prusalink status() uses X-Api-Key when supplied and parses a realistic /api/printer payload", async (t) => {
  const printer: ResolvedPrinter = {
    id: "p3",
    label: "MK4",
    transport: "prusalink",
    host: "10.0.0.7",
    port: 80,
    apiKey: "abc123",
  };

  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["X-Api-Key"], "abc123");
    assert.ok(url.endsWith("/api/printer"));
    return jsonResponse({
      state: {
        text: "Operational",
        flags: { operational: true, ready: true, printing: false, paused: false, error: false, closedOrError: false },
      },
      temperature: { tool0: { actual: 25.1, target: 0 }, bed: { actual: 23.4, target: 0 } },
    });
  });

  const status = await prusalinkDriver.status(printer);
  assert.equal(status.state, "idle");
  assert.equal(status.nozzleTempC, 25.1);
  assert.equal(status.bedTempC, 23.4);
});

test("prusalink test() falls back to HTTP Digest (qop=auth) when only a password is set, defaulting username to 'maker'", async (t) => {
  const printer: ResolvedPrinter = {
    id: "p4",
    label: "MK4 digest",
    transport: "prusalink",
    host: "10.0.0.8",
    port: 80,
    password: "swordfish",
  };

  let capturedAuthHeader: string | undefined;
  let sawChallengeRequest = false;

  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.ok(url.endsWith("/api/version"));
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    if (!headers.Authorization) {
      sawChallengeRequest = true;
      return new Response("", {
        status: 401,
        headers: { "WWW-Authenticate": 'Digest realm="PrusaLink", nonce="abc123nonce", qop="auth"' },
      });
    }
    capturedAuthHeader = headers.Authorization;
    return jsonResponse({ server: "2.0.0", hostname: "prusa-mk4" });
  });

  const result = await prusalinkDriver.test(printer);

  assert.equal(sawChallengeRequest, true);
  assert.equal(result.ok, true);
  assert.ok(capturedAuthHeader);
  assert.match(capturedAuthHeader as string, /^Digest /);
  assert.match(capturedAuthHeader as string, /username="maker"/);
  assert.match(capturedAuthHeader as string, /realm="PrusaLink"/);
  assert.match(capturedAuthHeader as string, /response="[0-9a-f]{32}"/);

  // Cross-check against the digestAuth module directly using the same
  // nonce/cnonce/nc the driver generated, tying this driver's usage to the
  // hashing logic that digestAuth.test.ts verifies against the RFC vector.
  const nc = /nc=([0-9a-f]+)/.exec(capturedAuthHeader as string)?.[1];
  const cnonce = /cnonce="([^"]+)"/.exec(capturedAuthHeader as string)?.[1];
  assert.ok(nc && cnonce);
  const expected = buildDigestHeader(
    { realm: "PrusaLink", nonce: "abc123nonce", qop: "auth" },
    "maker",
    "swordfish",
    "GET",
    "/api/version",
    nc,
    cnonce,
  );
  assert.equal(capturedAuthHeader, expected);
});

test("prusalink test() reports a plain-language auth failure on 401 without a challenge", async (t) => {
  const printer: ResolvedPrinter = {
    id: "p5",
    label: "MK4 bad key",
    transport: "prusalink",
    host: "10.0.0.9",
    apiKey: "wrong",
  };
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  const result = await prusalinkDriver.test(printer);
  assert.equal(result.ok, false);
  assert.match(result.message, /Authentication failed/);
});
