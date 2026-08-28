import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extOf,
  isMeshExt,
  isArchiveExt,
  sanitizeFileName,
  filenameFromContentDisposition,
  filenameFromUrl,
} from "./fsutil";

test("extOf lowercases and extracts the extension", () => {
  assert.equal(extOf("Model.STL"), ".stl");
  assert.equal(extOf("archive.tar.gz"), ".gz");
  assert.equal(extOf("noext"), "");
});

test("isMeshExt / isArchiveExt classify the accepted formats", () => {
  for (const ext of [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"]) {
    assert.equal(isMeshExt(ext), true, ext);
  }
  assert.equal(isMeshExt(".zip"), false);
  assert.equal(isArchiveExt(".zip"), true);
  assert.equal(isArchiveExt(".stl"), false);
});

test("sanitizeFileName strips path separators and reserved characters", () => {
  assert.equal(sanitizeFileName("weird/name\\file:*?.stl"), "weird_name_file___.stl");
});

test("sanitizeFileName collapses a pure-dots name to the fallback (zip-slip building block)", () => {
  assert.equal(sanitizeFileName(".."), "model.stl");
  assert.equal(sanitizeFileName("...", "fallback.bin"), "fallback.bin");
});

test("sanitizeFileName falls back on an empty result", () => {
  assert.equal(sanitizeFileName("   "), "model.stl");
  assert.equal(sanitizeFileName(""), "model.stl");
});

test("filenameFromContentDisposition handles the plain and RFC5987 forms", () => {
  assert.equal(filenameFromContentDisposition('attachment; filename="model.stl"'), "model.stl");
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''caf%C3%A9.stl"),
    "café.stl",
  );
  assert.equal(filenameFromContentDisposition(null), undefined);
});

test("filenameFromUrl takes the last path segment", () => {
  assert.equal(filenameFromUrl("https://example.com/a/b/model.stl?x=1"), "model.stl");
  assert.equal(filenameFromUrl("https://example.com/"), undefined);
});
