// Every failure that reaches a browser goes through toWire(). These tests pin
// the two properties that matter for a public server: the client learns a
// STABLE CODE it can branch on, and it learns nothing else — no server
// filesystem paths, no upstream provider prose, no stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { WireError, sendScrubbed, stripPaths, toWire } from "./errors";
import type { Response } from "express";
import { NoApiKeyError, KeyFormatError } from "../main/userkey";
import { openAiErrorFrom } from "../main/agent/provider-openai";

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

test("the copy names no provider — the same sentence has to be true for either key", () => {
  // Slicely accepts a key from more than one provider now, and this module no
  // longer knows which one a given session is using. Naming Anthropic in the
  // copy would be wrong for half the users and is not information anyone can
  // act on: the fix is the same either way, and it is in Settings.
  for (const err of [
    new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()),
    new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()),
    new Anthropic.BadRequestError(400, undefined, "your credit balance is too low", new Headers()),
  ]) {
    const { body } = toWire(err);
    assert.doesNotMatch(body.error, /Anthropic|OpenAI|Claude|GPT/i, `branded copy: ${body.error}`);
  }
});

// ── sendScrubbed: keep our own wording, lose our own paths ───────────────────

/** The two things `sendScrubbed` uses off a Response, recorded. */
function recorder(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

test("sendScrubbed keeps a message we wrote and drops the paths inside it", () => {
  const { res, sent } = recorder();
  sendScrubbed(res, new Error("Part /data/sessions/abc/uploads/x.stl is larger than the bed"), "nope", 422);
  assert.equal(sent.status, 422);
  const body = sent.body as { error: string; code?: string };
  assert.match(body.error, /is larger than the bed/, "the actionable half must survive");
  assert.ok(!body.error.includes("/data/sessions"), `path leaked: ${body.error}`);
  assert.match(body.error, /<file>/);
});

test("sendScrubbed falls back when there is nothing to say, and defers to a WireError", () => {
  const empty = recorder();
  sendScrubbed(empty.res, new Error(""), "That job couldn't be planned.", 422);
  assert.deepEqual(empty.sent.body, { error: "That job couldn't be planned." });

  const notAnError = recorder();
  sendScrubbed(notAnError.res, "a string nobody should see", "Could not build a preview.", 500);
  assert.equal(notAnError.sent.status, 500);
  assert.deepEqual(notAnError.sent.body, { error: "Could not build a preview." });

  // A WireError already decided its own status and code; the caller's
  // suggestion must not override it.
  const wire = recorder();
  sendScrubbed(wire.res, new WireError(404, "No such printer.", "not_found"), "ignored", 422);
  assert.equal(wire.sent.status, 404);
  assert.deepEqual(wire.sent.body, { error: "No such printer.", code: "not_found" });
});

// ── the OpenAI provider's failures reach the same codes ─────────────────────

test("OpenAI's failures map to the same wire codes, through the same funnel", () => {
  const openai = (status: number, body: unknown) => toWire(openAiErrorFrom(status, JSON.stringify(body)));

  const rejected = openai(401, { error: { message: "Incorrect API key provided: sk-proj-SECRET", code: "invalid_api_key" } });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.code, "key_rejected");
  assert.ok(!rejected.body.error.includes("SECRET"), "upstream prose is logged, not relayed");

  const limited = openai(429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");

  // The bring-your-own-key trap: a quota 429 is NOT a rate limit. Retrying it
  // forever cannot restore access — the account needs topping up.
  const broke = openai(429, { error: { message: "You exceeded your quota", code: "insufficient_quota" } });
  assert.equal(broke.status, 402);
  assert.equal(broke.body.code, "billing");

  // A request-shape bug of OURS, and an outage at OpenAI, are both generic 500s
  // rather than a wrong instruction to the user.
  assert.equal(openai(400, { error: { message: "Unknown parameter: 'foo'" } }).status, 500);
  assert.equal(openai(503, { error: { message: "overloaded" } }).status, 500);
});
