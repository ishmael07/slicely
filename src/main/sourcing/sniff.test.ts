import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffMagicBytes, looksLikeErrorPage } from "./sniff";

test("sniffMagicBytes recognizes a ZIP local-file-header signature", () => {
  const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(sniffMagicBytes(buf), "zip");
});

test("sniffMagicBytes recognizes an empty ZIP signature (PK\\x05\\x06)", () => {
  const buf = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
  assert.equal(sniffMagicBytes(buf), "zip");
});

test("sniffMagicBytes recognizes a binary STL by the exact 84+50*n size formula", () => {
  const triangles = 3;
  const buf = Buffer.alloc(84 + triangles * 50);
  buf.write("solid-looking-header-but-binary", 0); // deliberately ambiguous header text
  buf.writeUInt32LE(triangles, 80);
  assert.equal(sniffMagicBytes(buf), "stl-binary");
});

test("sniffMagicBytes recognizes an ASCII STL by its real facet/endsolid tokens", () => {
  const text = "solid cube\nfacet normal 0 0 1\nendsolid cube\n";
  assert.equal(sniffMagicBytes(Buffer.from(text, "utf8")), "stl-ascii");
});

test("sniffMagicBytes recognizes an HTML error/login page", () => {
  const html = "<!DOCTYPE html><html><head><title>Login</title></head></html>";
  assert.equal(sniffMagicBytes(Buffer.from(html, "utf8")), "html");
  assert.equal(looksLikeErrorPage("html"), true);
});

test("sniffMagicBytes recognizes a STEP file header", () => {
  const step = "ISO-10303-21;\nHEADER;\nENDSEC;\n";
  assert.equal(sniffMagicBytes(Buffer.from(step, "utf8")), "step");
});

test("sniffMagicBytes falls back to unknown for arbitrary bytes", () => {
  assert.equal(sniffMagicBytes(Buffer.from([1, 2, 3, 4, 5])), "unknown");
  assert.equal(looksLikeErrorPage("unknown"), false);
});
