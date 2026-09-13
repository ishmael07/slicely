# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json scripts ./
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
ARG SOURCE_COMMIT=dev
ENV SLICELY_MODE=hosted SLICELY_WORKDIR=/data SLICELY_TRUST_PROXY=1 SLICELY_PORT=8080 \
    PRUSASLICER_PATH=/opt/prusaslicer/AppRun SLICELY_SOURCE_COMMIT=${SOURCE_COMMIT} NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libgtk-3-0 libgl1 libglu1-mesa libegl1 libwebkit2gtk-4.1-0 libdbus-1-3 xvfb \
    && rm -rf /var/lib/apt/lists/*
# The asset name carries a build date (and, from 2.8.1 on, a newer-distros/
# older-distros split), so resolve it via the GitHub API instead of guessing.
# `linux-x64.*GTK3` (not the narrower `linux-x64-GTK3`) is what actually
# matches the newer-distros naming; `-v 'older'` drops the older-distros twin
# so exactly one asset survives.
RUN set -eux; url=$(curl -fsSL "https://api.github.com/repos/prusa3d/PrusaSlicer/releases/tags/version_${PRUSASLICER_VERSION}" \
      | grep browser_download_url | grep 'linux-x64.*GTK3' | grep -v 'bgcode\|older' | head -1 | cut -d '"' -f 4); \
    curl -fsSL -o /tmp/ps.AppImage "$url"; chmod +x /tmp/ps.AppImage; \
    cd /tmp && ./ps.AppImage --appimage-extract >/dev/null && mv squashfs-root /opt/prusaslicer && rm /tmp/ps.AppImage; \
    xvfb-run -a /opt/prusaslicer/AppRun --help >/dev/null
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/src/web ./src/web
COPY --from=build /app/site ./site
RUN useradd -r -u 10001 slicely && mkdir -p /data && chown -R slicely /data /app
USER slicely
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server/index.js"]
