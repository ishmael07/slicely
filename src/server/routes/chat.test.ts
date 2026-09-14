// Tests for POST /api/chat's SSE wire format and /api/chat/cancel — using an
// injected stub ChatAgent (see session.ts's ChatAgent + index.ts's
// chatAgentFactory option) so this never constructs a real SlicelyAgent,
// never touches the Anthropic SDK, and makes no network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../index";
import { SessionStore, type ChatAgent } from "../session";

// Chat requires the visitor's own Anthropic key (main/userkey.ts), so every
// test here connects one first through PUT /api/key with an INJECTED validator:
// still no network, no real key, and now the same path a real browser takes.
process.env.SLICELY_MODE = "hosted";
process.env.SLICELY_MASTER_KEY = randomBytes(32).toString("base64");
const TEST_KEY = "sk-ant-api03-" + "c".repeat(40);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "slicely-test-"));
}

/** Connect a key to a fresh session and return its cookie.
 *
 *  Two calls, because minting a workspace is its own step now: GET /api/config
 *  is the only endpoint that may create one (see session.ts's MINTING_ROUTES),
 *  and everything else — PUT /api/key included — is 401 `no_session` without a
 *  cookie. This is exactly the order the client boots in. */
async function connectKey(base: string): Promise<string> {
  const boot = await fetch(`${base}/api/config`);
  assert.equal(boot.status, 200);
  const raw = boot.headers.get("set-cookie");
  assert.ok(raw, "the boot call should mint a session cookie");
  const cookie = raw.split(";")[0];

  const resp = await fetch(`${base}/api/key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ apiKey: TEST_KEY }),
  });
  assert.equal(resp.status, 200);
  return cookie;
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

test("POST /api/chat streams well-formed SSE `data:` frames, in order, from the stubbed agent", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const stub: () => ChatAgent = () => ({
    async send(message, emit) {
      emit({ type: "text", text: `echo: ${message}` });
      emit({ type: "tool_start", tool: "search_models", label: "Searching…" });
      emit({ type: "tool_end", tool: "search_models", ok: true });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = await resp.text();
    const frames = body
      .split("\n\n")
      .map((f) => f.trim())
      .filter(Boolean);
    assert.ok(frames.length >= 4, `expected at least 4 SSE frames, got ${frames.length}: ${JSON.stringify(frames)}`);

    const events = frames.map((frame) => {
      assert.match(frame, /^data: /, `frame is not a well-formed SSE data line: ${frame}`);
      const parsed = JSON.parse(frame.slice("data: ".length)) as { type: string };
      assert.equal(typeof parsed.type, "string");
      return parsed.type;
    });
    assert.deepEqual(events, ["text", "tool_start", "tool_end", "done"]);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/chat/cancel reaches this session's own agent instance", async () => {
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  let cancelled = false;
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      emit({ type: "done" });
    },
    cancel() {
      cancelled = true;
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const first = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hi" }),
    });
    await first.text(); // drain the SSE stream before reusing the connection

    const cancelResp = await fetch(`${base}/api/chat/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(cancelResp.status, 200);
    assert.equal(cancelled, true);
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an action's server-side file becomes a download token, never a raw path", async () => {
  // "I opened it in PrusaSlicer" is only true for whoever is sitting at the
  // server. The browser gets a button instead — and it must point at a session
  // token, because a filesystem path from the server is both useless to the
  // browser and a disclosure of where files live.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const project = join(root, "plate-1.3mf");
  writeFileSync(project, "PKfake");

  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      emit({
        type: "action",
        label: "Open in PrusaSlicer",
        kind: "open-project",
        filePath: project,
        hint: "Downloads the plate.",
      });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });

  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "open it" }),
    });
    const body = await resp.text();
    const action = body
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)))
      .find((f) => f.type === "action");

    assert.ok(action, "the action must reach the browser");
    assert.equal(action.label, "Open in PrusaSlicer");
    assert.match(action.href, /^\/api\/gcode\/[0-9a-f]+$/, "must be a session token");
    assert.equal(action.filePath, undefined, "the server path must not be disclosed");
    assert.ok(!JSON.stringify(action).includes(root), "no server path anywhere in the frame");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second turn in the same tab is a 409 with code `busy`, distinguishable from no_key", async () => {
  // Both refusals are 409, so the CODE is the only thing telling the UI whether
  // to show the key card or simply wait and re-enable the composer.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      await new Promise((r) => setTimeout(r, 150));
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });
  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const post = () =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ message: "hi" }),
      });

    const first = post();
    // Let the first turn reach the handler and mark the session busy.
    await new Promise((r) => setTimeout(r, 40));
    const second = await post();

    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string; code?: string };
    assert.equal(body.code, "busy");

    await (await first).text(); // drain the streaming turn
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});

/** The smallest ASCII STL /api/preview can actually parse — the point of the
 *  preview assertion is that the relPath resolves and the file is read, so the
 *  mesh only has to be real, not interesting. */
const ONE_FACET_STL = [
  "solid cube",
  "  facet normal 0 0 1",
  "    outer loop",
  "      vertex 0 0 0",
  "      vertex 1 0 0",
  "      vertex 0 1 0",
  "    endloop",
  "  endfacet",
  "endsolid cube",
  "",
].join("\n");

test("a whole chat transcript for an uploaded file carries no absolute server path", async () => {
  // The scrub used to be per-event and per-field, so each new path-carrying
  // field shipped once before anybody noticed. This drives a turn that emits
  // every shape the agent actually produces — a `ModelInfo`, a sourcing
  // `DownloadResult` with parts, a `PrintJob`, a `JobEvent`, an `orientation`
  // pass, slice `metrics`, a slicer `status` — and asserts the answer as a
  // WHOLE contains no `/Users`, no `/tmp`, no `/private`, and not the workdir.
  //
  // It matters beyond the wire: routes/chat.ts persists the turn into
  // chats.json, so a leaked path is replayed to the browser on every reload of
  // that conversation for as long as it exists.
  const root = tmpRoot();
  const store = new SessionStore({ sessionsRoot: root, secretDir: root, sweepIntervalMs: 0 });

  // A real session directory, so the emitted paths are the ones production
  // would emit: `<sessionsRoot>/<id>/uploads/cube.stl` and friends.
  let sessionDir = "";
  const stub: () => ChatAgent = () => ({
    async send(_message, emit) {
      const upload = join(sessionDir, "uploads", "cube.stl");
      const part = join(sessionDir, "uploads", "kit", "part1.stl");
      const gcode = join(sessionDir, "slices", "plate-1.gcode");
      const project = join(sessionDir, "slices", "plate-1.3mf");
      writeFileSync(gcode, "G1 X0\n");
      writeFileSync(project, "PKfake");

      emit({ type: "info", info: { filePath: upload, sizeX: 20, sizeY: 20, sizeZ: 20, facets: 12 } });
      emit({
        type: "download",
        model: { id: "1", source: "thingiverse", title: "Cube", webUrl: "https://example.test/1" } as never,
        result: {
          localPath: upload,
          fileName: "cube.stl",
          sizeBytes: 684,
          parts: [{ localPath: part, fileName: "part1.stl", sizeBytes: 100, ext: ".stl" }],
        },
      });
      emit({ type: "orientation", partPath: upload, result: { keptAsImported: true } as never });
      emit({
        type: "job",
        job: {
          id: "job1",
          status: "ready",
          parts: [{ path: upload, name: "cube.stl", copies: 1, sizeX: 20, sizeY: 20, sizeZ: 20 }],
          plates: [{ index: 1, parts: [], gcodePath: gcode, projectPath: project }],
        } as never,
      });
      emit({
        type: "job_progress",
        event: {
          type: "plate_done",
          jobId: "job1",
          plateIndex: 1,
          metrics: { gcodePath: gcode, layerCount: 100 },
        } as never,
      });
      emit({ type: "metrics", metrics: { gcodePath: gcode, layerCount: 100 } });
      emit({
        type: "status",
        status: { installed: true, running: false, binaryPath: "/Applications/PrusaSlicer.app", appName: "PrusaSlicer" },
      });
      // A tool's exception, verbatim — which is how PrusaSlicer's stderr and
      // `G-code no longer exists at …` reach a browser inside a 200's stream.
      emit({ type: "tool_end", tool: "slice_model", ok: false, summary: `Cannot read ${upload}` });
      emit({ type: "error", message: `boom at ${gcode}` });
      emit({ type: "done" });
    },
    cancel() {
      /* not exercised in this test */
    },
  });

  const { base, close } = await listen(
    createApp({ sessionStore: store, chatAgentFactory: stub, keyValidator: async () => "ok" }),
  );
  try {
    const cookie = await connectKey(base);
    const id = cookie.split("=")[1].split(".")[0];
    const session = store.get(id)!;
    sessionDir = session.dir;
    writeFileSync(join(session.uploadsDir, "cube.stl"), ONE_FACET_STL);

    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "describe it" }),
    });
    const body = await resp.text();

    // The blunt assertion first: nothing in the whole answer looks like a path
    // on this machine.
    for (const needle of ["/Users", "/tmp", "/private", root, session.dir, session.id]) {
      assert.ok(!body.includes(needle), `the transcript leaks ${needle}:\n${body}`);
    }

    const events = body
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown> & { type: string });
    const byType = (t: string) => events.find((e) => e.type === t)!;

    // And then what each frame says INSTEAD, since "no path" would also be
    // satisfied by dropping the field the client needs.
    const info = byType("info").info as unknown as { relPath?: string; filePath?: string };
    assert.equal(info.relPath, "uploads/cube.stl", "the client feeds this straight to /api/preview");
    assert.equal(info.filePath, undefined);

    const dl = byType("download").result as unknown as {
      relPath?: string;
      localPath?: string;
      parts?: Array<{ relPath?: string; localPath?: string }>;
    };
    assert.equal(dl.relPath, "uploads/cube.stl");
    assert.equal(dl.localPath, undefined);
    assert.equal(dl.parts?.[0].relPath, "uploads/kit/part1.stl");
    assert.equal(dl.parts?.[0].localPath, undefined);

    const orient = byType("orientation") as unknown as { partRelPath?: string; partPath?: string };
    assert.equal(orient.partRelPath, "uploads/cube.stl");
    assert.equal(orient.partPath, undefined);

    const job = byType("job").job as unknown as {
      parts: Array<{ relPath?: string; path?: string }>;
      plates: Array<{ gcodePath?: string; projectPath?: string }>;
    };
    assert.equal(job.parts[0].relPath, "uploads/cube.stl");
    assert.equal(job.parts[0].path, undefined);
    assert.equal(job.plates[0].gcodePath, undefined, "an output is addressed by token");
    assert.equal(job.plates[0].projectPath, undefined);

    const progress = byType("job_progress").event as unknown as { metrics: { gcodePath?: string } };
    assert.equal(progress.metrics.gcodePath, undefined);

    const metrics = byType("metrics") as unknown as { gcodeId?: string; metrics: { gcodePath?: string } };
    assert.equal(metrics.metrics.gcodePath, undefined);
    assert.match(metrics.gcodeId ?? "", /^[0-9a-f]+$/, "the token is what replaces it");

    const status = byType("status").status as unknown as { binaryPath?: string; installed: boolean };
    assert.equal(status.installed, true);
    assert.equal(status.binaryPath, undefined, "where PrusaSlicer is installed is not the client's business");

    // Free prose that quotes a thrown Error is scrubbed the same way an HTTP
    // failure body is (errors.ts's stripPaths), not left verbatim.
    assert.equal((byType("tool_end") as unknown as { summary: string }).summary, "Cannot read <file>");
    assert.equal((byType("error") as unknown as { message: string }).message, "boom at <file>");

    // The relPath the `info` frame handed out has to be the one /api/preview
    // accepts back — otherwise the 3D viewer is broken by this very fix.
    const preview = await fetch(
      `${base}/api/preview?path=${encodeURIComponent(info.relPath!)}`,
      { headers: { cookie } },
    );
    const previewBody = await preview.text();
    assert.equal(preview.status, 200, previewBody);
    const mesh = JSON.parse(previewBody) as { triangles: number };
    assert.equal(typeof mesh.triangles, "number");
  } finally {
    await close();
    store.stopSweep();
    rmSync(root, { recursive: true, force: true });
  }
});
