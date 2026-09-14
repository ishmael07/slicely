# Slicely

**Vibe 3D printing.** Say what you want to print — Slicely finds it across a dozen model sources, works out how to slice it, and sends it to your printer. Run it as a **website anyone can open**, or as a **macOS app**.

Slicely finds, slices, and prints. It is not a CAD modeler — it works with models that already exist, plus whatever you upload or paste a link to.

```
"I want a phone stand"  →  searches 11 sources  →  picks the best orientation
                        →  slices for YOUR printer  →  sends it to the printer
```

---

## Two ways to run it

| | Web | macOS app |
| --- | --- | --- |
| **Install** | None — open a link | Download / `npm start` |
| **Who** | Anyone, many at once | You |
| **Slicing** | Server-side (headless PrusaSlicer) | Your local PrusaSlicer |
| **Cloud printers** (Bambu, Prusa Connect) | ✅ | ✅ |
| **LAN printers** (OctoPrint, Klipper, PrusaLink) | Only when self-hosted on the same network | ✅ |
| **Open in the PrusaSlicer GUI** | — (no GUI on a server) | ✅ |

The two share one core. Only `main.ts` and `preload.ts` touch Electron; everything else — agent, slicer, sourcing, printers, jobs — is portable Node used by both.

> **Why LAN printers can't work on a public deployment:** your printer sits at `192.168.x.x` behind your router. A hosted server can't route to it, and browsers can't open raw TCP or MQTT. Cloud-connected printers work anywhere; LAN printers need Slicely running on your own network (or a tunnel like OctoEverywhere / Obico).

---

## Download

Grab the latest build from **[GitHub Releases](https://github.com/ishmael07/slicely/releases/latest)**.

- **Apple silicon only, for now** — no Intel DMG yet.
- **Unsigned build.** First launch: right-click `Slicely.app` → *Open* → *Open*. Or:
  *System Settings → Privacy & Security → Open Anyway*.
- **Prefer to build it yourself?** `npm run dist:mac` builds the same DMG from source —
  see [Setup](#setup) below.

---

## What it does

| Capability | How |
| --- | --- |
| 🔎 **Find models everywhere** | One query across **Thingiverse, Printables, MyMiniFactory, NIH 3D, Smithsonian, NASA, GitHub, MakerWorld, Thangs, Yeggi, STLFinder**. Results are ranked across sources, and ones Slicely can actually download outrank ones that need a browser. A source being down never blanks your results. |
| ⬇️ **Actually get the file** | Direct download from Thingiverse, Printables, MyMiniFactory, NIH 3D, Smithsonian, NASA, and GitHub. |
| 🔗 **Paste any link** | A model page, a raw `.stl`, a `.zip` of parts, or a GitHub repo — Slicely resolves it, finds the meshes, and downloads them. Unknown pages get scraped for mesh links. |
| 📤 **Upload your own** | Drag-and-drop **STL · 3MF · OBJ · AMF · STEP**, or a **ZIP of parts** that Slicely unpacks. |
| 🧭 **Pick the orientation** | Scores candidate poses on overhang area, bed contact, and layer count, weighted by your goal — then explains its choice in plain language. A pose that barely touches the bed is rejected as unprintable. |
| 🧠 **Smart-slice** | Layer height, infill %, pattern, walls, solid layers, supports, and brim derived from the real geometry plus your goal (fast / detail / strength), material, and nozzle. Override anything; everything else adapts. |
| 🧩 **Big multi-part jobs** | Dozens of parts planned as one **job**: oriented, grouped so each plate needs the fewest tool changes, packed across as many plates as it takes, then sliced in order. One plate failing doesn't stop the rest. |
| 🎨 **Multi-colour, one part** | Two ways, neither needing the GUI. **Split it:** many STLs that look like one object hold several (a nameplate's letters, a logo's rings, a whole set in one file) — Slicely separates them so each gets its own filament. **Band it:** colour by height, pausing for a filament swap at each boundary, which works on **any** printer including single-extruder machines with no AMS. |
| 🎨 **Multi-colour, many parts** | Requested colours are matched against the filament **actually loaded** in your AMS/MMU — exact match where possible, nearest perceptual colour (CIE Lab) otherwise, and it says so. Estimates tool changes and purge waste. Single-extruder printers are told plainly that colour is preview-only. |
| 🖨️ **Send it to the printer** | **OctoPrint · Klipper/Moonraker · PrusaLink · Prusa Connect · Bambu (LAN upload over FTPS) · file/SD**. Scan your network to find printers, or add one by address. Live state, progress, temperatures, and loaded filaments. Pause / resume / cancel. |
| 💬 **Chat UI** | Streaming markdown replies with a collapsible thought process, model cards, and slice-metric panels inline. Pick your Claude model and reasoning effort. |

---

## Safety: prints do not start on their own

Uploading a job and *starting* it are separate. `send` uploads and **queues**; it only starts a print if you have separately armed auto-start **for that specific printer**.

That's deliberate. Starting a print on a bed that still holds the last part wrecks the print, can damage the printer, and is a genuine fire risk — and no consumer FDM printer reliably senses a clear bed. The agent cannot arm auto-start; only you can, in settings. Checking the bed is your job.

---

## Requirements

- **Node.js 18+**
- **[PrusaSlicer](https://www.prusa3d.com/page/prusaslicer_424/)** — at `/Applications/PrusaSlicer.app` for the macOS app, or installed on the host for the web server. Search and import work without it.
- Optional, for more sources: a free [Thingiverse App Token](https://www.thingiverse.com/apps/create), `GITHUB_TOKEN`, `MYMINIFACTORY_API_KEY`, `SMITHSONIAN_API_KEY`. Printables, NIH 3D, and NASA need nothing.

---

## Bring your own key

Chat runs on **your own Anthropic API key**. Nobody has to trust an operator with
their conversations, and nobody gets a bill for somebody else's prints.

- **Get one** at [console.anthropic.com](https://console.anthropic.com) → *API keys*.
  Make it a personal key and give it an expiry. Paste it into Slicely once, in
  Settings → *AI* (or the card in an empty chat).
- **A Claude Pro or Max subscription does not work here.** Those pay for
  claude.ai, not for API calls, and Slicely will not accept a `claude.ai` login or
  a `setup-token`. An API key (`sk-ant-…`) with credit on the account is the only
  thing that works.
- **Your account is billed for your own chat**, at Anthropic's usual rates. Slicely
  adds nothing and takes nothing.
- **Where the key lives:** encrypted at rest with AES-256-GCM under
  `SLICELY_MASTER_KEY`, in your session's own `secrets.json` (mode `0600`). It is
  never logged, never in any HTTP response, and never in an error message — the
  client is only ever told `{ hasKey, keyHint }`, e.g. `…a1b2`. It leaves the
  server only in a request to Anthropic.
- **Removing it:** Settings → *AI* → *Disconnect*, or *Delete my data*, which
  takes the whole session — chats, models, slices and key — with it.
- **Running it for yourself?** The `ANTHROPIC_API_KEY` in your own environment is
  used as a fallback in desktop mode, and on a server only if you deliberately set
  `SLICELY_ALLOW_OPERATOR_KEY=1`. Read that row in the table below before you do:
  it means every visitor's chat is billed to you.

---

## Setup

```bash
git clone https://github.com/ishmael07/slicely.git
cd slicely
npm install
cp .env.example .env      # then set SLICELY_MASTER_KEY; read its notes on keys
```

## Run

```bash
npm run serve    # web  → http://localhost:3000
npm start        # macOS app
npm test         # build + full test suite
```

For slice estimates that match your real machine: PrusaSlicer → *File → Export → Export Config…*, then set `PRUSASLICER_CONFIG_INI` to that `.ini`.

---

## Using it

Type what you want, or paste a link:

- *"I want to 3D print a model car"* → searches every source, shows cards.
- *"print 4 of these in red and blue"* → plans a job, assigns colours to real AMS slots, packs the plates.
- *"how should this be oriented?"* → compares poses and explains the trade-off.
- *"slice it and send it to my printer"* → slices, uploads, queues.
- Paste `https://www.printables.com/model/...` or a GitHub repo URL → resolved and downloaded.

**Connect a printer:** settings (gear) → *Connected printers* → **Scan network**, or add one by address. Test it, then optionally arm auto-start.

---

## Configuration reference (`.env`)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SLICELY_MODE` | | `hosted` | `hosted` = a shared server anyone can reach (`__Host-` session cookie, LAN discovery and LAN-only printer transports refused, no filesystem access outside a session's own workspace). `desktop` = one person's own machine; Electron sets it. `npm run serve` and Docker default to `hosted`. |
| `ANTHROPIC_API_KEY` | | — | **Yours**, not your visitors'. Read only in desktop mode, or on a hosted server with `SLICELY_ALLOW_OPERATOR_KEY=1`. Otherwise each user connects their own key in Settings and is billed for their own chat. |
| `SLICELY_ALLOW_OPERATOR_KEY` | | off | Set to `1` to let a hosted server fall back to your `ANTHROPIC_API_KEY`. **Every visitor's chat is then billed to you**, so only for a private deployment or one you intend to pay for. |
| `SLICELY_MASTER_KEY` | ✅ hosted | — | Encrypts every session's stored Anthropic key at rest (AES-256-GCM). 32 bytes base64: `openssl rand -base64 32`. Rotating it makes stored keys unreadable, so users simply reconnect. Desktop derives one into `userData` instead. |
| `SLICELY_PORT` | | `3000` | Web server port. |
| `SLICELY_TRUST_PROXY` | | `0` | Set to `1` **only** behind a reverse proxy you control (Fly, Render, nginx), which makes `X-Forwarded-For` trusted. Per-IP rate limits and the session-mint cap depend on that address being honest, so setting it without a proxy lets any caller hand itself a fresh bucket per request. |
| `SLICELY_MAX_SLICES` | | `2` | How many PrusaSlicer processes may run at once; the rest queue, and a caller who arrives behind a full queue is told "busy" rather than held open. Each slice saturates a core. |
| `SLICELY_ENABLE_SCRAPERS` | | off | Re-enable Thangs / Yeggi / STLFinder. They are bot-blocked in practice and added ~8s to every search, so they are off by default. |
| `SLICELY_REPO_URL` | | GitHub | Where the footer's and Settings → About source link points — AGPL §13 compliance, see `src/server/LICENSING.md`. |
| `SLICELY_WORKDIR` | | `~/Slicely-data` | Downloads, slices, and per-visitor session workspaces. |
| `THINGIVERSE_APP_TOKEN` | | — | Thingiverse search + download. |
| `GITHUB_TOKEN` | | — | GitHub repository search for engineering and open-hardware parts (its API needs a token even for public repos). |
| `MYMINIFACTORY_API_KEY` | | — | MyMiniFactory search. |
| `SMITHSONIAN_API_KEY` | | — | Smithsonian (falls back to a rate-limited shared demo key). |
| `SLICELY_MODEL` | | `claude-opus-4-8` | Default model; the in-app picker overrides and persists. |
| `SLICELY_EFFORT` | | `high` | `low`/`medium`/`high`/`xhigh`/`max`. |
| `PRUSASLICER_PATH` | | macOS app bundle path | PrusaSlicer binary. |
| `PRUSASLICER_CONFIG_INI` | | — | Your exported printer/filament config (recommended). |

---

## How it's built

```
src/
  shared/         types.ts · printers.ts · sourcing.ts · jobs.ts   (contracts; no Node, no Electron)
  main/
    session-context.ts   AsyncLocalStorage session scoping — how one process serves many visitors
    agent/               Streaming Claude tool-use loop + tool schemas (v1 + v2)
    sourcing/            11 providers, universal URL resolver, guarded downloader, cross-source ranking
    printers/            6 transport drivers, registry (secrets stored separately), LAN discovery
    jobs/                Mesh parsing, orientation scoring, colour planning, plate packing, job runner
    prusaslicer.ts       CLI: detect, --info, slice, parse metrics, open GUI
    plates.ts            Bin-packing that mirrors PrusaSlicer's own arranger
    main.ts              Electron: boots the server on loopback, opens one window on it
    preload.ts           The native-only bridge (PrusaSlicer, Finder, file dialog) — tokens, never paths
  server/         Express + SSE, per-session workspaces, rate limiting, security guards
  web/            The browser client — the ONLY UI, in the browser and in the Mac app alike
```

**One UI.** The Mac app is the web app. Electron starts the same Express server the hosted deployment runs — in-process, on a random loopback port, in desktop mode — and loads `src/web` into a `BrowserWindow` over HTTP; a per-launch token in an httpOnly cookie keeps other local processes off that port. There is no second renderer, so every feature is written once. All the Mac app adds is what a browser cannot do: open a file in PrusaSlicer, reveal it in Finder, the native file dialog, and the real path of a dropped file (which `POST /api/attach-local` copies in instead of re-uploading).

**Session scoping is the key to multi-user.** Conversation state and preferences were module-level singletons — right for one Electron window, wrong for a website. `session-context.ts` carries a session id in an `AsyncLocalStorage`, and `sessionState` is a `Proxy` that resolves to the ambient session's record. Every existing call site works unchanged; Electron transparently gets a default session; each web visitor gets isolated state, their own `settings.json`, and their own workspace. Sliced G-code is addressable only by an opaque token, never a path.

---

## Notes & limitations

- **Bambu LAN** upload works (implicit FTPS, written against RFC 959/4217 since no dependency here speaks FTP). Starting the print afterwards uses a community-derived MQTT command; if it doesn't take, the file is already on the printer and can be started from its screen. **Bambu Cloud** has no documented file-submission API, so add the printer as a LAN connection to send to it.
- **Prusa Connect** publishes no third-party API. Those endpoints are documented guesses and marked unverified in the source.
- **Thangs / Yeggi / STLFinder** sit behind bot protection that blocks honestly-identified requests, so they return nothing while costing ~8 seconds per search. They are **off by default** (`SLICELY_ENABLE_SCRAPERS=1` to try them). Slicely does not spoof a browser to get around the block.
- **Login-gated sources** are handed to your browser rather than circumvented. That's the correct outcome, not a bug.
- **Orientation scoring** is a heuristic over face normals — a real area computation, but a proxy for support *volume*, not a physics simulation. Eyeball the preview.
- **Binary G-code:** metrics are parsed from plaintext G-code comments. Disable `.bgcode` output in your profile.
- **AGPL:** running PrusaSlicer as a network service triggers AGPL §13. See [`src/server/LICENSING.md`](src/server/LICENSING.md) before deploying publicly.
- PrusaSlicer is the only wired-up slicer; detection already recognises OrcaSlicer / BambuStudio / Cura / SuperSlicer for a future release.

## License

MIT
