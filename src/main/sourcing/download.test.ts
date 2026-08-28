import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  isWithinDir,
  resolveZipEntryPath,
  fetchToFile,
  downloadUrlToDir,
  expandZipFile,
} from "./download";

// ── zip-slip guard ──────────────────────────────────────────────────────

test("isWithinDir accepts a path inside the directory and rejects one that escapes it", () => {
  assert.equal(isWithinDir("/tmp/dest", "/tmp/dest/file.stl"), true);
  assert.equal(isWithinDir("/tmp/dest", "/tmp/dest"), true);
  assert.equal(isWithinDir("/tmp/dest", "/tmp/other/file.stl"), false);
  assert.equal(isWithinDir("/tmp/dest", "/etc/passwd"), false);
});

test("resolveZipEntryPath neutralizes a classic zip-slip traversal entry", () => {
  const out = resolveZipEntryPath("/tmp/dest", "../../../../etc/passwd");
  assert.equal(out, join("/tmp/dest", "passwd"));
});

test("resolveZipEntryPath neutralizes an absolute-path entry", () => {
  const out = resolveZipEntryPath("/tmp/dest", "/etc/passwd");
  assert.equal(out, join("/tmp/dest", "passwd"));
});

test("resolveZipEntryPath neutralizes a Windows-style backslash traversal entry", () => {
  const out = resolveZipEntryPath("/tmp/dest", "..\\..\\evil.dll");
  // basename() on POSIX doesn't split on backslash, so the whole string
  // becomes one sanitized filename (".._.._evil.dll" — the sanitizer swaps
  // backslashes for underscores) that still legitimately CONTAINS ".." as
  // harmless literal characters. That's fine: the security property is that
  // it resolves inside destDir, not that it's free of the substring "..".
  assert.equal(isWithinDir("/tmp/dest", out), true);
  assert.doesNotMatch(basename(out), /[/\\]/); // no separator survived INSIDE the filename itself
});

test("resolveZipEntryPath collapses an entry that is nothing but '..' to the fallback name", () => {
  const out = resolveZipEntryPath("/tmp/dest", "../..");
  assert.equal(out, join("/tmp/dest", "model.stl"));
});

// ── fetchToFile / downloadUrlToDir (hermetic: fetch stubbed) ─────────────
// URLs use an IP literal host to keep the SSRF guard's check fully
// synchronous (no real DNS lookup needed) so these stay hermetic.

function binaryStl(triangleCount: number): Buffer {
  const buf = Buffer.alloc(84 + triangleCount * 50);
  buf.write("not really solid, this is binary", 0);
  buf.writeUInt32LE(triangleCount, 80);
  return buf;
}

test("fetchToFile streams a response to disk and sniffs a binary STL", async (t) => {
  const stl = binaryStl(2);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(stl), {
      status: 200,
      headers: {
        "content-type": "model/stl",
        "content-disposition": 'attachment; filename="part.stl"',
      },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await fetchToFile("http://93.184.216.34/whatever", dir);
    assert.equal(result.sniffed, "stl-binary");
    assert.equal(result.fileName, "part.stl");
    const onDisk = await readFile(result.path);
    assert.equal(onDisk.length, stl.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchToFile rejects a response that looks like an HTML login/error page", async (t) => {
  const html = "<!DOCTYPE html><html><body>Please log in</body></html>";
  t.mock.method(globalThis, "fetch", async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    await assert.rejects(
      () => fetchToFile("http://93.184.216.34/model.stl", dir),
      /returned a webpage instead of a file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchToFile enforces the declared Content-Length cap before streaming", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(Buffer.alloc(10)), {
      status: 200,
      headers: { "content-length": String(10 * 1024 * 1024) }, // lies: says 10MB
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    await assert.rejects(
      () => fetchToFile("http://93.184.216.34/huge.stl", dir, { maxBytes: 1024 }),
      /too large/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── minimal hand-rolled ZIP fixture (stored/uncompressed) ────────────────
// No zip-writing library is a project dependency, so this builds the
// smallest valid PKZIP structure by hand for expandZipFile/downloadUrlToDir
// to read back — one STORED (uncompressed) entry, real CRC32 via
// node:zlib.crc32 so unzipper's own integrity checks pass.

function buildZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(content) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (arbitrary valid value)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);
    localParts.push(local, content);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // offset of local header
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + content.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localData.length, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localData, centralDir, eocd]);
}

test("expandZipFile extracts mesh entries and applies the zip-slip guard to their names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slicely-zip-"));
  try {
    const zipBuf = buildZip([
      { name: "part-a.stl", content: Buffer.from("solid a\nendsolid a\n") },
      { name: "readme.txt", content: Buffer.from("not a mesh") },
      { name: "../../evil.stl", content: Buffer.from("solid evil\nendsolid evil\n") },
    ]);
    const zipPath = join(dir, "test.zip");
    await writeFile(zipPath, zipBuf);

    const destDir = join(dir, "out");
    const parts = await expandZipFile(zipPath, destDir);

    // readme.txt is not a mesh extension, so only the two .stl entries land.
    assert.equal(parts.length, 2);
    const names = parts.map((p) => p.fileName).sort();
    assert.deepEqual(names, ["evil.stl", "part-a.stl"]);
    for (const p of parts) {
      assert.equal(isWithinDir(destDir, p.localPath), true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadUrlToDir auto-expands a zip response into its mesh parts", async (t) => {
  const zipBuf = buildZip([{ name: "cube.stl", content: binaryStl(1) }]);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(zipBuf), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="model.zip"',
      },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/model.zip", dir);
    assert.equal(result.parts?.length, 1);
    assert.equal(result.parts?.[0].fileName, "cube.stl");
    assert.equal(result.fileName, "cube.stl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── regression: a .3mf (itself a zip container) must NOT be expanded ────
// Bug: 3MF/AMF are zip-based mesh formats. The generic "sniffed as zip ->
// expand as an archive of loose meshes" path was looking INSIDE the 3MF
// container for top-level *.stl/*.3mf files, finding none (a 3MF's payload
// is `3D/3dmodel.model`, not a loose mesh file with a recognized extension),
// and discarding the whole download as "no printable meshes found" — even
// though the .3mf itself is a perfectly valid, natively-sliceable file.

function build3mfContainer(): Buffer {
  const modelXml = Buffer.from(
    '<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"></model>',
  );
  return buildZip([{ name: "3D/3dmodel.model", content: modelXml }]);
}

test("downloadUrlToDir saves a .3mf as a single mesh part instead of expanding it as an archive", async (t) => {
  const threeMf = build3mfContainer();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(threeMf), {
      status: 200,
      headers: {
        "content-type": "model/3mf",
        "content-disposition": 'attachment; filename="Calibration Cube.3mf"',
      },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/model?fileType=3mf", dir);
    assert.equal(result.fileName, "Calibration Cube.3mf");
    assert.equal(result.parts?.length, 1);
    assert.equal(result.parts?.[0].ext, ".3mf");
    // It must have been saved whole, not unpacked into a subfolder.
    const onDisk = await readFile(result.localPath);
    assert.equal(onDisk.length, threeMf.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadUrlToDir detects a 3MF container even when the URL/suggested name has no .3mf extension", async (t) => {
  const threeMf = build3mfContainer();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(threeMf), { status: 200 }), // no Content-Disposition, no useful extension
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/download?id=42", dir);
    assert.equal(result.parts?.length, 1);
    assert.match(result.fileName, /\.3mf$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── regression: percent-encoded filenames must be decoded, then sanitized ──
// Bug: a Content-Disposition header whose PLAIN `filename=` parameter is
// (non-standard, but observed live from Printables' CDN) percent-encoded
// was saved to disk still percent-encoded, e.g. "Calibration%20Cube.stl"
// instead of "Calibration Cube.stl".

test("downloadUrlToDir decodes a percent-encoded plain Content-Disposition filename", async (t) => {
  const stl = binaryStl(1);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(stl), {
      status: 200,
      // Deliberately the non-standard-but-real shape: percent-encoding
      // inside the PLAIN filename= param, not the filename*= extended form.
      headers: { "content-disposition": 'attachment; filename="My%20Model.stl"' },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/whatever", dir);
    assert.equal(result.fileName, "My Model.stl");
    assert.doesNotMatch(result.fileName, /%20/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadUrlToDir falls back to a decoded URL-derived filename when there's no Content-Disposition", async (t) => {
  const stl = binaryStl(1);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(stl), { status: 200 }));

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/files/My%20Model.stl", dir);
    assert.equal(result.fileName, "My Model.stl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a decoded traversal sequence in the filename is still neutralized by the sanitizer AFTER decoding", async (t) => {
  const stl = binaryStl(1);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array(stl), {
      status: 200,
      // Decodes to: attachment; filename="../../etc/passwd.stl" — must not
      // let a decoded '/' escape destDir once the sanitizer runs.
      headers: {
        "content-disposition": 'attachment; filename="..%2F..%2Fetc%2Fpasswd.stl"',
      },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), "slicely-dl-"));
  try {
    const result = await downloadUrlToDir("http://93.184.216.34/whatever", dir);
    assert.equal(isWithinDir(dir, result.localPath), true);
    // "/" is the character that actually matters (it's what could create a
    // subdirectory or traverse); a resulting filename containing bare ".."
    // as harmless literal text is fine as long as it isn't a real path
    // segment — which the isWithinDir check above already confirms.
    assert.doesNotMatch(result.fileName, /\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
