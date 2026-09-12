// Every failure that reaches a browser goes through toWire(). These tests pin
// the two properties that matter for a public server: the client learns a
// STABLE CODE it can branch on, and it learns nothing else — no server
// filesystem paths, no upstream provider prose, no stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { WireError, stripPaths, toWire } from "./errors";
import { NoApiKeyError, KeyFormatError } from "../main/userkey";

test("stripPaths replaces absolute server paths with a placeholder", () => {
  assert.equal(stripPaths("/Users/it/Slicely-data/sessions/abc/uploads/x.stl failed"), "<file> failed");
  assert.equal(stripPaths("could not read /home/app/data/sessions/z/plate-1.gcode"), "could not read <file>");
  assert.equal(stripPaths("no paths here"), "no paths here");
  // Prose that merely starts like a path is not a path.
  assert.equal(stripPaths("check the /variable name"), "check the /variable name");
});

test("a WireError is relayed as it was raised", () => {
  const wire = toWire(new WireError(403, "nope", "forbidden_in_hosted_mode"));
  assert.equal(wire.status, 403);
  assert.equal(wire.body.error, "nope");
  assert.equal(wire.body.code, "forbidden_in_hosted_mode");
});

test("an unexpected error becomes a generic message — no path, no message leak", () => {
  const wire = toWire(new Error("boom /Users/it/secret.txt"));
  assert.equal(wire.status, 500);
  assert.equal(wire.body.error, "Something went wrong.");
  assert.ok(!wire.body.error.includes("secret.txt"));
  assert.ok(!wire.body.error.includes("boom"));
});

test("the key errors map to the codes the UI branches on", () => {
  const noKey = toWire(new NoApiKeyError("Connect your Anthropic API key in Settings to chat."));
  assert.equal(noKey.status, 409);
  assert.equal(noKey.body.code, "no_key");

  const badFormat = toWire(new KeyFormatError("That doesn't look like an Anthropic API key."));
  assert.equal(badFormat.status, 400);
  assert.equal(badFormat.body.code, "key_invalid_format");
});

test("Anthropic's own failures become the user's next action, not a 500", () => {
  const rejected = toWire(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.code, "key_rejected");
  assert.match(rejected.body.error, /Settings/);
  assert.ok(!rejected.body.error.includes("x-api-key"), "upstream prose is logged, not relayed");

  const limited = toWire(new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");

  const noCredit = toWire(
    new Anthropic.BadRequestError(400, undefined, "your credit balance is too low", new Headers()),
  );
  assert.equal(noCredit.status, 402);
  assert.equal(noCredit.body.code, "billing");

  const forbidden = toWire(new Anthropic.PermissionDeniedError(403, undefined, "no access", new Headers()));
  assert.equal(forbidden.status, 402);
  assert.equal(forbidden.body.code, "billing");

  // A request-shape bug of OURS is not the user's billing problem.
  const otherBadRequest = toWire(new Anthropic.BadRequestError(400, undefined, "max_tokens too large", new Headers()));
  assert.equal(otherBadRequest.status, 500);
  assert.equal(otherBadRequest.body.error, "Something went wrong.");
});
