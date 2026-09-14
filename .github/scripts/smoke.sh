#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Container smoke test for the hosted Slicely image.
#
# This is the check that Docker's absence on the author's Mac left undone (see
# docs/DEPLOY.md, "Not verified locally"). It proves, against a real container:
#
#   1. the image boots in hosted mode with a SLICELY_MASTER_KEY,
#   2. GET /healthz answers 200,
#   3. GET /api/config reports mode "hosted", slicerAvailable true, and the
#      SOURCE_COMMIT it was built with,
#   4. the extracted PrusaSlicer runs headless (the xvfb-run wrapper the
#      Dockerfile bakes in) — both `--help` and a real `--export-gcode`,
#   5. the server's own upload → slice → G-code path works end to end.
#
# Every assertion is fatal. `docker logs` is dumped on any failure.
#
# Usage: smoke.sh <image> [expected-source-commit]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image> [expected-source-commit]}"
EXPECT_COMMIT="${2:-}"

# The port is the Dockerfile's / fly.toml's, not an invention: both set
# SLICELY_PORT=8080 and fly.toml's internal_port matches.
PORT=8080
NAME="slicely-smoke"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
JAR="${WORK}/cookies.txt"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

dump_logs() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "::group::docker logs ${NAME}"
    docker logs "$NAME" 2>&1 | tail -200 || true
    echo "::endgroup::"
    echo "::group::docker inspect (state)"
    docker inspect --format '{{json .State}}' "$NAME" 2>&1 || true
    echo "::endgroup::"
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$code"
}
trap dump_logs EXIT

# ── 1. Start the container the way Fly will ──────────────────────────────────
say "Starting container"
MASTER_KEY="$(openssl rand -base64 32)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e SLICELY_MODE=hosted \
  -e SLICELY_MASTER_KEY="$MASTER_KEY" \
  -e SLICELY_PORT="$PORT" \
  -p "${PORT}:${PORT}" \
  "$IMAGE" >/dev/null
docker ps --filter "name=${NAME}" --format 'running: {{.Image}} ({{.Status}})'

# ── 2. /healthz ──────────────────────────────────────────────────────────────
say "Waiting for GET /healthz"
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "${BASE}/healthz" >"${WORK}/healthz.json" 2>/dev/null; then
    echo "healthz after ${i}s: $(cat "${WORK}/healthz.json")"
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    fail "container exited before /healthz answered"
  fi
  sleep 1
done
[ -s "${WORK}/healthz.json" ] || fail "/healthz never answered within 60s"
grep -q '"ok":true' "${WORK}/healthz.json" || fail "/healthz did not return {\"ok\":true}"

# ── 3. /api/config — and the cookie every later API call needs ───────────────
# GET /api/config is the ONE call allowed to mint a session (see
# sessionMiddleware's MINTING_ROUTES), so it must come first and its cookie must
# be carried forward. In hosted mode the cookie is `__Host-slicely_sid`, which
# is Secure — curl stores it in the jar but not every curl build will replay a
# Secure cookie over plain http, so the value is read back out of the jar and
# sent as an explicit header. The jar is still the thing that captured it.
say "GET /api/config"
curl -fsS --max-time 10 -c "$JAR" -D "${WORK}/config.headers" "${BASE}/api/config" \
  >"${WORK}/config.json" || fail "GET /api/config failed"
cat "${WORK}/config.json"; echo
grep -qi '^set-cookie:' "${WORK}/config.headers" || fail "no Set-Cookie on /api/config"
grep -i '^set-cookie:' "${WORK}/config.headers" | sed 's/=[^;]*;/=<redacted>;/'

# Netscape jar format: 7 TAB-separated fields per cookie. An HttpOnly cookie's
# line is prefixed `#HttpOnly_` — which is why the filter is "has 7 tab fields",
# not "does not start with #". The jar's own header comments have no tabs.
COOKIE="$(awk -F'\t' 'NF == 7 { printf "%s=%s", $6, $7 }' "$JAR")"
[ -n "$COOKIE" ] || fail "no session cookie landed in the jar"
echo "session cookie name: ${COOKIE%%=*}"
AUTH=(-H "Cookie: ${COOKIE}")

jq -e '.mode == "hosted"' "${WORK}/config.json" >/dev/null \
  || fail "/api/config mode is not \"hosted\" (got $(jq -r .mode "${WORK}/config.json"))"
echo 'assert ok: "mode":"hosted"'
jq -e '.slicerAvailable == true' "${WORK}/config.json" >/dev/null \
  || fail "/api/config slicerAvailable is not true — PrusaSlicer is not where PRUSASLICER_PATH says"
echo 'assert ok: "slicerAvailable":true'
jq -e '.multiUser == true' "${WORK}/config.json" >/dev/null || fail "/api/config multiUser is not true"
if [ -n "$EXPECT_COMMIT" ]; then
  got="$(jq -r .sourceCommit "${WORK}/config.json")"
  [ "$got" = "$EXPECT_COMMIT" ] || fail "sourceCommit is ${got}, expected ${EXPECT_COMMIT}"
  echo "assert ok: sourceCommit = ${got}"
fi

# ── 4. The legal pages /api/config advertises ────────────────────────────────
say "GET /terms and /privacy"
for p in /terms /privacy; do
  code="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "${BASE}${p}")"
  echo "${p} -> ${code}"
  case "$code" in 200\ text/html*) ;; *) fail "${p} did not return 200 text/html" ;; esac
done

# ── 5. PrusaSlicer runs headless inside the container ────────────────────────
say "docker exec: PrusaSlicer --help (headless, via the xvfb-run wrapper)"
docker exec "$NAME" /opt/prusaslicer/slicer.sh --help >"${WORK}/ps-help.txt" 2>&1 \
  || { sed -n '1,40p' "${WORK}/ps-help.txt"; fail "PrusaSlicer --help exited non-zero inside the container"; }
head -5 "${WORK}/ps-help.txt"
grep -q -- '--export-gcode' "${WORK}/ps-help.txt" \
  || fail "PrusaSlicer --help output does not mention --export-gcode"
echo 'assert ok: PrusaSlicer CLI runs headless and knows --export-gcode'

# ── 6. A 12-triangle ASCII cube, 20mm — the smallest honest sliceable STL ────
say "Writing a 20mm ASCII cube STL (12 triangles)"
write_cube() {
  cat <<'STL'
solid cube
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 20 20 0
    vertex 20 0 0
  endloop
endfacet
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 0 20 0
    vertex 20 20 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 20
    vertex 20 0 20
    vertex 20 20 20
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 20
    vertex 20 20 20
    vertex 0 20 20
  endloop
endfacet
facet normal 0 -1 0
  outer loop
    vertex 0 0 0
    vertex 20 0 0
    vertex 20 0 20
  endloop
endfacet
facet normal 0 -1 0
  outer loop
    vertex 0 0 0
    vertex 20 0 20
    vertex 0 0 20
  endloop
endfacet
facet normal 1 0 0
  outer loop
    vertex 20 0 0
    vertex 20 20 0
    vertex 20 20 20
  endloop
endfacet
facet normal 1 0 0
  outer loop
    vertex 20 0 0
    vertex 20 20 20
    vertex 20 0 20
  endloop
endfacet
facet normal 0 1 0
  outer loop
    vertex 20 20 0
    vertex 0 20 0
    vertex 0 20 20
  endloop
endfacet
facet normal 0 1 0
  outer loop
    vertex 20 20 0
    vertex 0 20 20
    vertex 20 20 20
  endloop
endfacet
facet normal -1 0 0
  outer loop
    vertex 0 20 0
    vertex 0 0 0
    vertex 0 0 20
  endloop
endfacet
facet normal -1 0 0
  outer loop
    vertex 0 20 0
    vertex 0 0 20
    vertex 0 20 20
  endloop
endfacet
endsolid cube
STL
}
write_cube >"${WORK}/cube.stl"
wc -c <"${WORK}/cube.stl" | sed 's/^/cube.stl bytes: /'

# ── 7. The CLI slice, straight through the binary ────────────────────────────
# Independent of the server: if this passes and /api/slice fails, the fault is
# the app's; if both fail, it is the image's.
say "docker exec: PrusaSlicer --export-gcode (direct CLI slice)"
docker cp "${WORK}/cube.stl" "${NAME}:/tmp/cube.stl"
docker exec "$NAME" /opt/prusaslicer/slicer.sh --export-gcode /tmp/cube.stl --output /tmp/cube.gcode \
  >"${WORK}/cli-slice.log" 2>&1 || { cat "${WORK}/cli-slice.log"; fail "PrusaSlicer --export-gcode failed in the container"; }
tail -5 "${WORK}/cli-slice.log"
cli_bytes="$(docker exec "$NAME" stat -c %s /tmp/cube.gcode)"
echo "CLI G-code bytes: ${cli_bytes}"
[ "$cli_bytes" -gt 5000 ] || fail "CLI G-code is only ${cli_bytes} bytes — not a real slice"
docker exec "$NAME" head -3 /tmp/cube.gcode

# ── 8. POST /api/upload ──────────────────────────────────────────────────────
say "POST /api/upload"
curl -fsS --max-time 60 "${AUTH[@]}" -F "files=@${WORK}/cube.stl;filename=cube.stl" \
  "${BASE}/api/upload" >"${WORK}/upload.json" || { cat "${WORK}/upload.json" 2>/dev/null; fail "POST /api/upload failed"; }
cat "${WORK}/upload.json"; echo
REL="$(jq -r '.uploaded[0].relPath // empty' "${WORK}/upload.json")"
[ -n "$REL" ] || fail "upload response carried no uploaded[0].relPath"
jq -e '.uploaded[0].sliceable == true' "${WORK}/upload.json" >/dev/null \
  || fail "the uploaded cube was not reported sliceable"
echo "assert ok: uploaded ${REL} (sliceable)"

# ── 9. POST /api/slice ───────────────────────────────────────────────────────
say "POST /api/slice"
curl -fsS --max-time 600 "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"paths\":[\"${REL}\"],\"goal\":\"draft\",\"material\":\"PLA\"}" \
  "${BASE}/api/slice" >"${WORK}/slice.json" || { cat "${WORK}/slice.json" 2>/dev/null; fail "POST /api/slice failed"; }
jq '{info: .info, rationale: .rationale, warnings: .warnings, plates: [.plates[] | {gcodeId, displayName, layerHeightMm, estimatedMinutes, filamentGrams}]}' \
  "${WORK}/slice.json" 2>/dev/null || cat "${WORK}/slice.json"
GID="$(jq -r '.plates[0].gcodeId // empty' "${WORK}/slice.json")"
[ -n "$GID" ] || fail "slice response carried no plates[0].gcodeId"
jq -e '.info.relPath != null and (.info | has("filePath") | not)' "${WORK}/slice.json" >/dev/null \
  || fail "slice response leaked a server filePath (or dropped info.relPath)"
echo "assert ok: sliced -> gcodeId ${GID}, no absolute server path in the body"

# ── 10. GET /api/gcode/:id ───────────────────────────────────────────────────
say "GET /api/gcode/${GID}"
curl -fsS --max-time 60 "${AUTH[@]}" -o "${WORK}/out.gcode" -D "${WORK}/gcode.headers" \
  "${BASE}/api/gcode/${GID}" || fail "GET /api/gcode/${GID} failed"
grep -i '^content-disposition:' "${WORK}/gcode.headers" || true
bytes="$(wc -c <"${WORK}/out.gcode" | tr -d ' ')"
comments="$(grep -c '^;' "${WORK}/out.gcode" || true)"
extrusions="$(grep -c '^G1 .*E' "${WORK}/out.gcode" || true)"
echo "G-code bytes: ${bytes}, ';' comment lines: ${comments}, extruding G1 moves: ${extrusions}"
echo "--- first 12 lines ---"; head -12 "${WORK}/out.gcode"
echo "--- last 6 lines ---"; tail -6 "${WORK}/out.gcode"
[ "$bytes" -gt 20000 ] || fail "G-code is only ${bytes} bytes — too small to be a sliced 20mm cube"
[ "$comments" -gt 10 ] || fail "G-code has only ${comments} ';' comment lines"
[ "$extrusions" -gt 100 ] || fail "G-code has only ${extrusions} extruding moves"
grep -q 'prusaslicer_config\|PrusaSlicer' "${WORK}/out.gcode" || fail "G-code does not look like PrusaSlicer output"

# ── 11. The isolation rule, since a workspace now exists ─────────────────────
say "Negative check: a path outside the workspace is refused"
code="$(curl -s -o "${WORK}/deny.json" -w '%{http_code}' --max-time 30 "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d '{"paths":["/etc/passwd"]}' "${BASE}/api/slice")"
echo "POST /api/slice {paths:[/etc/passwd]} -> ${code} $(cat "${WORK}/deny.json")"
[ "$code" = "400" ] || fail "slicing /etc/passwd returned ${code}, expected 400 not_in_workspace"
grep -q 'not_in_workspace' "${WORK}/deny.json" || fail "refusal did not carry code not_in_workspace"

say "Image size"
docker image ls "$IMAGE" --format 'image: {{.Repository}}:{{.Tag}}  size: {{.Size}}'

say "ALL SMOKE ASSERTIONS PASSED"
