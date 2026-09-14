# Slicely public launch — design

**Date:** 2026-09-12
**Status:** Approved (owner answered the four open questions in chat)
**Branch:** `slicely-v3` → merge to `main` at the end

## Goal

Release Slicely to the public as "type anything you want, print anything you want":
a hosted web app anyone can open, and a downloadable macOS app. Users bring their own
Anthropic API key so AI usage bills them, not the owner. The owner's sourcing keys
(Thingiverse, GitHub, MyMiniFactory, Smithsonian) stay server-side. The product must be
safe to expose to hostile traffic, legally covered (terms, privacy, AGPL §13), and the
UI must be excellent on day one.

## Decisions (locked)

| Question | Decision | Why |
| --- | --- | --- |
| AI auth | **BYO Anthropic API key**, one provider | Anthropic's terms prohibit third-party claude.ai login and routing through Pro/Max credentials (code.claude.com/docs/en/legal-and-compliance). OpenAI's "Sign in with ChatGPT" is identity-only. API keys are the sanctioned path and bill the key owner. |
| Second provider (OpenAI) | **Not at launch** | Owner chose one provider to ship fastest. |
| UI | **One UI: Electron loads the web client** over a loopback Express server; `src/renderer/` deleted | Renderer is a smaller, older copy (no jobs, chats, preview, search, links). Every feature was being built twice. |
| Hosting | **Fly.io via Docker** with headless PrusaSlicer and a persistent volume | Simple, cheap, secrets built in. |
| Mac signing | **Unsigned for now**; signing/notarization wired to env vars for later | Owner has no Apple Developer ID yet. Download page carries right-click-to-open instructions. |
| Scope boundary | Unchanged: find → slice → print. No CAD, no geometry generation. | Standing product decision. |
| Free tier on owner's key | **None.** No key → chat disabled with explanation; search/browse still work. | Owner: "instead of my personal one". |

## Architecture overview

```
Browser ─┐                          ┌── Anthropic API (user's key, server-side proxy)
Electron ┼─ HTTPS ─► Express (src/server) ┼── sourcing providers (owner's keys, env)
 (loopback)         │ session cookie      ├── PrusaSlicer CLI (semaphore-bounded)
                    │ per-session dir     └── printer drivers (SSRF-guarded)
                    └─ encrypted per-session secrets (user AI key, printer creds)
```

- **Electron** = `startServer({ port: 0, host: 127.0.0.1, mode: "desktop" })` + `win.loadURL`.
  Desktop mode keeps LAN transports and discovery; the server binds loopback only and
  requires a per-launch random bearer token in a cookie set by main.ts so other local
  processes can't drive it. The preload exposes only native-only actions
  (`openGcode`, `revealGcode`, `pickFiles`, `pathsForDrop` — see §4); the web client
  feature-detects `window.slicely`.
- **Web** = the same server in `mode: "hosted"` (multi-user on by default).

## Components

### 1. User AI key (BYO)

- `src/server/keyvault.ts`: AES-256-GCM encrypt/decrypt with `SLICELY_MASTER_KEY`
  (32 bytes, base64, from env; on desktop derived once and stored in
  `app.getPath("userData")`). Ciphertext stored in the session record on disk
  (`<session>/secrets.json`, 0600). Never logged; never returned to the client; the
  client only ever sees `{ hasKey: true, keyHint: "…a1b2" }`.
- Routes: `PUT /api/key {apiKey}` validates format (`sk-ant-`) then makes one
  `client.models.list({limit:1})` call; on 401 → 400 "key rejected". `DELETE /api/key`.
  `GET /api/config` → `{ mode, hasKey, keyHint, multiUser, slicerAvailable, sourceCommit,
  version }` (replaces the 403 discovery probe and Electron's `ConfigState`).
- `SlicelyAgent` is constructed with the session's key (`new Anthropic({ apiKey })`,
  `maxRetries: 2`); its errors are mapped: 401 → "Your key was rejected — update it in
  Settings", 429 → "Your Anthropic account is rate-limited", 402/billing → "Your Anthropic
  account has no credit". The `.env` wording is removed from user-facing strings.
- The owner's `ANTHROPIC_API_KEY` env var is **not read for a visitor's chat**. It remains
  only as an operator fallback, gated on desktop mode or an explicit
  `SLICELY_ALLOW_OPERATOR_KEY=1` — so a hosted deployment that merely has the variable in
  its environment never spends it on strangers. Where it does apply, `userKeyHint()`
  reports "this server's key" rather than the owner's last four characters.
- First-run UI: a "Connect your Claude key" card in the transcript empty state and in
  Settings → "AI". Copy tells users to create a personal key with an expiry at
  console.anthropic.com, says the key is encrypted at rest and sent only to Anthropic,
  and states plainly that Claude Pro/Max subscriptions can't be used here.
- Electron persists the encrypted key across launches (session store lives in userData
  with no idle expiry in desktop mode). Web sessions keep it for the cookie's life
  (raised to 30 days idle for hosted mode; the workspace files still sweep at 2 h idle
  but `secrets.json`, `settings.json`, and chats survive until the session expires).

### 2. Rate limiting and resource bounds

- `rateLimiter` keyed on the **verified** session id (`req.session.id`, set by
  `sessionMiddleware`, which now runs first) — never the raw cookie. IP fallback only
  for requests with no valid session, and `trust proxy` enabled only when
  `SLICELY_TRUST_PROXY=1`.
- Tiers (per session, token bucket): `api` 60 burst / 5 per s; `chat` 6 burst /
  1 per 20 s; `heavy` (`/api/slice`, `/api/jobs/:id/run`, `/api/import`, `/api/upload`)
  10 burst / 1 per 10 s. Plus per-IP `session-mint` 20/h so one client can't create
  thousands of workspaces.
- Sessions are minted only on `/api/*` calls, not on static files or `/healthz`.
- PrusaSlicer: a process-wide semaphore (`SLICELY_MAX_SLICES`, default 2) with a queue
  and a 10-minute per-slice timeout; the agent's progress channel reports "waiting for a
  free slicer".
- Uploads: multer `diskStorage` into the session's scratch dir; 200 MB per file, 12 files,
  600 MB per request; zip entry count and total-uncompressed caps in both extractors.
- Chat: message ≤ 8,000 chars; attachments list ≤ 12.
- `sweep()`/`destroy()` call `disposeSessionState` and `disposeSessionSettings`.

### 3. Security fixes

| Gap | Fix |
| --- | --- |
| Global printer registry | `PrinterRegistry` instance per session, files under `<session>/printers.json` + encrypted `<session>/printer-secrets.json` (keyvault). Desktop mode: one registry in userData. All `/api/printers*` routes go through `req.session.printers`. |
| `file` transport arbitrary write | `file` transport allowed only in desktop mode; `outputDir` must be inside the user's home and not a dotfile dir; `jobName` sanitised to a basename with an allow-listed extension. |
| SSRF redirects | `guardedFetch` uses `redirect: "manual"`, re-asserts `assertPublicHttpUrl` per hop, max 5 hops. Pin the resolved IP where possible (custom `lookup` in undici dispatcher) and check **all** A/AAAA records. Add 100.64/10, 192.0.0/24, 192.0.2/24, 198.18/15, 224/4, 240/4; normalise numeric hosts; DNS failure = block. Ports restricted to 80/443/8080/8443 for sourcing. |
| Printer drivers unguarded | `fetchTimeout` → `guardedPrinterFetch`: in hosted mode only cloud transports exist so hosts must resolve public; in desktop mode private hosts are allowed but loopback/metadata (169.254/16, 127/8, ::1) are always refused. |
| Agent `resolvePath` escapes session | `resolvePath` confines to `currentSession().dir` (and `downloadsDir` for desktop); anything else → tool error "that file isn't in your workspace". |
| Session secret in git | Untrack `.session-secret`, rotate, `.gitignore` it; default hosted workdir is `/data` (volume), default desktop workdir is `app.getPath("userData")`, dev workdir `~/Slicely-dev`. Repo root is never the workdir. Delete stray `.printers.json.*.tmp`, remove `jobs.json`, `printers.json`, `settings.json`, `sessions/` from the tree. |
| Headers | Add HSTS (hosted, https only), `Permissions-Policy`, CSP `frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Cookie `__Host-slicely_sid` with `Secure` forced in hosted mode, `SameSite=Lax`. |
| GET side effects | `GET /api/chats/:id` becomes read-only; `POST /api/chats/:id/activate` switches. `GET /api/printers/discover` → `POST`. |
| Error disclosure | `wireError(err)` maps to generic messages; absolute paths stripped from every wire payload (a `displayPath()` helper returns paths relative to the session). `express.static` serves only `dist-web/web` (built JS, no `.map`, no `.ts`) and `src/web/*.html|css` via an allow-list. |
| Multi-user default | `mode` is explicit: `hosted` (default for `npm run serve` and Docker) or `desktop` (Electron). `SLICELY_MULTI_USER` env is retired in favour of `SLICELY_MODE`. |
| Data deletion | `DELETE /api/session` destroys the workspace, secrets, chats; UI "Delete my data" button in Settings. |
| Dependency audit | `npm audit --omit=dev` must be clean of high/critical; pin `multer` 2.x. |

### 4. One UI

- Delete `src/renderer/`, `tsconfig.renderer.json`'s renderer entry, and the copy-assets
  step for it. `dist-web/web` is the only browser build.
- `main.ts`: start server (desktop mode, loopback, port 0), open `BrowserWindow` with
  `sandbox: true`, `contextIsolation: true`, `setWindowOpenHandler` → deny + `openExternal`
  for http(s), `will-navigate` deny, CSP delivered via `session.webRequest.onHeadersReceived`
  from the same `securityHeaders()` string. Native drop: preload passes real paths via
  `webUtils.getPathForFile`, so uploads on desktop copy from disk instead of re-uploading.
- Preload surface as shipped: `openGcode(token)`, `revealGcode(token)`, `pickFiles()`,
  `pathsForDrop(files)`. Tokens only, never raw paths inward. (`openInSlicer` and
  `version()` were specced above but removed before release: nothing in the client called
  either, and an unused channel is still a channel a compromised page can call. An "Open in
  PrusaSlicer" button would need a MODEL-path token, not the G-code one.)
- `POST /api/attach-local` accepts a path anywhere in the D5 desktop root set — the session
  directory, the app's downloads folder, `$HOME` **and `/Volumes`** (so a model on an
  external disk or a USB stick can be dropped in), hidden components refused and
  containment decided on the real path — not `$HOME` alone.
- Web client shows "Open in PrusaSlicer" / "Reveal in Finder" only when `window.slicely`
  exists.

### 5. Web client polish and organisation

- Split `src/web/app.ts` into `app.ts` (boot/wiring), `api.ts` (fetch/SSE), `chat.ts`,
  `cards.ts`, `jobs.ts`, `printers.ts`, `settings.ts`, `ui.ts` (dom helpers, toasts,
  sheets, menus), `markdown.ts`. Plain ESM, no bundler.
- Accessibility: menus are `<button role="menuitem">` with arrow-key navigation; sheets are
  `role="dialog" aria-modal="true"` with focus trap/restore (port from `site/main.js`);
  `aria-label` on icon buttons; `alt` on thumbnails; `aria-expanded` wiring.
- Confirmations: remove printer, arm auto-start (explains the bed-clearance risk), delete
  chat, delete my data.
- Truthful state: auto-start armed state comes from `GET /api/printers` on load; poll
  interval reacts to sheet open/close.
- Error surface: one `.error-card` component (message + retry) replaces inline colour;
  loading skeletons for settings/printers/sources; empty vs failed states distinguished.
- Mobile: `env(safe-area-inset-bottom)` on the composer; header pills wrap; tablet
  breakpoint at 1024px.
- Onboarding: empty-state shows three steps (Connect your key → Tell it what to print →
  Connect a printer, optional) with the key card inline.
- Footer/about links in Settings: Terms, Privacy, Source (commit), Version.

### 6. Landing page (`site/`)

Same design system (dark canvas, coral accent, aurora, glass cards, reduced-motion gates).
Changes:

- Hero: "Type what you want to print. Slicely finds it, slices it, and sends it to your
  printer." CTAs: **Open the web app** (→ `APP_URL`) and **Download for Mac** (→ latest
  GitHub Release DMG, with "Apple silicon & Intel · unsigned build, right-click → Open"
  microcopy until signing exists). Waitlist modal removed; `apps-script.gs` deleted.
- Hero animation: a minimal looping three-stage sequence — typed prompt → model card
  appears → slice metrics fill → "Sent to printer ✓" — pure CSS/HTML, ~9 s loop.
- How it works: Bring your key → Say what you want → Slicely finds & slices → Send to
  your printer. Explicit line: "Prints never start on their own — you arm that per printer."
- Features: 11 sources; paste any link; upload your own; orientation scoring; smart slice;
  multi-part jobs; multi-colour; 6 printer transports; chat history; model/effort picker.
- "Bring your own AI" section with the exact key wording (see §7).
- Web vs Mac comparison table (from README).
- Footer: Terms · Privacy · Source (GitHub) · MIT · Made by ishmael07.
- One brand mark: the `◆` glyph used by the app; favicon updated to match.
- `<head>`: canonical, `og:*`, `twitter:card`, `og:image` (`site/og.png`, generated 1200×630
  from the same palette), `robots.txt`, `sitemap.xml`. Inter self-hosted (woff2 in
  `site/fonts/`).
- `site/config.js` holds `APP_URL`, `DOWNLOAD_URL`, `REPO_URL` so nothing is hardcoded.

### 7. Legal

- `legal/terms.md` and `legal/privacy.md` (source) rendered to `site/terms.html`,
  `site/privacy.html`, and served by the app at `/terms` and `/privacy`. Placeholders:
  `{{ENTITY}}`, `{{CONTACT_EMAIL}}`, `{{JURISDICTION}}`, `{{EFFECTIVE_DATE}}`. Header note
  in the source files: "Template. Not legal advice. Have a lawyer review before launch."
- Terms cover: BYO key (user is responsible for their Anthropic account and charges); the
  service is provided as-is; **3D printing safety** (user is solely responsible for
  supervising their printer, bed clearance, fire risk; Slicely never starts prints unless
  the user arms it); third-party model licences (user must respect each model's licence;
  Slicely displays it); acceptable use (no illegal items, no circumventing source sites,
  no abuse of the service); no warranty on slice settings; limitation of liability;
  termination; governing law.
- Privacy covers: what is stored (session cookie, chats, uploaded/downloaded models,
  slices, printer connection details, encrypted API key), where (server volume or the
  user's Mac), retention (hosted: 30 days idle, workspace files 2 h idle), who receives
  data (Anthropic for chat with the user's own key; model sites for search; the user's
  printer), no analytics/ads, "Delete my data" button, contact.
- AGPL §13: `GET /api/config` returns `sourceCommit`; Settings and the site footer link
  to `REPO_URL/tree/<commit>`; `Dockerfile` bakes the commit in. `LICENSING.md` updated
  to record the choice (comply by publishing).
- App-side consent: first visit shows a compact banner "By continuing you agree to the
  Terms and Privacy Policy" (functional cookie only, no tracking, so no cookie-consent
  wall).

### 8. Mac distribution

- `build/icon.icns` generated from the `◆` mark (also `icon.png` for Linux later).
- electron-builder: `files` pruned to `dist/**`, `dist-web/**`, `package.json`, and
  production deps only (`asar: true`, `npmRebuild: false`); `mac.target: dmg + zip`,
  `arch: [universal]`, `hardenedRuntime: true`, `entitlements.mac.plist` (network client,
  files user-selected), `gatekeeperAssess: false`, `notarize` via `APPLE_ID`/
  `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` when set (skipped otherwise);
  `publish: github` so `npm run release:mac` uploads to a GitHub Release.
- Unsigned fallback: DMG includes a `How to open.txt` explaining right-click → Open, and
  the download page repeats it.
- PrusaSlicer detection at first launch: if missing, the UI shows a card with the download
  link (already partly present).

### 9. Deployment

- `Dockerfile` (node:20-bookworm-slim): installs PrusaSlicer 2.9.x Linux AppImage
  dependencies + extracts the AppImage to `/opt/prusaslicer`; `PRUSASLICER_PATH` set;
  builds the app; runs as non-root; `SLICELY_MODE=hosted`, `SLICELY_WORKDIR=/data`.
- `fly.toml`: 1 shared-cpu-2x 2 GB machine to start, volume `slicely_data` at `/data`,
  `[http_service]` with `force_https`, health check `/healthz`, `SLICELY_TRUST_PROXY=1`.
- `.env.example` rewritten: server secrets (`SLICELY_MASTER_KEY`, sourcing keys), no
  `ANTHROPIC_API_KEY`. `docs/DEPLOY.md` with the `fly secrets set` commands.
- `scripts/gen-master-key.mjs`.

## Data flow: one chat turn (hosted)

1. Browser `POST /api/chat` with cookie → `sessionMiddleware` verifies HMAC, loads
   session → `chat` limiter → handler.
2. Handler loads the session's encrypted key via keyvault; none → 409
   `{ error: "no_key" }` → UI shows key card.
3. `SlicelyAgent` (per session, cached) streams; tools run under
   `runWithSession(session)`; `resolvePath` confines; PrusaSlicer waits on the semaphore.
4. Anthropic auth/billing errors are mapped to user-facing codes; the raw message is
   logged server-side only with the session id, never the key.

## Error handling principles

- Every wire error is `{ error: string, code?: string }` with a stable `code` the UI can
  branch on (`no_key`, `key_rejected`, `rate_limited`, `slicer_busy`, `not_in_workspace`).
- Absolute paths never reach the client.
- Upstream provider bodies are logged, not relayed.

## Testing

- TDD for every security fix: failing test first (rate-limit key spoofing, redirect SSRF,
  printer isolation across two sessions, file-transport path rejection, `resolvePath`
  confinement, cookie flags, `GET` no longer mutating, key never appears in any response
  body, keyvault round-trip and wrong-master-key failure).
- Existing 374 tests stay green.
- Web client: `browser-automation` skill drives the hosted build headlessly: first-run
  key card → paste invalid key → error; settings sheet a11y (focus trap); confirm dialogs;
  landing page renders with no console errors at 400px and 1280px.
- Electron: `npm start` boots, loads the loopback URL, `window.slicely` present, drop
  uploads from disk, "Open in PrusaSlicer" visible; DMG builds via `npm run dist:mac`.
- Docker: image builds; `docker run` serves `/healthz` and `/api/config` with
  `mode: "hosted"`; PrusaSlicer `--help` works inside the container.

## Out of scope

- OpenAI or other providers.
- Accounts/passwords/social login (identity = session; BYO key is the only credential).
- Payments, subscriptions, a free tier.
- CAD / geometry generation.
- Windows/Linux desktop builds (Linux icon asset only).
- Multi-instance session store (single Fly machine with a volume).

## Work breakdown (for the plan)

A. Hygiene & secrets (untrack, rotate, workdir move, gitignore, cleanup) — small, first.
B. Session/key vault + `/api/key` + `/api/config` + agent key plumbing.
C. Rate limiting tiers, session-mint limiter, slice semaphore, disk uploads, chat caps.
D. Security fixes (registry per session, file transport, SSRF, drivers, resolvePath,
   headers, cookie, GET→POST, error mapping, static allow-list, mode flag, delete-session).
E. One UI: Electron → loopback server + web client; delete renderer; preload trim; sandbox.
F. Web client split + a11y + confirmations + states + onboarding + mobile.
G. Landing page rewrite + animation + legal pages + SEO assets.
H. Legal templates + AGPL source link.
I. Mac packaging (icon, builder config, entitlements, release script, unsigned notes).
J. Docker + Fly + DEPLOY.md + .env.example + README refresh.
K. Verification pass (tests, headless browser, Electron boot, Docker build), then merge.

Parallelisable: B/C/D touch `src/server` and `src/main` (one agent, sequential within);
E depends on B (config endpoint) and D (mode flag); F is independent of B–E except for the
key card contract (`/api/config`, `/api/key`) which is fixed above; G/H are independent;
I is independent; J depends on D (mode flag names).
