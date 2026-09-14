// ─────────────────────────────────────────────────────────────────────────────
// Task D5: every path the AGENT is handed stays inside the workspace.
//
// The model chooses these strings. `slice_model {"path": "/etc/passwd"}` is one
// token away at all times, and in hosted mode a path is also how one visitor
// would reach ANOTHER visitor's session directory — the ids are in the same
// parent folder. So the tools do not trust a path; they resolve it and check
// containment, and that check is what these tests pin.
//
// Hermetic: temp session directories, no PrusaSlicer, no network. Every test
// removes what it created.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigForTests } from "../config";
import { isInsideSessionWorkspace, runInSession, sessionContext } from "../session-context";
import { sessionState } from "./state";
import { resolvePathForTests } from "./tools";
import { assertWorkspacePath, executeV2Tool } from "./tools-v2";

function isOutsideWorkspace(err: unknown): true {
  const e = err as { code?: string; message?: string };
  assert.equal(e.code, "not_in_workspace", `expected not_in_workspace, got ${e.code}: ${e.message}`);
  assert.ok(!/\/(?:private|var|tmp|Users|etc)\//.test(e.message ?? ""), "the refusal must not quote a server path");
  return true;
}

/** Run `fn` with SLICELY_MODE pinned, restoring whatever was there. */
async function withMode<T>(mode: "hosted" | "desktop", fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
}

/** Two session workspaces side by side, exactly as the hosted server lays them
 *  out (`<workdir>/sessions/<id>`), plus a directory outside both. */
function workspaces(): { root: string; dirA: string; dirB: string; outside: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "slicely-workspace-"));
  const dirA = join(root, "sessions", "aaaa");
  const dirB = join(root, "sessions", "bbbb");
  const outside = join(root, "outside");
  for (const d of [join(dirA, "uploads"), join(dirB, "uploads"), outside]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(dirA, "uploads", "x.stl"), "solid x\nendsolid x\n");
  writeFileSync(join(dirB, "uploads", "x.stl"), "solid x\nendsolid x\n");
  writeFileSync(join(outside, "secret.stl"), "solid s\nendsolid s\n");
  return { root, dirA, dirB, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("hosted: resolvePath accepts this session's files and refuses every other path", async () => {
  const { dirA, dirB, cleanup } = workspaces();
  try {
    await withMode("hosted", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        const mine = join(dirA, "uploads", "x.stl");
        assert.equal(resolvePathForTests(mine), mine, "a file in my own workspace is returned unchanged");

        // The neighbour's workspace: a real, readable file — and not mine.
        assert.throws(() => resolvePathForTests(join(dirB, "uploads", "x.stl")), isOutsideWorkspace);
        assert.throws(() => resolvePathForTests("/etc/passwd"), isOutsideWorkspace);
        // Traversal out and back in under a sibling name.
        assert.throws(() => resolvePathForTests(join(dirA, "..", "bbbb", "uploads", "x.stl")), isOutsideWorkspace);
        // Home is NOT a workspace on a shared server.
        assert.throws(() => resolvePathForTests(join(homedir(), "Documents", "x.stl")), isOutsideWorkspace);
      }),
    );
  } finally {
    cleanup();
  }
});

test("hosted: with no path argument the active model is used — and it is checked too", async () => {
  const { dirA, dirB, cleanup } = workspaces();
  try {
    await withMode("hosted", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        const mine = join(dirA, "uploads", "x.stl");
        sessionState.lastModelPath = mine;
        assert.equal(resolvePathForTests(undefined), mine);

        // A remembered path is still only a path: if it points out of the
        // workspace it is refused rather than trusted for being remembered.
        sessionState.lastModelPath = join(dirB, "uploads", "x.stl");
        assert.throws(() => resolvePathForTests(undefined), isOutsideWorkspace);

        sessionState.lastModelPath = "";
        assert.throws(() => resolvePathForTests(undefined), /No model file available/);
      }),
    );
  } finally {
    cleanup();
  }
});

test("hosted: a symlink planted inside the workspace does not lead out of it", async () => {
  const { dirA, outside, cleanup } = workspaces();
  try {
    // A zip entry, or any other writer inside the workspace, could leave this
    // behind. Containment on the resolved path is what stops it.
    symlinkSync(join(outside, "secret.stl"), join(dirA, "uploads", "link.stl"));
    await withMode("hosted", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        assert.throws(() => resolvePathForTests(join(dirA, "uploads", "link.stl")), isOutsideWorkspace);
      }),
    );
  } finally {
    cleanup();
  }
});

test("desktop: the user's own downloads folder and home directory are part of the workspace", async () => {
  const { dirA, outside, cleanup } = workspaces();
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.SLICELY_WORKDIR = join(outside, "Slicely-data");
  resetConfigForTests();
  try {
    const downloaded = join(getConfig().downloadsDir, "thing-1", "part.stl");
    const inHome = join(homedir(), "Desktop", "part.stl");

    await withMode("desktop", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        assert.equal(isInsideSessionWorkspace(join(dirA, "uploads", "x.stl")), true);
        assert.equal(isInsideSessionWorkspace(downloaded), true, "the app's own downloads are the user's files");
        assert.equal(isInsideSessionWorkspace(inHome), true, "on your own Mac, your home folder is yours");
        assert.equal(isInsideSessionWorkspace("/etc/passwd"), false, "even on a Mac, not the system");
      }),
    );

    await withMode("hosted", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        assert.equal(isInsideSessionWorkspace(downloaded), false, "a shared server has no user home to trust");
        assert.equal(isInsideSessionWorkspace(inHome), false);
      }),
    );
  } finally {
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    cleanup();
  }
});

test("the v2 tools that take a path refuse one outside the workspace", async () => {
  const { dirA, outside, cleanup } = workspaces();
  const stray = join(outside, "secret.stl");
  try {
    await withMode("hosted", async () => {
      await runInSession(sessionContext("aaaa", dirA), async () => {
        const emit = (): void => {};
        await assert.rejects(() => executeV2Tool("split_model", { path: stray }, emit), isOutsideWorkspace);
        await assert.rejects(() => executeV2Tool("choose_orientation", { path: stray }, emit), isOutsideWorkspace);
        await assert.rejects(
          () => executeV2Tool("plan_job", { parts: [{ path: stray, copies: 1 }] }, emit),
          isOutsideWorkspace,
        );
        // The shared guard itself, for the tools whose earlier checks (a
        // printer must exist at all) would otherwise answer first.
        assert.throws(() => assertWorkspacePath(join(outside, "plate-1.gcode")), isOutsideWorkspace);
        assert.equal(
          assertWorkspacePath(join(dirA, "slices", "plate-1.gcode")),
          join(dirA, "slices", "plate-1.gcode"),
        );
      });
    });
  } finally {
    cleanup();
  }
});
