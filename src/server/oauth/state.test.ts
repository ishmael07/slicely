// The sealed note a sign-in carries with it, and the one rule that keeps a
// sign-in from ending up on somebody else's site.
//
// No network, no provider: this file only exercises the cookie, the PKCE
// derivation and `safeReturnTo`. The three HTTP cases drive a tiny Express app
// (the house pattern — `createServer` + `fetch`) so the cookie is written and
// read back by real request/response objects rather than by fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Express, Request, Response } from "express";
import { encryptSecret, resetKeyVaultForTests } from "../../main/keyvault";
import {
  clearOauthState,
  OAUTH_COOKIE,
  OAUTH_TTL_MS,
  pkceChallenge,
  readOauthState,
  safeReturnTo,
  startOauthState,
  statesMatch,
  type OauthState,
} from "./state";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
resetKeyVaultForTests();

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("the PKCE challenge is base64url of the SHA-256 of the verifier, unpadded", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const want = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceChallenge(verifier), want);
  assert.ok(!pkceChallenge(verifier).includes("="));
  assert.ok(!/[+/]/.test(pkceChallenge(verifier)));
});

test("return_to can only ever be a path on this site", () => {
  const hostile = [
    "https://evil.example/steal",
    "//evil.example",
    "\\\\evil.example",
    "/\\evil.example",
    "http:/\\/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "%2f%2fevil.example",
    "/\t/evil.example",
  ];
  for (const raw of hostile) {
    assert.equal(safeReturnTo(raw), "/", raw);
  }
  assert.equal(safeReturnTo("/"), "/");
  assert.equal(safeReturnTo("/app?q=phone+stand#top"), "/app?q=phone+stand#top");
  assert.equal(safeReturnTo(undefined), "/");
  assert.equal(safeReturnTo(""), "/");
  assert.equal(safeReturnTo("/" + "a".repeat(600)), "/");
});

test("states are compared in constant time and a wrong length is simply false", () => {
  const a = randomBytes(32).toString("base64url");
  assert.equal(statesMatch(a, a), true);
  assert.equal(statesMatch(a, a.slice(0, -1)), false);
  assert.equal(statesMatch(a, undefined), false);
  assert.equal(statesMatch(a, 42), false);
  assert.equal(statesMatch(a, randomBytes(32).toString("base64url")), false);
});

test("starting a sign-in sets one sealed, short-lived, host-locked cookie", async () => {
  let issued: OauthState | undefined;
  const app = express();
  app.get("/start", (req: Request, res: Response) => {
    issued = startOauthState(res, "google", req.query.return_to);
    res.status(204).end();
  });
  const { base, close } = await listen(app);
  try {
    const resp = await fetch(`${base}/start?return_to=/app`);
    assert.equal(resp.status, 204);
    const cookies = resp.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    const [cookie] = cookies;
    assert.ok(cookie.startsWith(`${OAUTH_COOKIE}=`), cookie);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, new RegExp(`; Max-Age=${OAUTH_TTL_MS / 1000}\\b`));

    assert.ok(issued);
    assert.equal(issued.provider, "google");
    assert.equal(issued.returnTo, "/app");
    // The cookie is ENCRYPTED, not signed: the PKCE verifier is inside it, so
    // neither it nor the state may be readable from the header.
    assert.ok(!cookie.includes(issued.state), "state leaked into the cookie in the clear");
    assert.ok(!cookie.includes(issued.verifier), "verifier leaked into the cookie in the clear");
    assert.ok(!cookie.includes(issued.nonce), "nonce leaked into the cookie in the clear");
  } finally {
    await close();
  }
});

test("the cookie round-trips, and a tampered, foreign or expired one is simply absent", async () => {
  let issued: OauthState | undefined;
  const app = express();
  app.get("/start", (req: Request, res: Response) => {
    issued = startOauthState(res, "github", req.query.return_to);
    res.status(204).end();
  });
  app.get("/read", (req: Request, res: Response) => {
    res.json(readOauthState(req) ?? { missing: true });
  });
  const { base, close } = await listen(app);
  try {
    const started = await fetch(`${base}/start?return_to=/app%3Fq%3Dvase`);
    const cookie = started.headers.getSetCookie()[0].split(";")[0];
    assert.ok(issued);

    const round = (await (await fetch(`${base}/read`, { headers: { cookie } })).json()) as OauthState;
    assert.deepEqual(round, issued);

    // Tampered: one character of the ciphertext flipped.
    const value = cookie.slice(OAUTH_COOKIE.length + 1);
    const flipped = value.slice(0, -2) + (value.at(-2) === "A" ? "B" : "A") + value.at(-1);
    const bad = await (await fetch(`${base}/read`, { headers: { cookie: `${OAUTH_COOKIE}=${flipped}` } })).json();
    assert.deepEqual(bad, { missing: true });

    // Encrypted under a DIFFERENT master key: decryption fails, and failing
    // must mean "no state", never a thrown 500.
    const foreign = encryptSecret(JSON.stringify({ p: "github", state: "x", verifier: "y", nonce: "z", returnTo: "/", exp: Date.now() + 1000 }), randomBytes(32));
    const other = await (
      await fetch(`${base}/read`, { headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(foreign)}` } })
    ).json();
    assert.deepEqual(other, { missing: true });

    // Expired: decrypts fine, but `exp` is in the past.
    const stale = encryptSecret(
      JSON.stringify({ p: "github", state: "x", verifier: "y", nonce: "z", returnTo: "/", exp: Date.now() - 1 }),
    );
    const expired = await (
      await fetch(`${base}/read`, { headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(stale)}` } })
    ).json();
    assert.deepEqual(expired, { missing: true });

    // Not a cookie we set at all.
    const none = await (await fetch(`${base}/read`)).json();
    assert.deepEqual(none, { missing: true });
  } finally {
    await close();
  }
});

test("clearing the note expires the same cookie with the same attributes", async () => {
  const app = express();
  app.get("/clear", (_req: Request, res: Response) => {
    clearOauthState(res);
    res.status(204).end();
  });
  const { base, close } = await listen(app);
  try {
    const resp = await fetch(`${base}/clear`);
    const cookies = resp.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    const [cookie] = cookies;
    assert.ok(cookie.startsWith(`${OAUTH_COOKIE}=;`), cookie);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Max-Age=0\b/);
  } finally {
    await close();
  }
});
