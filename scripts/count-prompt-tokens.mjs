#!/usr/bin/env node
// `npm run tokens` — what the cached prefix ACTUALLY costs, per Anthropic's own
// tokeniser.
//
// prompt.ts's `estimateTokens` is bytes/4, deliberately: the budget test in
// prompt.test.ts has to run offline in CI, so it guards a guess rather than a
// measurement. This script is the calibration. It counts the real thing with one
// `messages.count_tokens` call — free, and it does not generate a token — and
// says how far the estimate has drifted.
//
// IF THE DRIFT PASSES 15%, CHANGE THE DIVISOR IN prompt.ts rather than loosening
// the window in the test. The window is the product decision (a prefix under
// 1,024 tokens is not cached at all, and one over 6,000 makes the free tier
// expensive); the divisor is just arithmetic.
//
// Needs the owner's own key in ANTHROPIC_API_KEY. It sends the prompt and the
// tool block — no user data, no conversation — and prints nothing but numbers.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "dist/main/agent/prompt.js"))) {
  console.error("Run `npm run build` first — this reads the compiled prompt and tools.");
  process.exit(1);
}

const { SYSTEM_PROMPT, estimateTokens, staticPrefixTokens } = require(
  join(root, "dist/main/agent/prompt.js"),
);
const { TOOLS } = require(join(root, "dist/main/agent/tools.js"));
const { toAnthropicTools } = require(join(root, "dist/main/agent/provider-anthropic.js"));

const estimate = staticPrefixTokens(TOOLS);
const promptBytes = Buffer.byteLength(SYSTEM_PROMPT);
const descriptionBytes = Buffer.byteLength(TOOLS.map((t) => t.description).join(""));
const schemaBytes = Buffer.byteLength(JSON.stringify(TOOLS.map((t) => t.schema)));

console.log(`system prompt       ${promptBytes.toLocaleString()} bytes  (budget 7,000)`);
console.log(`tool descriptions   ${descriptionBytes.toLocaleString()} bytes  (budget 5,000)`);
console.log(`tool schemas        ${schemaBytes.toLocaleString()} bytes`);
console.log(`estimated prefix    ${estimate.toLocaleString()} tokens  (window 1,024–6,000)`);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("\nNo ANTHROPIC_API_KEY — stopping at the estimate. Set it to get the real count.");
  process.exit(0);
}

// The model matters: tokenisation is per-model, and the free tier's model is the
// one whose bill this budget is about.
const MODEL = "claude-sonnet-5";
const Anthropic = require(join(root, "node_modules/@anthropic-ai/sdk")).default;
const client = new Anthropic({ apiKey, maxRetries: 1 });

// One user message is unavoidable — count_tokens needs a non-empty messages
// array — so its own tokens are subtracted back out.
const PROBE = "hi";
const [full, probeOnly] = await Promise.all([
  client.messages.countTokens({
    model: MODEL,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: toAnthropicTools(TOOLS),
    messages: [{ role: "user", content: PROBE }],
  }),
  client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: PROBE }],
  }),
]);

const real = full.input_tokens - probeOnly.input_tokens;
const drift = (estimate - real) / real;
const sign = drift >= 0 ? "+" : "";
console.log(`\nreal prefix         ${real.toLocaleString()} tokens  (${MODEL})`);
console.log(`estimator drift     ${sign}${(drift * 100).toFixed(1)}%`);

if (real < 1024) {
  console.log("\nUNDER 1,024 TOKENS: this prefix will not be cached at all, which makes every");
  console.log("call MORE expensive, not less. Put something back.");
}
if (Math.abs(drift) > 0.15) {
  console.log("\nDRIFT OVER 15%: recalibrate estimateTokens in src/main/agent/prompt.ts.");
  console.log(`A divisor of ${(Buffer.byteLength(SYSTEM_PROMPT + JSON.stringify(TOOLS)) / real).toFixed(2)} would match today's figure.`);
}
