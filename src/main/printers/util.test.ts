import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeColourHex, describeError } from "./util";

test("normalizeColourHex converts Bambu's 8-hex RRGGBBAA to #RRGGBB", () => {
  assert.equal(normalizeColourHex("00AE42FF"), "#00AE42");
});

test("normalizeColourHex accepts a bare 6-hex colour", () => {
  assert.equal(normalizeColourHex("ff8800"), "#FF8800");
});

test("normalizeColourHex accepts a leading #", () => {
  assert.equal(normalizeColourHex("#00AE42FF"), "#00AE42");
});

test("normalizeColourHex rejects garbage", () => {
  assert.equal(normalizeColourHex(""), undefined);
  assert.equal(normalizeColourHex(undefined), undefined);
  assert.equal(normalizeColourHex(null), undefined);
  assert.equal(normalizeColourHex("not-a-colour"), undefined);
  assert.equal(normalizeColourHex("12345"), undefined); // 5 hex digits
});

test("describeError unwraps Error messages and stringifies everything else", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("plain string"), "plain string");
  assert.equal(describeError(42), "42");
});
