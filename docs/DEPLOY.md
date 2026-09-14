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
   low-rate-limit `DEMO_KEY` (Smithsonian) rather than failing the deploy. The sign-in and
   free-credit secrets are a separate, optional set — see "Set up sign-in" below.

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

## Set up sign-in (optional — the free tier)

Skip this whole section and you get exactly the app described above: every visitor
connects their own API key, nothing of yours is ever spent, and no sign-in button appears.
Do it and a visitor can sign in with Google or GitHub, get **50¢ of your** AI credit once,
and try Slicely with no card and no key. The numbers are yours to set (`.env.example`'s
"what the free tier may cost you" block); the defaults bound the worst case at $5/day.

Sign-in needs three things at once — an origin, an OAuth client, and an owner key to fund
the credit. Miss one and accounts stay off; the server logs one
`[accounts] accounts are DISABLED …` line at boot saying which.

The URLs below are written out for `https://slicely.fly.dev`. **If you renamed the app or
added a custom domain, substitute that origin everywhere** — including in
`SLICELY_PUBLIC_URL`, which is where every redirect URI comes from.

1. **Create the Google OAuth client.** [console.cloud.google.com](https://console.cloud.google.com)
   → pick or create a project → **APIs & Services** → **OAuth consent screen**: User type
   **External**, fill in the app name, your support email and the two links
   (`https://slicely.fly.dev/privacy`, `https://slicely.fly.dev/terms`), and add **only**
   the `openid`, `email` and `profile` scopes. Those three are non-sensitive, so there is no
   verification review to wait for. Then **Credentials** → **Create credentials** → **OAuth
   client ID** → application type **Web application**:

   - Authorised JavaScript origins: `https://slicely.fly.dev`
   - **Authorised redirect URI: `https://slicely.fly.dev/auth/google/callback`** — exactly
     that, no trailing slash. It must match byte for byte or Google refuses the callback.

   Copy the client ID and client secret.

2. **Create the GitHub OAuth App.** [github.com/settings/developers](https://github.com/settings/developers)
   → **OAuth Apps** → **New OAuth App**:

   - Application name: Slicely · Homepage URL: `https://slicely.fly.dev`
   - **Authorization callback URL: `https://slicely.fly.dev/auth/github/callback`**

   Then **Generate a new client secret** and copy it — GitHub shows it once. (An OAuth App,
   not a GitHub App: Slicely only reads a verified email address.)

   Either provider on its own is fine. One button is a working sign-in card; both halves of
   a pair are required for that provider to appear at all.

3. **Set the secrets and redeploy.**

   ```bash
   fly secrets set \
     SLICELY_PUBLIC_URL=https://slicely.fly.dev \
     GOOGLE_CLIENT_ID=… \
     GOOGLE_CLIENT_SECRET=… \
     GITHUB_CLIENT_ID=… \
     GITHUB_CLIENT_SECRET=… \
     ANTHROPIC_API_KEY=sk-ant-…
   ```

   `fly secrets set` restarts the machine, which is what picks the values up. Two of these
   have sharp edges worth reading twice:

   - **`SLICELY_PUBLIC_URL` must be a bare `https://host` origin** — no path, no trailing
     slash-and-more, no `http://` (except `localhost`, for running the flow locally). Every
     redirect URI is built by appending to it, and it is deliberately never taken from the
     `Host` header. Set it to something unusable and **the app refuses to boot** with a
     message saying so, rather than sending visitors to a callback Google will reject.
   - **`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) is what makes the free tier real.** It is
     spendable only by a signed-in account, only up to that account's grant, only on the
     cheap free model, and only while the daily ceiling is unspent — every call metered and
     written to `/data/accounts/usage/<day>.ndjson`. With OAuth configured and no owner key,
     there is nothing to grant, so the sign-in buttons are withheld and the boot log says
     why.

4. **Tell your visitors what an account stores.** Sign-in creates a record, so
   `site/privacy.html` needs a paragraph about it: the email address, display name and
   monogram (and no provider tokens), the hashed-IP signup limit, the per-turn usage ledger,
   and that *Delete my data* removes all of it. The site deploys separately — see
   `site/README.md`.

## What to check after deploy

- **`GET /api/config`** on the deployed URL returns `mode: "hosted"`, `slicerAvailable: true`,
  and `sourceCommit` equal to the commit you deployed.
- **The key card** — open the app with no key connected; it should prompt for an Anthropic
  key rather than erroring, and accept a real key via `PUT /api/key`.
- **Upload → slice → gcode** — upload a model, slice it, download the resulting G-code. This
  exercises the extracted PrusaSlicer binary end to end, which nothing short of a real
  request can confirm (see "Verified in CI, not on a laptop" below).
- **`GET /terms` and `GET /privacy`** — both should be 200 `text/html`, styled (the page
  pulls `/styles.css`). These are the exact paths `/api/config` advertises as `termsUrl`
  and `privacyUrl` (`src/server/routes/config.ts`), so a 404 here means the About link and
  the onboarding card are broken.

If you set up sign-in, four more — in this order, because each one explains the next:

- **`GET /api/config` shows `accountsEnabled: true`**, with a `signinProviders` array
  holding one entry per provider you configured and a `freeTier` object naming the model and
  `creditCents`. `false` here means one of the three ingredients is missing; `fly logs` has
  the `[accounts] accounts are DISABLED …` line saying which. `signinProviders: []` with
  `accountsEnabled: false` is the same story, not a separate bug — a button that leads to a
  password prompt and then no credit is worse than no button.
- **A real sign-in reaches the app with a `$0.50` pill.** Open the app in a browser that has
  never signed in, click *Continue with Google* (or GitHub), and you should land back on `/`
  signed in, with the header pill reading `$0.50` within a second or two. A provider error
  page instead means the redirect URI is not registered byte for byte — compare it with
  `SLICELY_PUBLIC_URL` + `/auth/<provider>/callback`.
- **One turn writes one ledger line.** Send a single chat message, then:

  ```bash
  fly ssh console -C "tail -3 /data/accounts/usage/$(date -u +%F).ndjson"
  ```

  One JSON line per model call, each with the model, the token counts and the µ¢ charged,
  and the pill drops by that much. No file at all means the turn was paid for by a connected
  key (which is never metered), not that metering is broken.
- **Nothing before sign-in.** `GET /api/me` answers `{"signedIn": false}` and `POST /api/chat`
  answers **401** `signin_required` — while `POST /api/find` still answers **200** for a
  stranger with no key and no account, because a plain search costs no credit.

### What is served off disk

Nothing is served by directory. `src/server/static.ts` holds a literal allow-list — one URL
per line, each mapped to one file under the repo root with one declared content type — plus
a single pattern for the browser modules. In full, that is:

| URL | File |
| --- | --- |
| `/`, `/index.html` | `src/web/index.html` |
| `/app.css` | `src/web/styles.css` (the app shell's stylesheet) |
| `/styles.css` | `site/styles.css` (the site stylesheet the legal pages link relatively) |
| `/favicon.svg` | `site/favicon.svg` |
| `/terms`, `/terms.html` | `site/terms.html` |
| `/privacy`, `/privacy.html` | `site/privacy.html` |
| `/web/<name>.js` | `dist-web/web/<name>.js` — one path segment, `[A-Za-z0-9._-]`, no leading dot, must end `.js` |

Anything else falls through to the app's ordinary JSON 404: `.ts` sources, `.js.map`
sourcemaps, dotfiles, directory listings, nested paths under `/web/`, and traversal
attempts. So if you add a file to `src/web` or `site` and expect a URL for it, add the line
— there is no other way for one to become reachable, and no way for a stray scratch file to
become reachable by accident.

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

`SLICELY_TRUST_PROXY=1` trusts **exactly one** proxy hop, not the whole `X-Forwarded-For`
chain: the address used is `Fly-Client-IP` when Fly set it, otherwise the *last* entry in
`X-Forwarded-For` — the one Fly appended. Anything a caller writes into that header ahead of
it is ignored, which is the point: if the leftmost entry counted, every per-IP control here
(mint cap, signup cap, all three tiers) would be a header anyone could rotate per request. A
deployment behind **two** proxies (a CDN in front of Fly, say) has to raise the hop count in
`trustProxySetting()` (`src/server/security.ts`) deliberately.

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

## Verified in CI, not on a laptop

Docker is not installed on the machine this Dockerfile was written on, so it is proven by
GitHub Actions instead: `.github/workflows/backend.yml` builds this exact image on every
push to `slicely-v3`, `launch/**` and `main`, starts it in hosted mode, and runs
`.github/scripts/smoke.sh` inside it — `/healthz`, `/api/config` (`mode: "hosted"`,
`slicerAvailable: true`, the right `sourceCommit`), `/terms` and `/privacy`, the PrusaSlicer
CLI under the `xvfb-run` wrapper as the runtime user, and a real upload → slice → G-code
download with a path-traversal refusal at the end. The image is about 1 GB, almost all of it
the extracted PrusaSlicer 2.8.1 AppImage (2.9.x has no Linux AppImage — see the Dockerfile's
`ARG PRUSASLICER_VERSION` comment).

What CI cannot see, and is worth a glance on the **first real** `fly deploy`:

- Ownership of `/data` on the mounted Fly volume (the container runs as `slicely`, uid
  10001; the volume must be writable by it).
- That the app's public URL serves `/`, `/app.css` and `/fonts/*` behind Fly's proxy with
  `SLICELY_TRUST_PROXY=1`, and that the `__Host-` cookie is set (needs HTTPS, which Fly
  terminates for you).

