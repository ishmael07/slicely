// The whole bring-your-own-key surface, end to end over HTTP: PUT/DELETE
// /api/key, what GET /api/config tells the client, DELETE /api/session, and
// what POST /api/chat does before a key exists.
//
// The Anthropic validation call is INJECTED (createApp's `keyValidator`), so
// these tests never touch the network and never need a real key. The chat agent
// is stubbed for the same reason — see chat.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

// Hosted mode with a real master key: the key is encrypted at rest, so the
// vault must be able to load one.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");

// The developer's own .env (loaded by config.ts) may carry a provider key and
// the operator flag; a hosted-mode test must never see either. A real
// OPENAI_API_KEY in particular must never be reachable from a test.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SLICELY_ALLOW_OPERATOR_KEY;

const GOOD_KEY = "sk-ant-api03-" + "k".repeat(40);
const OAT_TOKEN = "sk-ant-oat01-" + "k".repeat(40);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-key-"));
}

const stubAgent: () => ChatAgent = () => ({
  async send(_message, emit) {
    emit({ type: "done" });
  },
  cancel() {
    /* not exercised here */
  },
});

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The `name=value` half of a Set-Cookie, ready to send back as `cookie`. */
function cookieOf(resp: Response): string {
  const raw = resp.headers.get("set-cookie");
  assert.ok(raw, "expected a session cookie");
  return raw.split(";")[0];
}

/** Boot a session the way the client does: GET /api/config is the one call that
 *  may mint a workspace (see session.ts's MINTING_ROUTES), and everything else
 *  is 401 `no_session` until its cookie is in hand. */
async function boot(base: string): Promise<string> {
  const resp = await fetch(`${base}/api/config`);
  assert.equal(resp.status, 200);
  return cookieOf(resp);
}

test("a badly-shaped key is refused with a code the UI can branch on, and nothing is stored", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const bad = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: "not-a-key" }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code?: string }).code, "key_invalid_format");

    // A Claude Pro/Max subscription token is refused the same way: it is not an
    // API key, and Anthropic's terms forbid using one here.
    const oat = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: OAT_TOKEN }),
    });
    assert.equal(oat.status, 400);
    assert.equal(((await oat.json()) as { code?: string }).code, "key_invalid_format");

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    const body = (await cfg.json()) as { hasKey: boolean; keyHint?: string; mode: string };
    assert.equal(body.hasKey, false);
    assert.equal(body.keyHint, undefined);
    assert.equal(body.mode, "hosted");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a well-formed key Anthropic rejects is not stored either", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "rejected" }),
  );
  try {
    const cookie = await boot(base);
    const resp = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(resp.status, 401);
    assert.equal(((await resp.json()) as { code?: string }).code, "key_rejected");

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(((await cfg.json()) as { hasKey: boolean }).hasKey, false);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted key is connected, reported only as a hint, and never echoed back", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(put.status, 200);
    const putText = await put.text();
    const putBody = JSON.parse(putText) as { hasKey: boolean; keyHint?: string };
    assert.equal(putBody.hasKey, true);
    assert.equal(putBody.keyHint, "…" + GOOD_KEY.slice(-4));

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    const cfgText = await cfg.text();
    const cfgBody = JSON.parse(cfgText) as { hasKey: boolean; keyHint?: string; version: string; sourceCommit: string };
    assert.equal(cfgBody.hasKey, true);
    assert.equal(cfgBody.keyHint, "…" + GOOD_KEY.slice(-4));
    assert.equal(typeof cfgBody.version, "string");
    assert.ok(cfgBody.sourceCommit.length > 0);

    // The one rule this whole module exists to keep.
    assert.ok(!putText.includes(GOOD_KEY), "PUT /api/key must not echo the key");
    assert.ok(!cfgText.includes(GOOD_KEY), "GET /api/config must not echo the key");

    // A second visitor (no cookie) gets their own empty session.
    const other = await fetch(`${base}/api/config`);
    const otherText = await other.text();
    assert.equal((JSON.parse(otherText) as { hasKey: boolean }).hasKey, false);
    assert.ok(!otherText.includes(GOOD_KEY), "another session must never see the key");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /api/key disconnects it; DELETE /api/session takes the workspace with it", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(put.status, 200);
    const sid = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    const dir = store.get(sid)?.dir;
    assert.ok(dir && existsSync(dir), "the session should own a directory on disk");

    const del = await fetch(`${base}/api/key`, { method: "DELETE", headers: { cookie } });
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as { hasKey: boolean }).hasKey, false);

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(((await cfg.json()) as { hasKey: boolean }).hasKey, false);

    const gone = await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie } });
    assert.equal(gone.status, 204);
    assert.match(gone.headers.get("set-cookie") ?? "", /Max-Age=0/, "the cookie must be cleared too");
    assert.equal(store.get(sid), undefined, "the session record is gone");
    assert.equal(existsSync(dir!), false, "and so is everything it stored");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing the key drops the agent built from the old one", async () => {
  // Without this, re-keying after a rejection looks like it worked and then
  // fails on every turn: the session's agent still holds an Anthropic client
  // constructed from the key that was replaced.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  let built = 0;
  const counting: () => ChatAgent = () => {
    built += 1;
    return stubAgent();
  };
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: counting, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    assert.equal(
      (
        await fetch(`${base}/api/key`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ apiKey: GOOD_KEY }),
        })
      ).status,
      200,
    );
    const chat = async () => {
      const resp = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
      });
      await resp.text();
    };

    await chat();
    assert.equal(built, 1);
    await chat();
    assert.equal(built, 1, "the same session reuses its agent");

    const rekey = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: "sk-ant-api03-" + "z".repeat(40) }),
    });
    assert.equal(rekey.status, 200);
    await chat();
    assert.equal(built, 2, "a new key must produce a new agent");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no API response is cacheable — a proxy must never hand one visitor's key state to another", async () => {
  // /api/config carries THIS session's hasKey/keyHint on a plain GET of a shared
  // URL. A CDN in front of the hosted deploy would happily cache the first
  // answer and serve it to the next visitor.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const put = await fetch(`${base}/api/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ apiKey: GOOD_KEY }),
    });
    assert.equal(put.headers.get("cache-control"), "no-store");

    const cfg = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(cfg.headers.get("cache-control"), "no-store");

    const del = await fetch(`${base}/api/key`, { method: "DELETE", headers: { cookie } });
    assert.equal(del.headers.get("cache-control"), "no-store");

    // Not just these three routes: the whole /api surface is per-session.
    const settings = await fetch(`${base}/api/settings`, { headers: { cookie } });
    assert.equal(settings.headers.get("cache-control"), "no-store");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat with no key is a 409 with code no_key — answered BEFORE any SSE headers", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(resp.status, 409);
    assert.match(resp.headers.get("content-type") ?? "", /application\/json/);
    const body = (await resp.json()) as { error: string; code?: string };
    assert.equal(body.code, "no_key");
    assert.ok(!/\.env/.test(body.error), "no talk of files the user cannot see");

    // With a key connected, the same request streams as usual — same session.
    assert.equal(
      (
        await fetch(`${base}/api/key`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ apiKey: GOOD_KEY }),
        })
      ).status,
      200,
    );
    const ok = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/event-stream/);
    await ok.text();
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── two providers over HTTP ──────────────────────────────────────────────────

const OPENAI_KEY = "sk-proj-" + "o".repeat(40);

test("PUT /api/key takes a provider, and each provider's format is judged by its own rules", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const asked: string[] = [];
  const { base, close } = await listen(
    createApp({
      sessionStore: store,
      chatAgentFactory: stubAgent,
      keyValidator: async (provider) => {
        asked.push(provider);
        return "ok";
      },
    }),
  );
  try {
    const cookie = await boot(base);
    const put = (body: unknown) =>
      fetch(`${base}/api/key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    // An OpenAI key in the OpenAI card: accepted, and validated against OpenAI.
    const openai = await put({ provider: "openai", apiKey: OPENAI_KEY });
    assert.equal(openai.status, 200);
    const openaiBody = (await openai.json()) as { hasKey: boolean; provider: string; keyHint: string };
    assert.equal(openaiBody.provider, "openai");
    assert.equal(openaiBody.keyHint, "…" + OPENAI_KEY.slice(-4));
    assert.deepEqual(asked, ["openai"], "the right provider was asked to check it");

    // The same key in the Anthropic card is refused on format alone — no call.
    const wrongCard = await put({ provider: "anthropic", apiKey: OPENAI_KEY });
    assert.equal(wrongCard.status, 400);
    assert.equal(((await wrongCard.json()) as { code?: string }).code, "key_invalid_format");
    assert.deepEqual(asked, ["openai"], "a badly-shaped key is never sent upstream");

    // And an Anthropic key in the OpenAI card is named as such.
    const swapped = await put({ provider: "openai", apiKey: GOOD_KEY });
    assert.equal(swapped.status, 400);
    assert.match(((await swapped.json()) as { error: string }).error, /Anthropic/);

    // An unknown provider is a 400, not a silently-defaulted anthropic write.
    const bogus = await put({ provider: "acme", apiKey: GOOD_KEY });
    assert.equal(bogus.status, 400);

    // NO PROVIDER FIELD = anthropic: every client written before OpenAI existed
    // sends none, and this endpoint was Anthropic-only then.
    const legacy = await put({ apiKey: GOOD_KEY });
    assert.equal(legacy.status, 200);
    assert.equal(((await legacy.json()) as { provider: string }).provider, "anthropic");
    assert.deepEqual(asked, ["openai", "anthropic"]);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/api/config lists both providers, with a hint only for the key that would pay", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const config = async () => {
      const resp = await fetch(`${base}/api/config`, { headers: { cookie } });
      return (await resp.json()) as {
        hasKey: boolean;
        keyHint?: string;
        providers: Array<{ id: string; label: string; hasKey: boolean; keyHint?: string }>;
      };
    };

    const fresh = await config();
    assert.deepEqual(
      fresh.providers.map((p) => [p.id, p.hasKey]),
      [
        ["anthropic", false],
        ["openai", false],
      ],
    );
    assert.equal(fresh.hasKey, false);

    // Connect ONLY an OpenAI key. `hasKey` is true — a user with one key is not a
    // user without a key — but the default model is still an Anthropic one, so
    // there is no hint for the key that would actually pay for the next message.
    assert.equal(
      (
        await fetch(`${base}/api/key`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ provider: "openai", apiKey: OPENAI_KEY }),
        })
      ).status,
      200,
    );
    const withOpenai = await config();
    assert.equal(withOpenai.hasKey, true);
    assert.equal(withOpenai.keyHint, undefined);
    assert.equal(withOpenai.providers.find((p) => p.id === "openai")?.hasKey, true);
    assert.equal(withOpenai.providers.find((p) => p.id === "openai")?.keyHint, "…" + OPENAI_KEY.slice(-4));
    assert.equal(withOpenai.providers.find((p) => p.id === "anthropic")?.hasKey, false);

    // Switching to an OpenAI model makes that the key that pays.
    const patch = await fetch(`${base}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ model: "gpt-5.6-terra" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await config()).keyHint, "…" + OPENAI_KEY.slice(-4));
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("choosing a model whose provider has no key is a 409 no_key that names the provider", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    assert.equal(
      (
        await fetch(`${base}/api/key`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ apiKey: GOOD_KEY }),
        })
      ).status,
      200,
    );

    const refused = await fetch(`${base}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ model: "gpt-6-astra" }),
    });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string; code?: string };
    assert.equal(body.code, "no_key");
    assert.match(body.error, /OpenAI/, "the user has to be told WHICH key is missing");

    // The choice was not saved, and every model says which provider it needs.
    const settings = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as {
      current: { model: string };
      models: Array<{ id: string; provider: string }>;
    };
    assert.match(settings.current.model, /^claude-/);
    assert.equal(settings.models.find((m) => m.id === "gpt-6-astra")?.provider, "openai");
    assert.equal(settings.models.find((m) => m.id === "claude-opus-4-8")?.provider, "anthropic");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /api/key disconnects the provider it is told about, and only that one", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    for (const body of [{ apiKey: GOOD_KEY }, { provider: "openai", apiKey: OPENAI_KEY }]) {
      assert.equal(
        (
          await fetch(`${base}/api/key`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify(body),
          })
        ).status,
        200,
      );
    }

    // A query parameter, for clients that would rather not send a DELETE body.
    const del = await fetch(`${base}/api/key?provider=openai`, { method: "DELETE", headers: { cookie } });
    assert.equal(del.status, 200);
    const delBody = (await del.json()) as { hasKey: boolean; provider: string };
    assert.equal(delBody.provider, "openai");
    // `hasKey` answers the same question /api/config does — "any key at all" —
    // so disconnecting one of two must not read as "you have no key".
    assert.equal(delBody.hasKey, true);

    const config = (await (await fetch(`${base}/api/config`, { headers: { cookie } })).json()) as {
      providers: Array<{ id: string; hasKey: boolean }>;
    };
    assert.equal(config.providers.find((p) => p.id === "openai")?.hasKey, false);
    assert.equal(config.providers.find((p) => p.id === "anthropic")?.hasKey, true);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/api/config ships each provider's key-card copy, so the client keeps no second table", async () => {
  // The web client used to carry its own copy of every label, placeholder,
  // console URL and refusal message. Two tables for one truth: a corrected
  // console URL in provider-openai.ts would leave the card pointing at the old
  // one. The server owns the copy now.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stubAgent, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await boot(base);
    const config = (await (await fetch(`${base}/api/config`, { headers: { cookie } })).json()) as {
      providers: Array<{
        id: string;
        label: string;
        keyHelp?: { label: string; placeholder: string; consoleUrl: string; consoleLabel: string; formatMessage: string };
      }>;
    };

    const openai = config.providers.find((p) => p.id === "openai");
    assert.ok(openai?.keyHelp, "the OpenAI card's copy comes over the wire");
    assert.equal(openai.keyHelp.label, "OpenAI API key");
    assert.equal(openai.keyHelp.placeholder, "sk-…");
    assert.match(openai.keyHelp.consoleUrl, /^https:\/\/platform\.openai\.com/);
    assert.equal(openai.keyHelp.consoleLabel, "platform.openai.com/api-keys");
    // The sentence for a paste that is not recognised at all — which is the one
    // the client needs when it refuses locally, before any request.
    assert.match(openai.keyHelp.formatMessage, /doesn't look like an OpenAI API key/);

    const anthropic = config.providers.find((p) => p.id === "anthropic");
    assert.equal(anthropic?.keyHelp?.label, "Anthropic API key");
    assert.equal(anthropic?.keyHelp?.placeholder, "sk-ant-…");
    assert.match(anthropic?.keyHelp?.formatMessage ?? "", /sk-ant-api/);

    // A key itself is never described here, in either direction.
    const raw = JSON.stringify(config);
    assert.doesNotMatch(raw, /sk-ant-api03|sk-proj-o/);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
