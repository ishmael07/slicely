# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Two lines, not one. `COPY a b ./` with TWO OR MORE sources copies the
# CONTENTS of directory `b`, not `b` itself — so `COPY tsconfig*.json scripts ./`
# put `copy-assets.mjs` at `/app/copy-assets.mjs` and the build died on
# `Cannot find module '/app/scripts/copy-assets.mjs'`. Renaming the call would
# not have been enough either: copy-assets.mjs derives its repo root as
# `dirname(self)/..`, which from `/app` is `/`.
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
COPY site ./site
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
# PrusaSlicer stopped shipping a Linux AppImage as of the 2.9.x line (see the
# 2.9.2 release notes: "Linux build is now distributed through Flathub"; 2.9.0,
# 2.9.1 and 2.9.2 all have zero linux-* assets). 2.8.1 is the newest release
# that still publishes one. Bump this only after checking, with the GitHub API
# query below, that the target tag actually has a linux-x64...GTK3 AppImage.
ARG PRUSASLICER_VERSION=2.8.1
# PRUSASLICER_PATH points at a wrapper (baked in below), not AppRun directly —
# see the wrapper's own comment for why.
ENV SLICELY_MODE=hosted SLICELY_WORKDIR=/data SLICELY_TRUST_PROXY=1 SLICELY_PORT=8080 \
    PRUSASLICER_PATH=/opt/prusaslicer/slicer.sh NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libgtk-3-0 libgl1 libglu1-mesa libegl1 libwebkit2gtk-4.1-0 libdbus-1-3 xvfb \
    && rm -rf /var/lib/apt/lists/*
# THE RUNTIME USER IS CREATED HERE, not just before `USER` at the bottom, and it
# gets a REAL HOME. `useradd -r` on its own leaves `$HOME` pointing at a
# `/home/slicely` that was never created, and PrusaSlicer wants somewhere to put
# its config/data directory on every invocation — including the very first slice
# a visitor asks for. Creating the user this early is what lets the build-time
# smoke test below run as the user that will actually run the slicer, rather than
# as root with root's writable home, which is a test that cannot fail for the
# one reason it exists to catch. HOME is also stated explicitly: `RUN` during a
# build does not reliably inherit it from /etc/passwd the way `docker run` does.
RUN useradd -r -u 10001 -m -d /home/slicely -s /bin/sh slicely && mkdir -p /data && chown slicely /data
ENV HOME=/home/slicely
# The asset name carries a build date (and, from 2.8.1 on, a newer-distros/
# older-distros split), so resolve it via the GitHub API instead of guessing.
# `linux-x64.*GTK3` (not the narrower `linux-x64-GTK3`) is what actually
# matches the newer-distros naming; `-v 'older'` drops the older-distros twin
# so exactly one asset survives.
#
# The `--help` at the end of this RUN is a canary, not the real check: it proves
# the extraction produced a runnable binary inside the same layer that produced
# it, as root. The check that matters runs as `slicely` further down.
RUN set -eux; url=$(curl -fsSL "https://api.github.com/repos/prusa3d/PrusaSlicer/releases/tags/version_${PRUSASLICER_VERSION}" \
      | grep browser_download_url | grep 'linux-x64.*GTK3' | grep -v 'bgcode\|older' | head -1 | cut -d '"' -f 4); \
    curl -fsSL -o /tmp/ps.AppImage "$url"; chmod +x /tmp/ps.AppImage; \
    cd /tmp && ./ps.AppImage --appimage-extract >/dev/null && mv squashfs-root /opt/prusaslicer && rm /tmp/ps.AppImage; \
    printf '#!/bin/sh\nexec xvfb-run -a /opt/prusaslicer/AppRun "$@"\n' > /opt/prusaslicer/slicer.sh; \
    chmod +x /opt/prusaslicer/slicer.sh; \
    /opt/prusaslicer/slicer.sh --help >/dev/null; \
    rm -rf /tmp/.X11-unix /tmp/.X*-lock
# Declared here, not above: SOURCE_COMMIT changes on every deploy, and an ARG
# used in an ENV invalidates every later layer that depends on it — declaring
# it after the apt-get and AppImage-extraction layers keeps those cached
# across deploys instead of re-running them for a commit hash they don't care
# about.
ARG SOURCE_COMMIT=dev
ENV SLICELY_SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /app
# `--chown` on the COPY itself, rather than a `chown -R slicely /app` afterwards:
# a recursive chown rewrites every file it touches into a NEW layer, so the
# pruned node_modules tree shipped twice — once copied, once re-owned — for no
# benefit beyond its ownership.
COPY --from=build --chown=slicely:slicely /app/package.json ./
COPY --from=build --chown=slicely:slicely /app/node_modules ./node_modules
COPY --from=build --chown=slicely:slicely /app/dist ./dist
COPY --from=build --chown=slicely:slicely /app/dist-web ./dist-web
COPY --from=build --chown=slicely:slicely /app/src/web ./src/web
COPY --from=build --chown=slicely:slicely /app/site ./site
USER slicely
# THE BUILD-TIME SMOKE THAT COUNTS: the same wrapper, run by the same uid, with
# the same HOME, as every slice a visitor will ever ask for. If PrusaSlicer or
# xvfb-run needs a writable home or config directory, this is the line that says
# so — at build time, in CI, rather than on the first slice after a deploy.
RUN /opt/prusaslicer/slicer.sh --help >/dev/null
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server/index.js"]
