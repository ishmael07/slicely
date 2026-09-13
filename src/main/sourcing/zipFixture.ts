// ── minimal hand-rolled ZIP fixture (stored/uncompressed) ────────────────────
// TEST SUPPORT ONLY. No zip-WRITING library is a project dependency (unzipper
// only reads), so this builds the smallest valid PKZIP structure by hand for
// the extractors to read back: STORED (uncompressed) entries with a real CRC32
// from node:zlib, so unzipper's own integrity checks pass.
//
// Lives outside a `.test.ts` file because more than one test file needs it
// (sourcing/download.test.ts and server/routes/upload.test.ts) and a 70-line
// copy in each is a maintenance trap.
import { crc32 } from "node:zlib";

export interface ZipFixtureEntry {
  name: string;
  content: Buffer;
}

export function buildZip(entries: ZipFixtureEntry[]): Buffer {
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
