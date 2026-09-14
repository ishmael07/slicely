// POST /api/find, over HTTP, with no model and no key anywhere near it.
//
// The thing being proved is a negative: this path spends NO AI credit. So the
// sourcing façade is stubbed (no model sites), the chat agent factory is a spy
// that must never be called, and there is no key in the session at all — a
// request that needed one would fail rather than quietly succeed on an owner
// fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";
import type { SourcingApi } from "../facades";
import type { SearchOptions, SearchOutcome, SourcedModel } from "../../shared/sourcing";

process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SLICELY_ALLOW_OPERATOR_KEY;

const MODEL: SourcedModel = {
  source: "printables",
  id: "42",
  title: "Phone stand",
  webUrl: "https://www.printables.com/model/42",
  downloadable: true,
};

/** A sourcing façade that answers from memory and records what it was asked. */
function stubSourcing(): SourcingApi & { calls: Array<{ query: string; opts?: SearchOptions }> } {
  const calls: Array<{ query: string; opts?: SearchOptions }> = [];
  return {
    calls,
    async searchModels(query: string, opts?: SearchOptions): Promise<SearchOutcome> {
      calls.push({ query, opts });
      return { results: [MODEL], sources: [{ id: "printables", ok: true, count: 1, ms: 3 }] };
    },
    async resolveUrl() {
      throw new Error("not used");
    },
    async downloadModel() {
      throw new Error("not used");
    },
    async downloadFromUrl() {
      throw new Error("not used");
    },
    sourceAvailability() {
      return [];
    },
  };
}

/** A chat agent factory that FAILS the test if anything constructs one. */
function forbiddenAgent(): { factory: () => ChatAgent; count: () => number } {
  let count = 0;
  return {
    factory: () => {
      count += 1;
      return {
        async send(_m, emit) {
          emit({ type: "done" });
        },
        cancel() {
          /* never reached */
        },
      };
    },
    count: () => count,
  };
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function cookieOf(resp: Response): string {
  const raw = resp.headers.get("set-cookie");
  assert.ok(raw, "expected a session cookie");
  return raw.split(";")[0];
}

interface Harness {
  base: string;
  cookie: string;
  sourcing: ReturnType<typeof stubSourcing>;
  agents: ReturnType<typeof forbiddenAgent>;
  close: () => Promise<void>;
}

async function harness(heavyMax?: number): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "slicely-find-"));
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const sourcing = stubSourcing();
  const agents = forbiddenAgent();
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: agents.factory,
      keyValidator: async () => "ok",
      sourcingApi: sourcing,
      // A token bucket: `capacity` is the burst, and a refill slow enough that
      // nothing trickles back mid-test.
      ...(heavyMax === undefined
        ? {}
        : { limits: { heavy: { capacity: heavyMax, refillPerSec: 0 } } }),
    }),
  );
  // GET /api/config is the one call that may mint a workspace (session.ts's
  // MINTING_ROUTES), so it is how a client gets its cookie.
  const cookie = cookieOf(await fetch(`${base}/api/config`));
  return {
    base,
    cookie,
    sourcing,
    agents,
    close: async () => {
      await close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function find(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.base}/api/find`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: h.cookie },
    body: JSON.stringify(body),
  });
}

test("a find runs the real fan-out and wakes no model at all", async () => {
  const h = await harness();
  try {
    const resp = await find(h, { query: "phone stand" });
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { query: string; models: SourcedModel[] };
    assert.equal(json.query, "phone stand");
    assert.deepEqual(json.models, [MODEL]);

    // The SAME façade the find_models tool calls, once, with the user's words.
    assert.equal(h.sourcing.calls.length, 1);
    assert.equal(h.sourcing.calls[0].query, "phone stand");

    // And the thing that costs money never happened: no agent was constructed,
    // so no provider key was read and no turn was metered.
    assert.equal(h.agents.count(), 0, "a find must never construct a chat agent");
  } finally {
    await h.close();
  }
});

test("it works with no key and no account — this path is free to everyone", async () => {
  const h = await harness();
  try {
    // Nothing has been PUT to /api/key, so this session has no provider key.
    // POST /api/chat in the same session is a 409; the find is a 200.
    const chat = await fetch(`${h.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: h.cookie },
      body: JSON.stringify({ message: "find me a phone stand" }),
    });
    assert.equal(chat.status, 409, "the paid path needs a key, which is the contrast that matters");

    const resp = await find(h, { query: "phone stand" });
    assert.equal(resp.status, 200);
  } finally {
    await h.close();
  }
});

test("a missing, empty or over-long query is a 400", async () => {
  const h = await harness();
  try {
    for (const body of [{}, { query: "" }, { query: "   " }, { query: "a".repeat(201) }, { query: 7 }]) {
      const resp = await find(h, body);
      assert.equal(resp.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const json = (await resp.json()) as { error: string };
      assert.match(json.error, /query/);
    }
    // 200 characters exactly is fine — the boundary is inclusive.
    assert.equal((await find(h, { query: "a".repeat(200) })).status, 200);
    // Nothing invalid reached the sourcing layer.
    assert.equal(h.sourcing.calls.length, 1);
  } finally {
    await h.close();
  }
});

test("the heavy tier refuses a burst, with the same code every other heavy route uses", async () => {
  // One call fans out to every model site, so it costs the owner bandwidth and
  // source quota even though it costs no tokens. It shares the `heavy` bucket
  // with slicing, importing and uploading.
  const h = await harness(2);
  try {
    assert.equal((await find(h, { query: "cube" })).status, 200);
    assert.equal((await find(h, { query: "cube" })).status, 200);
    const third = await find(h, { query: "cube" });
    assert.equal(third.status, 429);
    const json = (await third.json()) as { code?: string };
    assert.equal(json.code, "rate_limited");
  } finally {
    await h.close();
  }
});

test("a sourcing failure never forwards what the upstream said", async () => {
  const h = await harness();
  try {
    h.sourcing.searchModels = async () => {
      throw new Error("https://api.printables.com failed (500): <html>secret token abc123</html>");
    };
    const resp = await find(h, { query: "cube" });
    assert.equal(resp.status, 502);
    const json = (await resp.json()) as { error: string };
    assert.equal(json.error.includes("abc123"), false, "upstream bodies are not ours to forward");
    assert.equal(json.error.includes("printables.com"), false);
  } finally {
    await h.close();
  }
});
