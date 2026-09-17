// The preload runs sandboxed, so it cannot import ../shared/types at runtime
// and spells its IPC channel names out by hand. Two things must stay true:
// the compiled preload requires nothing but Electron, and its channel strings
// are the ones main.ts listens on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../shared/types";

const preload = readFileSync(join(__dirname, "preload.js"), "utf8");

test("the compiled preload requires only electron", () => {
  const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ["electron"]);
});

test("the preload's channel names are the IPC channels main.ts handles", () => {
  for (const channel of Object.values(IPC)) {
    assert.ok(preload.includes(JSON.stringify(channel)), `preload.js does not mention ${channel}`);
  }
});
