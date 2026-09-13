# Deploying Slicely to Fly.io

Slicely ships as one Docker image (`Dockerfile`, repo root): a built Node server plus a
headless PrusaSlicer extracted from its Linux AppImage. `fly.toml` (repo root) configures
one shared-cpu-2x / 2GB machine, a persistent volume at `/data` for `SLICELY_WORKDIR`, and
a health check on `/healthz`. This doc is the six commands to go from a checkout to a
running app, plus what to check afterward and what to know about running one machine.

You need the [`flyctl`](https://fly.io/docs/flyctl/install/) CLI and a Fly account.

## The six commands

1. **`fly launch --no-deploy`** — from the repo root. Creates the Fly app (picks up
   `fly.toml`; rename `app = "slicely"` first if that name is taken) without building or
   deploying yet, so you can set secrets and the volume first.

2. **`fly volumes create slicely_data --size 10`** — a 10GB volume for `/data`
   (`SLICELY_WORKDIR`): per-session workspaces, uploads, uploaded/sliced files, and the
   session store. Must exist before the first deploy — `fly.toml`'s `[mounts]` expects a
   volume named `slicely_data` in the app's primary region.

3. **`fly secrets set`** — every server-side secret. None of these is the user's own
   Anthropic key (that's BYO, pasted in the UI and stored per-session, never an env var):

   ```bash
   fly secrets set \
     SLICELY_MASTER_KEY=$(node scripts/gen-master-key.mjs | cut -d= -f2) \
     THINGIVERSE_APP_TOKEN=… \
     GITHUB_TOKEN=… \
     MYMINIFACTORY_API_KEY=… \
     SMITHSONIAN_API_KEY=…
   ```

   `SLICELY_MASTER_KEY` is required in hosted mode — it's what encrypts every visitor's
   pasted key at rest. Generate it once per deployment with `node scripts/gen-master-key.mjs`
   and never reuse it across environments; losing it means every stored key becomes
   undecryptable. The four sourcing keys are optional — omit any of them and that source
   degrades to "not configured" (Thingiverse, GitHub, MyMiniFactory) or the shared
   low-rate-limit `DEMO_KEY` (Smithsonian) rather than failing the deploy.

4. **`fly deploy --build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`** — builds the image and
   deploys it. `SOURCE_COMMIT` becomes `SLICELY_SOURCE_COMMIT`, which `/api/config` reports
   as `sourceCommit` — the app is AGPL (PrusaSlicer) and this is what lets the footer link
   to the exact running source (`REPO_URL/tree/<commit>`; see `src/server/LICENSING.md`).
   Passing it explicitly matters: without a build arg the Dockerfile's default (`dev`)
   ships, and the footer would point nowhere useful.

5. **Custom domain + certs** — optional, once the `.fly.dev` URL works:

   ```bash
   fly certs add app.yourdomain.example
   ```

   Then add the DNS records `fly certs add` prints (typically an A/AAAA pair, or a CNAME
   for a subdomain) at your DNS provider, and re-run `fly certs show app.yourdomain.example`
   until it reports the cert as issued.

6. **Set `APP_URL` in `site/config.js`** — the landing page (`site/`, deployed separately
   from this Fly app — see `site/README.md`) links to the app via `window.SLICELY_SITE.APP_URL`.
   Point it at whichever URL from step 5 you settled on (the `.fly.dev` one, or your custom
   domain), in **both** `site/config.js` and the matching `href` attributes in
   `site/index.html` — the two are meant to agree; `site/main.js` warns in the console if
   they don't.

## What to check after deploy

- **`GET /api/config`** on the deployed URL returns `mode: "hosted"`, `slicerAvailable: true`,
  and `sourceCommit` equal to the commit you deployed.
- **The key card** — open the app with no key connected; it should prompt for an Anthropic
  key rather than erroring, and accept a real key via `PUT /api/key`.
- **Upload → slice → gcode** — upload a model, slice it, download the resulting G-code. This
  exercises the extracted PrusaSlicer binary end to end, which nothing short of a real
  request can confirm (see "Not verified locally" below).
- **`GET /terms`** — as of this branch, the Express app (`src/server/index.ts`) mounts only
  `/api/*`, `/healthz`, and the compiled app bundle (`src/web` at `/`, `dist-web/web` at
  `/web`); there is no route serving `site/terms.html` or `site/privacy.html` at `/terms` /
  `/privacy`, even though `/api/config` advertises those exact paths (`termsUrl`,
  `privacyUrl` in `src/server/routes/config.ts`). Expect a 404 here today. That's a gap in
  the app, not a deploy mistake — flag it to whoever owns `src/server`, don't spend time
  debugging the container over it.

## Single machine only

`fly.toml` pins `min_machines_running = 1` and `auto_stop_machines = false` on purpose.
Sessions (`SessionStore` in `src/server/session.ts`) live in server memory, keyed by a
signed cookie — there is no shared session store (Redis, a database) behind it. A second
machine, or Fly stopping and restarting the one machine, would mean some visitors' cookies
suddenly point at a machine that has never heard of their session: it mints them a new one,
silently losing their in-progress chat, connected key for that process's lifetime, and
uploaded files. Scaling this out (or letting it auto-stop) needs an external session store
first — out of scope for this task.

## Rate limits in practice

The per-session tiers (spec §2 — `api` 60 burst / 5 per s, `chat` 6 burst / 0.05 per s,
`heavy` 10 burst / 0.1 per s) bound what one *session* can do, but a single IP can mint up
to 20 sessions an hour (also enforced server-side, keyed on the client IP `security.ts`
resolves once `SLICELY_TRUST_PROXY=1` is set — which `fly.toml` and the Dockerfile both set,
since Fly's edge always proxies). So the real ceiling per IP is those tiers **times up to
20**, not the single-session numbers on their own. `SLICELY_MAX_SLICES` (default `2`, set in
`fly.toml`) is a separate axis entirely: it caps how many PrusaSlicer processes run at once
across the *whole machine*, regardless of session or IP — the knob to turn if the 2GB /
shared-cpu-2x VM is spending too much CPU on slicing versus everything else.

## If the slicer needs a display

The image bakes in a one-line wrapper, `/opt/prusaslicer/slicer.sh`:
```sh
#!/bin/sh
exec xvfb-run -a /opt/prusaslicer/AppRun "$@"
```
`PRUSASLICER_PATH` (set in the Dockerfile) points at that wrapper, not at `AppRun` directly —
so every invocation, build-time smoke test included, already runs under a virtual display by
default. There is no `SLICELY_XVFB` environment flag wired into the code (`src/main/prusaslicer.ts`
invokes whatever `PRUSASLICER_PATH` names directly) — the wrapper is what makes that
unnecessary, since the display requirement is handled once, in the image, rather than per
call.

If it turns out PrusaSlicer's CLI usage here (`--export-gcode` and friends) never actually
needs a display — plausible, since most headless slicing doesn't — spinning up an Xvfb server
for every slice is pure overhead you can drop. Bypass the wrapper by pointing
`PRUSASLICER_PATH` straight at the real binary instead, either in `fly.toml`'s `[env]` block
or with `fly secrets set PRUSASLICER_PATH=/opt/prusaslicer/AppRun`, and confirm a slice still
succeeds afterward.

## Not verified locally

Docker was not installed on the machine this Dockerfile was written on, so `docker build`
was never run against it. Everything checkable without Docker was checked instead: the
PrusaSlicer release-asset resolution query (against the live GitHub API), that every `COPY`
source path exists, that `npm run build` produces the exact files the runtime stage copies,
and that every environment variable the Dockerfile/`fly.toml` set has a real reader in
`src/`. What that leaves genuinely unverified, and must be confirmed on the **first real**
`fly deploy` (or a local `docker build` on a machine that has Docker):

- That the image actually builds — the apt package set resolves, the AppImage extracts
  cleanly, and `/opt/prusaslicer/slicer.sh --help` (the `xvfb-run -a AppRun` wrapper) exits 0
  inside the container.
- That the extracted PrusaSlicer 2.8.1 binary (not 2.9.x — see the Dockerfile's `ARG
  PRUSASLICER_VERSION` comment: PrusaSlicer stopped publishing a Linux AppImage as of
  2.9.0, moving to Flathub instead, so no 2.9.x release has one) actually runs on
  `node:20-bookworm-slim`'s glibc — the "newer-distros" build was chosen on the assumption
  that Debian 12 (bookworm) counts as new enough, but nothing short of running it confirms
  that.
- That slicing a real model through it produces valid G-code end to end (the "upload → slice
  → gcode" check above).
