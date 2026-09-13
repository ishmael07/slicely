#!/usr/bin/env bash
# Renders the ◆ brand mark (site/favicon.svg) into build/icon.png (1024x1024)
# and build/icon.icns — the Mac app icon electron-builder points at.
#
#   scripts/make-icon.sh
#
# Uses only tools that ship with macOS: qlmanage (Quick Look) to rasterize
# SVG -> PNG, sips to resize, iconutil to assemble the .icns. No new
# dependency for this: the outputs are committed, so this only needs to run
# again when favicon.svg changes.
#
# qlmanage renders the bare 64x64 favicon.svg as a small thumbnail padded
# with transparency inside the requested canvas, instead of filling it edge
# to edge — the app icon needs to be a filled rounded square, not a glyph
# floating on a transparent square. So we wrap the same background + ◆ path
# in a throwaway 1024x1024 SVG and render that instead.
#
# Idempotent and safe to re-run: outputs are overwritten, and all working
# files live in a self-cleaning temp directory.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

for tool in qlmanage sips iconutil file; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "make-icon.sh: required tool '$tool' not found — this script needs macOS (Quick Look + Image I/O + Icon Composer command-line tools)" >&2
    exit 1
  fi
done

SRC_SVG="site/favicon.svg"
if [ ! -f "$SRC_SVG" ]; then
  echo "make-icon.sh: $SRC_SVG not found (run from the repo root, or check the file exists)" >&2
  exit 1
fi

BUILD_DIR="build"
mkdir -p "$BUILD_DIR"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/slicely-icon.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

RENDER_DIR="$WORK_DIR/render"
ICONSET="$WORK_DIR/icon.iconset"
WRAPPER_SVG="$WORK_DIR/icon-1024.svg"
mkdir -p "$RENDER_DIR" "$ICONSET"

# Same background rect + ◆ path as site/favicon.svg, redrawn on a 1024x1024
# viewBox so qlmanage has no room to pad with transparency. The diamond's
# proportions (vertices 19/32 of the way from center to edge) match the
# favicon exactly, just scaled up 16x.
cat > "$WRAPPER_SVG" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff7a45"/>
      <stop offset="1" stop-color="#ffb15c"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="240" fill="#0a0a0b"/>
  <path d="M512 208 L816 512 L512 816 L208 512 Z" fill="url(#g)"/>
</svg>
SVG

qlmanage -t -s 1024 -o "$RENDER_DIR" "$WRAPPER_SVG" >/dev/null

RENDERED="$RENDER_DIR/icon-1024.svg.png"
if [ ! -f "$RENDERED" ]; then
  echo "make-icon.sh: qlmanage did not produce a thumbnail (expected $RENDERED)" >&2
  exit 1
fi

WIDTH="$(sips -g pixelWidth "$RENDERED" | awk '/pixelWidth/{print $2}')"
HEIGHT="$(sips -g pixelHeight "$RENDERED" | awk '/pixelHeight/{print $2}')"
if [ "$WIDTH" != "1024" ] || [ "$HEIGHT" != "1024" ]; then
  echo "make-icon.sh: expected a 1024x1024 render, got ${WIDTH}x${HEIGHT}" >&2
  exit 1
fi

cp "$RENDERED" "$BUILD_DIR/icon.png"

# Build the .iconset macOS expects: 16/32/128/256/512 plus @2x of each, where
# 512x512@2x is the full 1024x1024 render.
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$BUILD_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$BUILD_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$BUILD_DIR/icon.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"

echo "make-icon.sh: wrote $BUILD_DIR/icon.png and $BUILD_DIR/icon.icns"
