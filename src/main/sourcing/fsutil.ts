// Small filesystem-adjacent helpers shared by every provider, the URL
// resolver, and the downloader. Kept dependency-free (no Node fs) so it can
// be unit tested as pure string logic.

/** Mesh/CAD extensions Slicely can slice or import — mirrors
 *  ACCEPTED_UPLOAD_EXTS in shared/types minus ".zip" (archives are expanded,
 *  not treated as a mesh themselves). */
export const MESH_EXTS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"];

export const ARCHIVE_EXTS = [".zip"];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function isMeshExt(ext: string): boolean {
  return MESH_EXTS.includes(ext.toLowerCase());
}

export function isArchiveExt(ext: string): boolean {
  return ARCHIVE_EXTS.includes(ext.toLowerCase());
}

/** Strip directory separators and reserved/control characters from a
 *  filename. Used for both `Content-Disposition` filenames and provider file
 *  names — never trust either to be a bare filename. */
export function sanitizeFileName(name: string, fallback = "model.stl"): string {
  const reserved = new Set(["<", ">", ":", '"', "|", "?", "*", "/", "\\"]);
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue; // control chars
    out += reserved.has(ch) ? "_" : ch;
  }
  out = out.trim();
  // A sanitized "../" or "..\\" still leaves literal dots — collapse a
  // filename that is JUST dots (e.g. "..") to the fallback so it can never
  // resolve to a parent directory reference once joined with a destDir.
  if (/^\.+$/.test(out)) out = "";
  return out.length > 0 ? out : fallback;
}

/** Parse a filename out of a `Content-Disposition` header value, if present. */
export function filenameFromContentDisposition(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined;
  // RFC 5987 extended form: filename*=UTF-8''encoded-name
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(headerValue);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(headerValue);
  const raw = plain?.[1]?.trim();
  if (!raw) return undefined;
  // The plain `filename=` parameter isn't supposed to be percent-encoded
  // (only `filename*=` is defined that way) — but some real CDNs do it
  // anyway (observed live: Printables' files.printables.com sends
  // `filename="Calibration%20Cube.stl"` in the plain form). Decode
  // defensively; a name that was never encoded and happens to contain a
  // literal '%' that isn't valid percent-encoding just throws and is used
  // as-is untouched.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Best-effort filename from the last path segment of a URL. */
export function filenameFromUrl(url: string): string | undefined {
  try {
    const { pathname } = new URL(url);
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    return last.length > 0 ? last : undefined;
  } catch {
    return undefined;
  }
}
