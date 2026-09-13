import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSession, sessionContext } from "../session-context";
import { SlicelyAgent } from "./agent";
import { NoApiKeyError } from "../userkey";

test("no key → a typed error the UI can turn into the key card, with no .env talk", () => {
  process.env.SLICELY_MODE = "hosted";
  // The developer's .env may hold a real key plus the operator flag; "no key" must mean none.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SLICELY_ALLOW_OPERATOR_KEY;
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  runInSession(sessionContext("nokey", dir), () => {
    assert.throws(
      () => new SlicelyAgent(),
      (e: unknown) =>
        e instanceof NoApiKeyError && (e as NoApiKeyError).code === "no_key" && !/\.env/.test((e as Error).message),
    );
  });
});
