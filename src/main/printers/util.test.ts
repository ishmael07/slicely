import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  normalizeColourHex,
  describeError,
  safeJobName,
  assertAllowedOutputDir,
  setVolumesRootForTests,
} from "./util";
import { WireError } from "../../server/errors";

/** Run `fn` with SLICELY_MODE forced, restoring it afterwards — mode.ts reads
 *  the variable fresh on every call, which is exactly why it can be flipped. */
function inMode<T>(mode: "hosted" | "desktop", fn: () => T): T {
  const prev = process.env.SLICELY_MODE;
  process.env.SLICELY_MODE = mode;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SLICELY_MODE;
    else process.env.SLICELY_MODE = prev;
  }
}

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

// ── safeJobName: a job name is a FILENAME, never a path (Task D2) ────────────

test("safeJobName reduces a traversal attempt to a plain filename", () => {
  assert.equal(safeJobName("../../authorized_keys", "x.gcode"), "authorized_keys.gcode");
  assert.equal(safeJobName("/etc/cron.d/evil", "x.gcode"), "evil.gcode");
  // Windows-style separators too: the printer (or folder) may well be elsewhere.
  assert.equal(safeJobName("..\\..\\boot.ini", "x.gcode"), "boot.ini.gcode");
});

test("safeJobName strips control characters", () => {
  assert.equal(safeJobName("a\tb.gcode", "x"), "ab.gcode");
  assert.equal(safeJobName("dro\u0000p.gcode", "x"), "drop.gcode");
  assert.equal(safeJobName("line\nbreak.gcode", "x"), "linebreak.gcode");
});

test("safeJobName keeps the printable extensions and appends .gcode otherwise", () => {
  assert.equal(safeJobName("bracket.gcode", "x.gcode"), "bracket.gcode");
  assert.equal(safeJobName("bracket.bgcode", "x.gcode"), "bracket.bgcode");
  assert.equal(safeJobName("bracket.3mf", "x.gcode"), "bracket.3mf");
  assert.equal(safeJobName("bracket.exe", "x.gcode"), "bracket.exe.gcode");
  assert.equal(safeJobName("bracket", "x.gcode"), "bracket.gcode");
});

test("safeJobName falls back for an empty or meaningless name, and caps the length", () => {
  assert.equal(safeJobName("", "fallback.gcode"), "fallback.gcode");
  assert.equal(safeJobName(undefined, "fallback.gcode"), "fallback.gcode");
  assert.equal(safeJobName("   ", "fallback.gcode"), "fallback.gcode");
  assert.equal(safeJobName("..", "fallback.gcode"), "fallback.gcode");
  assert.equal(safeJobName("/", "fallback.gcode"), "fallback.gcode");

  const long = safeJobName("z".repeat(400) + ".gcode", "x.gcode");
  assert.ok(long.length <= 120, `expected <=120 chars, got ${long.length}`);
  assert.ok(long.endsWith(".gcode"), "the extension survives the truncation");
});

// ── assertAllowedOutputDir: only where a person could have meant (Task D2) ───

test("assertAllowedOutputDir refuses the whole transport in hosted mode", () => {
  inMode("hosted", () => {
    for (const dir of [join(homedir(), "Desktop"), "/tmp", homedir()]) {
      assert.throws(
        () => assertAllowedOutputDir(dir),
        (err: unknown) => {
          assert.ok(err instanceof WireError);
          assert.equal(err.status, 403);
          assert.equal(err.code, "forbidden_in_hosted_mode");
          return true;
        },
        `hosted mode must refuse ${dir}`,
      );
    }
  });
});

test("assertAllowedOutputDir accepts a folder in the user's home in desktop mode", () => {
  inMode("desktop", () => {
    const desktop = join(homedir(), "Desktop");
    assert.equal(assertAllowedOutputDir(desktop), desktop);
    assert.equal(assertAllowedOutputDir(join(homedir(), "Prints", "tonight")), join(homedir(), "Prints", "tonight"));
    // Resolved, so a traversal that lands back inside home is normalised, not a
    // second spelling of an allowed path.
    assert.equal(assertAllowedOutputDir(`${homedir()}/Prints/../Prints/`), join(homedir(), "Prints"));
  });
});

test("assertAllowedOutputDir refuses dot-directories and anything outside home", () => {
  inMode("desktop", () => {
    for (const dir of [
      join(homedir(), ".ssh"), // credentials
      join(homedir(), ".config", "anything"), // app config
      join(homedir(), "Prints", ".hidden"), // a dot segment anywhere
      "/etc",
      "/",
      join(homedir(), "..", "someone-else"),
      "relative/not/absolute",
    ]) {
      assert.throws(() => assertAllowedOutputDir(dir), WireError, `must refuse ${dir}`);
    }
  });
});

// ── /Volumes: the "Folder / SD card" transport's other real use ─────────────
// A card reader mounts outside $HOME, so it needs its own allowance — see the
// function's doc comment. These tests must not depend on any actual USB stick
// or SD card being plugged into the machine running them.

test("assertAllowedOutputDir rejects a traversal that resolves outside /Volumes", () => {
  // Pure path-string case: path.resolve collapses the ".." before this
  // function ever touches the filesystem, so "/Volumes/../etc" is refused as
  // plain "/etc" — outside both $HOME and /Volumes — with today's usual code,
  // never treated as an escaped-but-real volume path.
  inMode("desktop", () => {
    assert.throws(
      () => assertAllowedOutputDir("/Volumes/../etc"),
      (err: unknown) => {
        assert.ok(err instanceof WireError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "not_in_workspace");
        return true;
      },
    );
  });
});

test("assertAllowedOutputDir rejects a /Volumes path with nothing mounted there", () => {
  inMode("desktop", () => {
    assert.throws(
      () => assertAllowedOutputDir("/Volumes/slicely-test-definitely-not-mounted"),
      (err: unknown) => {
        assert.ok(err instanceof WireError);
        assert.equal(err.code, "not_in_workspace");
        return true;
      },
      "a path under /Volumes that doesn't resolve to a real directory must still be refused",
    );
  });
});

// A fake /Volumes root, standing in for the real one so these tests never
// depend on what's actually mounted (and never need write access to the real
// /Volumes, which an ordinary user doesn't have). realpathSync'd up front so
// the root itself is already fully resolved — tmpdir() sits behind macOS's own
// symlinks (/var -> /private/var), and if VOLUMES_ROOT weren't resolved first,
// realpathSync(target) inside assertAllowedOutputDir would resolve THOSE too
// and no longer appear to start with the unresolved root, breaking even the
// "plain real subdirectory" case.
function withFakeVolumesRoot(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slicely-fake-volumes-")));
  setVolumesRootForTests(root);
  try {
    fn(root);
  } finally {
    setVolumesRootForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test("assertAllowedOutputDir accepts a real directory under a /Volumes-like root", () => {
  withFakeVolumesRoot((root) => {
    const target = join(root, "SDCARD");
    mkdirSync(target);
    inMode("desktop", () => {
      assert.equal(assertAllowedOutputDir(target), target);
    });
  });
});

test("assertAllowedOutputDir rejects a symlink under the volumes root that points outside it", () => {
  withFakeVolumesRoot((root) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "slicely-outside-volumes-")));
    try {
      const escape = join(root, "escape");
      symlinkSync(outside, escape);
      inMode("desktop", () => {
        assert.throws(
          () => assertAllowedOutputDir(escape),
          (err: unknown) => {
            assert.ok(err instanceof WireError);
            assert.equal(err.status, 403);
            assert.equal(err.code, "not_in_workspace");
            return true;
          },
          "a symlink whose target resolves outside the volumes root must be refused even though the typed path is 'under' it",
        );
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("assertAllowedOutputDir rejects a traversal under the volumes root that resolves outside it", () => {
  withFakeVolumesRoot((root) => {
    inMode("desktop", () => {
      assert.throws(
        () => assertAllowedOutputDir(`${root}${sep}x${sep}..${sep}..${sep}etc`),
        (err: unknown) => {
          assert.ok(err instanceof WireError);
          assert.equal(err.code, "not_in_workspace");
          return true;
        },
      );
    });
  });
});

test("assertAllowedOutputDir rejects /Volumes/Macintosh HD — a symlink to the boot disk on every real Mac", () => {
  // This is the actual bug: the unresolved string "/Volumes/Macintosh HD" is
  // "under /Volumes", but the entry is a symlink to "/", so accepting it lets
  // the folder printer write anywhere on the boot disk. Guarded by existsSync
  // because a machine could have renamed or removed this exact volume — the
  // portable version of this same scenario is the fake-root symlink test
  // above, which runs unconditionally.
  const bootDisk = join("/Volumes", "Macintosh HD");
  if (!existsSync(bootDisk)) return;
  inMode("desktop", () => {
    assert.throws(
      () => assertAllowedOutputDir(bootDisk),
      (err: unknown) => {
        assert.ok(err instanceof WireError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "not_in_workspace");
        return true;
      },
      "/Volumes/Macintosh HD resolves to / and must be refused",
    );
  });
});
