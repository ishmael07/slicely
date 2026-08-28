// Magic-byte sniffing for downloaded files. Never trust a URL's extension or
// a server's Content-Type — a login-gated source routinely serves an HTML
// error/login page at a URL that "looks like" a .stl, and some hosts zip a
// single mesh without renaming it. Pure functions, no I/O, easy to unit test.

export type SniffedKind =
  | "zip"
  | "stl-binary"
  | "stl-ascii"
  | "step"
  | "xml"
  | "gltf-binary"
  | "html"
  | "unknown";

/** Inspect up to the first ~512 bytes (plus the full buffer for the binary
 *  STL triangle-count check) and guess what this actually is. */
export function sniffMagicBytes(buf: Buffer): SniffedKind {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return "zip"; // "PK\x03\x04" (local file) | "PK\x05\x06" (empty) | "PK\x07\x08" (spanned)
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "glTF") {
    return "gltf-binary";
  }

  const head = buf.subarray(0, Math.min(buf.length, 512)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("iso-10303-21")) return "step"; // STEP files start with this exact header line
  if (head.startsWith("<?xml") || head.startsWith("<amf")) return "xml";

  // Binary STL: 80-byte header + uint32 LE triangle count, then exactly
  // 50 bytes/triangle. A file whose length matches that formula exactly is
  // almost certainly a binary STL, even if its header text happens to start
  // with the literal word "solid" (a known ambiguity with ASCII STL).
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (buf.length === 84 + count * 50) return "stl-binary";
  }
  if (head.startsWith("solid")) {
    if (buf.includes(Buffer.from("facet normal")) || buf.includes(Buffer.from("endsolid"))) {
      return "stl-ascii";
    }
  }
  return "unknown";
}

/** True when the sniffed kind means "this is a webpage, not a file" — the
 *  classic symptom of a login/paywall gate silently redirecting a download
 *  link to an HTML page instead of erroring. */
export function looksLikeErrorPage(kind: SniffedKind): boolean {
  return kind === "html";
}
