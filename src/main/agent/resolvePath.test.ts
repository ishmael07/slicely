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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigForTests } from "../config";
import {
  DEFAULT_SESSION_ID,
  isInsideSessionWorkspace,
  runInSession,
  sessionContext,
} from "../session-context";
// The same hook printers/util.ts re-exports; both guards now share one root.
import { setVolumesRootForTests } from "../paths";
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
  // realpathSync'd up front: tmpdir() sits behind macOS's own symlinks
  // (/var -> /private/var), and the guards answer with the REAL path, so an
  // unresolved root would make every "returns the path unchanged" assertion
  // compare two spellings of the same file and fail for the wrong reason.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slicely-workspace-")));
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

test("the guard hands back the path it actually checked, symlinks resolved", async () => {
  // A symlink INSIDE the workspace pointing at another file inside it is
  // allowed — but the caller must open the file that was checked, not re-do
  // the resolution itself at open() time.
  const { dirA, cleanup } = workspaces();
  try {
    const real = join(dirA, "uploads", "x.stl");
    const alias = join(dirA, "uploads", "alias.stl");
    symlinkSync(real, alias);
    await withMode("hosted", () =>
      runInSession(sessionContext("aaaa", dirA), () => {
        assert.equal(assertWorkspacePath(alias), real);
      }),
    );
  } finally {
    cleanup();
  }
});

test("hosted: plan_job's REMEMBERED parts are checked, not trusted for being remembered", async () => {
  // plan_job with no `parts` falls back to whatever split_model last recorded.
  // That list is still just strings on a session record, so it goes through the
  // same guard as an argument the model typed this turn.
  const { dirA, outside, cleanup } = workspaces();
  try {
    await withMode("hosted", () =>
      runInSession(sessionContext("plan-fallback", dirA), async () => {
        sessionState.lastModelParts = [join(dirA, "uploads", "x.stl"), join(outside, "secret.stl")];
        await assert.rejects(() => executeV2Tool("plan_job", {}, () => {}), isOutsideWorkspace);
      }),
    );
  } finally {
    cleanup();
  }
});

test("hosted: the DEFAULT session is not a workspace — it fails closed, not open", async () => {
  // `currentSession()` falls back to the default session for anything running
  // outside runInSession, and the default session's directory is the WHOLE
  // workdir: it contains every visitor's `sessions/<id>` and the
  // `.session-secret` that signs their cookies. A hosted code path that forgot
  // to establish a session must therefore reach nothing at all, rather than
  // quietly being handed the lot.
  const { root, dirA, cleanup } = workspaces();
  const prevWorkdir = process.env.SLICELY_WORKDIR;
  process.env.SLICELY_WORKDIR = root;
  resetConfigForTests();
  try {
    await withMode("hosted", () => {
      const workdir = getConfig().workdir;

      // No ambient session at all.
      assert.equal(isInsideSessionWorkspace(join(workdir, ".session-secret")), false);
      assert.equal(isInsideSessionWorkspace(join(workdir, "jobs.json")), false);
      assert.equal(isInsideSessionWorkspace(join(dirA, "uploads", "x.stl")), false);
      assert.throws(() => assertWorkspacePath(join(dirA, "uploads", "x.stl")), isOutsideWorkspace);

      // And the same when the default session is established explicitly.
      runInSession(sessionContext(DEFAULT_SESSION_ID), () => {
        assert.equal(isInsideSessionWorkspace(join(workdir, ".session-secret")), false);
        assert.equal(isInsideSessionWorkspace(join(dirA, "uploads", "x.stl")), false);
      });

      // A REAL session still works — this is a fail-closed default, not a ban.
      runInSession(sessionContext("aaaa", dirA), () => {
        assert.equal(isInsideSessionWorkspace(join(dirA, "uploads", "x.stl")), true);
      });
    });
  } finally {
    if (prevWorkdir === undefined) delete process.env.SLICELY_WORKDIR;
    else process.env.SLICELY_WORKDIR = prevWorkdir;
    resetConfigForTests();
    cleanup();
  }
});

test("desktop: your own files are yours, but hidden folders are still not models", async () => {
  // `$HOME` is a workspace root on the desktop, which would otherwise make
  // `~/.ssh/id_rsa` a file the model can ask to have inspected or sliced — and
  // the desktop's default session directory IS the workdir, where the
  // cookie-signing secret lives.
  const { dirA, cleanup } = workspaces();
  try {
    await withMode("desktop", () =>
      runInSession(sessionContext("desktop-hidden", dirA), () => {
        assert.equal(isInsideSessionWorkspace(join(homedir(), "Documents", "bracket.stl")), true);
        assert.equal(isInsideSessionWorkspace(join(dirA, "uploads", "x.stl")), true);

        for (const hidden of [
          join(homedir(), ".ssh", "id_rsa"),
          join(homedir(), ".aws", "credentials"),
          join(homedir(), ".config", "anything"),
          join(homedir(), "Documents", ".hidden", "x.stl"),
          join(dirA, ".session-secret"),
        ]) {
          assert.equal(isInsideSessionWorkspace(hidden), false, `must be unreachable: ${hidden}`);
        }
        assert.throws(() => assertWorkspacePath(join(homedir(), ".ssh", "id_rsa")), isOutsideWorkspace);
      }),
    );
  } finally {
    cleanup();
  }
});

test("desktop: a mounted drive is part of the workspace; a symlink out of one is not", async () => {
  // An SD card or external SSD is where a lot of people keep their models, and
  // /Volumes is where macOS mounts them. Containment is decided on the REAL
  // path, exactly as assertAllowedOutputDir decides it, so `/Volumes/Macintosh
  // HD/etc/passwd` — a symlink to `/` on every real Mac — cannot ride in.
  const { dirA, outside, cleanup } = workspaces();
  const volumes = realpathSync(mkdtempSync(join(tmpdir(), "slicely-fake-volumes-")));
  setVolumesRootForTests(volumes);
  try {
    const card = join(volumes, "SDCARD");
    mkdirSync(card, { recursive: true });
    writeFileSync(join(card, "part.stl"), "solid p\nendsolid p\n");
    symlinkSync(outside, join(volumes, "escape"));

    await withMode("desktop", () =>
      runInSession(sessionContext("desktop-volumes", dirA), () => {
        assert.equal(isInsideSessionWorkspace(join(card, "part.stl")), true);
        assert.equal(assertWorkspacePath(join(card, "part.stl")), join(card, "part.stl"));
        // Filesystem bookkeeping on the card is hidden, same rule as $HOME.
        assert.equal(isInsideSessionWorkspace(join(card, ".Trashes", "part.stl")), false);
        // The "Macintosh HD" case: named under /Volumes, actually elsewhere.
        assert.equal(isInsideSessionWorkspace(join(volumes, "escape", "secret.stl")), false);
      }),
    );

    await withMode("hosted", () =>
      runInSession(sessionContext("hosted-volumes", dirA), () => {
        assert.equal(
          isInsideSessionWorkspace(join(card, "part.stl")),
          false,
          "a shared server has no SD card of yours to read",
        );
      }),
    );
  } finally {
    setVolumesRootForTests(undefined);
    rmSync(volumes, { recursive: true, force: true });
    cleanup();
  }
});
