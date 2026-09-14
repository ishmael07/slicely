// Tests for the window's navigation predicate (Task E1, fix round 1).
//
// The bug being pinned: the guard was `target.startsWith(serverUrl)`, so a URL
// whose *userinfo* is our own origin passed it and the window navigated to a
// hostile host with the preload bridge still attached. Every case below is a
// string that a prefix check accepts and an origin check does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin } from "./navigation";

const SERVER = "http://127.0.0.1:53421";

test("our own origin is allowed, with any path, query or fragment", () => {
  assert.equal(isSameOrigin(SERVER, SERVER), true);
  assert.equal(isSameOrigin(`${SERVER}/`, SERVER), true);
  assert.equal(isSameOrigin(`${SERVER}/index.html?a=1#b`, SERVER), true);
  assert.equal(isSameOrigin(`${SERVER}/web/app.js`, SERVER), true);
});

test("userinfo cannot impersonate our origin — the prefix-check bug", () => {
  // Host is `evil.example`. `127.0.0.1:53421` is a username.
  assert.equal(isSameOrigin(`${SERVER}@evil.example/`, SERVER), false);
  assert.equal(isSameOrigin(`${SERVER}@evil.example/steal`, SERVER), false);
  assert.equal(isSameOrigin("http://127.0.0.1:53421:pw@evil.example/", SERVER), false);
});

test("a host that merely starts with ours is a different host", () => {
  assert.equal(isSameOrigin("http://127.0.0.1:53421.evil.example/", SERVER), false);
  assert.equal(isSameOrigin("http://127.0.0.1.evil.example:53421/", SERVER), false);
});

test("a port that merely starts with ours is a different port", () => {
  assert.equal(isSameOrigin("http://127.0.0.1:534210/", SERVER), false);
  assert.equal(isSameOrigin("http://127.0.0.1:5342/", SERVER), false);
});

test("the scheme is part of the origin", () => {
  assert.equal(isSameOrigin("https://127.0.0.1:53421/", SERVER), false);
  assert.equal(isSameOrigin("file:///etc/passwd", SERVER), false);
  assert.equal(isSameOrigin("javascript:alert(1)", SERVER), false);
});

test("localhost is not 127.0.0.1 — the server named one of them", () => {
  assert.equal(isSameOrigin("http://localhost:53421/", SERVER), false);
});

test("anything unparseable, and anything opaque, is refused", () => {
  assert.equal(isSameOrigin("", SERVER), false);
  assert.equal(isSameOrigin("/relative", SERVER), false);
  assert.equal(isSameOrigin("about:blank", SERVER), false);
  assert.equal(isSameOrigin("data:text/html,<h1>hi", SERVER), false);
  assert.equal(isSameOrigin("not a url at all", SERVER), false);
});

test("before the server is listening there is no origin to match, so nothing passes", () => {
  // `serverUrl` is "" until startServer resolves. A window that somehow tries
  // to navigate before then must be refused, not allowed by accident.
  assert.equal(isSameOrigin(`${SERVER}/`, ""), false);
  assert.equal(isSameOrigin("", ""), false);
});
