// Zip-bomb regression tests for meshzip.ts.
//
// The defect these cover: the per-archive caps (500 entries, 2 GB total) both
// passed for an archive holding ONE 1.9 GB member, and extraction then called
// `entry.buffer()` — asking Node for a 1.9 GB Buffer before any byte counter it
// kept could object. The running total was checked AFTER the allocation that
// killed the process, so the cap that mattered was the one nobody had written.
//
// Hermetic and DELIBERATELY TINY: the oversized entry is declared in the zip's
// central directory and never written to disk, and the mid-stream case uses a
// few dozen bytes against an injected cap. No fixture here is larger than a
// kilobyte — these tests must stay runnable on a full disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { extractMeshesFromZip } from "./meshzip";
import { MAX_ZIP_ENTRY_BYTES } from "../shared/types";

/** One member of a hand-built archive. `declaredSize` overrides the size the
 *  CENTRAL DIRECTORY reports, which is the field an extractor trusts — and the
 *  field a hostile archive lies in, in either direction. */
interface EntrySpec {
  name: string;
  data: Buffer;
  declaredSize?: number;
}

/**
 * Build a minimal STORED (uncompressed) zip. Hand-rolled because the point is
 * to control the central directory independently of the bytes present: no zip
 * writer will emit a header claiming 1.9 GB for a ten-byte file, and writing a
 * real 1.9 GB file to prove a 500 MB cap is the bug, not the test.
 */
function buildZip(entries: EntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const name = Buffer.from(spec.name, "utf8");
    const sum = crc32(spec.data);
    const real = spec.data.byteLength;
    const declared = spec.declaredSize ?? real;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(real, 18); // compressed size
    local.writeUInt32LE(real, 22); // uncompressed size (truthful here)
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, spec.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(real, 20); // compressed size: what really streams
    central.writeUInt32LE(declared, 24); // uncompressed size: what it CLAIMS
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // offset of local header
    centrals.push(central, name);

    offset += local.byteLength + name.byteLength + real;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.byteLength, 12);
  eocd.writeUInt32LE(localPart.byteLength, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([localPart, centralPart, eocd]);
}

function withTempDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `slicely-${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("an entry declaring 1.9 GB is refused as zip_entry_too_large, and nothing is written", async () => {
  await withTempDir("meshzip-declared", async (dir) => {
    const zip = buildZip([
      { name: "bomb.stl", data: Buffer.from("solid tiny\n"), declaredSize: 1_900_000_000 },
    ]);
    // The whole fixture is bytes, not gigabytes — that is the point.
    assert.ok(zip.byteLength < 1024, `fixture should stay tiny, got ${zip.byteLength}`);

    await assert.rejects(
      () => extractMeshesFromZip(zip, join(dir, "out")),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        assert.equal(e.status, 413);
        assert.equal(e.code, "zip_entry_too_large");
        assert.match(String(e.message), /bomb\.stl/);
        return true;
      },
    );

    // Refused from the central directory alone: the guard must fire BEFORE the
    // entry is opened, so there is no partial file and no allocation.
    const out = join(dir, "out");
    assert.deepEqual(existsSync(out) ? readdirSync(out) : [], []);
  });
});

test("an entry that under-reports its size is cut off mid-stream, partial file removed", async () => {
  await withTempDir("meshzip-lying", async (dir) => {
    // Central directory claims 8 bytes; 400 actually follow. A declared-size
    // check alone would wave this through, which is why the stream is metered.
    const payload = Buffer.alloc(400, 0x41);
    const zip = buildZip([{ name: "liar.stl", data: payload, declaredSize: 8 }]);
    const out = join(dir, "out");

    await assert.rejects(
      () => extractMeshesFromZip(zip, out, 64),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        assert.equal(e.status, 413);
        assert.equal(e.code, "zip_entry_too_large");
        return true;
      },
    );

    // A half-written mesh left behind would be indexed as a real part and
    // handed to the slicer.
    assert.equal(existsSync(join(out, "liar.stl")), false, "partial file must be removed");
    assert.deepEqual(existsSync(out) ? readdirSync(out) : [], []);
  });
});

test("an ordinary multi-part archive still extracts, flattened", async () => {
  await withTempDir("meshzip-ok", async (dir) => {
    const a = Buffer.from("solid a\nendsolid a\n");
    const b = Buffer.from("solid b\nendsolid b\n");
    const zip = buildZip([
      { name: "kit/part-a.stl", data: a },
      { name: "kit/nested/part-b.stl", data: b },
      { name: "kit/readme.txt", data: Buffer.from("not a mesh") },
      { name: "__MACOSX/._part-a.stl", data: Buffer.from("junk") },
    ]);
    const out = join(dir, "out");

    const parts = await extractMeshesFromZip(zip, out);

    assert.deepEqual(
      parts.map((p) => p.fileName).sort(),
      ["part-a.stl", "part-b.stl"],
      "meshes only, flattened to basenames",
    );
    assert.equal(readFileSync(join(out, "part-a.stl"), "utf8"), a.toString());
    assert.equal(readFileSync(join(out, "part-b.stl"), "utf8"), b.toString());
    // sizeBytes must report what was actually streamed, since that is what the
    // caller shows the user and what the total-bytes budget is spent from.
    assert.deepEqual(
      parts.map((p) => p.sizeBytes).sort((x, y) => x - y),
      [a.byteLength, b.byteLength],
    );
  });
});

test("the default per-entry cap is well under the 2 GB whole-archive cap", () => {
  // The bug was a per-entry ceiling that did not exist; a cap set at or above
  // the total would reintroduce it, since one entry could then be the whole
  // archive and still pass both checks.
  assert.ok(
    MAX_ZIP_ENTRY_BYTES < 2 * 1024 * 1024 * 1024,
    "a per-entry cap at the archive total is no cap at all",
  );
});
