import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, isDisposableDomain, EmailRejected, DISPOSABLE_DOMAINS } from "./email";

test("gmail dots and plus-tags are the same mailbox, and googlemail is gmail", () => {
  const cases = [
    ["Jane.Doe@gmail.com", "janedoe@gmail.com"],
    ["j.a.n.e.d.o.e@GMAIL.COM", "janedoe@gmail.com"],
    ["janedoe+slicely@gmail.com", "janedoe@gmail.com"],
    ["jane.doe+a+b@googlemail.com", "janedoe@gmail.com"],
    ["  janedoe@gmail.com  ", "janedoe@gmail.com"],
  ] as const;
  for (const [raw, want] of cases) {
    assert.equal(normalizeEmail(raw).normalized, want, raw);
  }
});

test("outside gmail a dot is significant, but a plus-tag still is not", () => {
  assert.equal(normalizeEmail("jane.doe@example.com").normalized, "jane.doe@example.com");
  assert.equal(normalizeEmail("jane.doe+slicely@example.com").normalized, "jane.doe@example.com");
  assert.equal(normalizeEmail("Jane@Example.COM").normalized, "jane@example.com");
});

test("the display email is preserved even while the key is normalised", () => {
  const n = normalizeEmail("Jane.Doe+shop@Gmail.com");
  assert.equal(n.email, "Jane.Doe+shop@Gmail.com");
  assert.equal(n.normalized, "janedoe@gmail.com");
  assert.equal(n.domain, "gmail.com");
});

test("nonsense is refused with email_invalid, never normalised into something plausible", () => {
  for (const bad of ["", "   ", "jane", "jane@", "@example.com", "jane@localhost",
                     "jane@@example.com", "jane doe@example.com", null, undefined, 42,
                     "+tag@gmail.com", "a".repeat(250) + "@example.com"]) {
    assert.throws(() => normalizeEmail(bad as unknown),
      (e: unknown) => e instanceof EmailRejected && e.code === "email_invalid",
      JSON.stringify(bad));
  }
});

test("throwaway domains are refused and real ones are not", () => {
  assert.ok(DISPOSABLE_DOMAINS.size > 1000, "the bundled list should be substantial");
  for (const d of ["mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com"]) {
    assert.equal(isDisposableDomain(d), true, d);
  }
  for (const d of ["gmail.com", "googlemail.com", "outlook.com", "protonmail.com",
                   "icloud.com", "cam.ac.uk", "slicely.example"]) {
    assert.equal(isDisposableDomain(d), false, d);
  }
  assert.equal(isDisposableDomain("MAILINATOR.COM"), true, "case must not be a bypass");
});
