import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeColourHex, describeError, safeJobName, assertAllowedOutputDir } from "./util";
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
