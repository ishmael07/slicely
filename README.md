# Slicely

**An AI agent that finds free, open-source 3D-printable models online and slices them with PrusaSlicer — in a little chat-bar app for your Mac.**

Tell Slicely what you want to print ("I want to 3D print a model car"). It searches Thingiverse, Printables, and MakerWorld, shows you the options, downloads the one you pick straight into your workspace, reads its real dimensions, recommends optimal slicing settings, and slices it — giving you accurate print-time, filament, and cost numbers. All through a conversation.

> **MVP scope:** PrusaSlicer is the supported slicer. Thingiverse is the marketplace Slicely can download from directly in-app; Printables and MakerWorld are searched too, but their downloads open in your browser (those sites gate downloads behind login).

---

## What it does

| Capability | How |
| --- | --- |
| 🔎 **Find models** | Searches Thingiverse + Printables + MakerWorld in one query, with thumbnails, creators, and licenses. |
| ⬇️ **Import** | Downloads a Thingiverse model's STL/3MF directly into `~/Slicely/downloads`. (Printables/MakerWorld → opens the page in your browser.) |
| 📤 **Upload your own CAD** | Drag-and-drop or pick an **STL · 3MF · OBJ · AMF · STEP** file — or a **ZIP of parts**, which Slicely unpacks. It becomes the active model and flows straight into inspect → recommend → slice. (STEP opens in PrusaSlicer to convert; the mesh formats slice directly.) |
| 🧩 **Multi-part & multi-plate** | Models that come as several STLs (or a ZIP) are **merged onto one plate and auto-arranged** with the same object-gap PrusaSlicer uses, so every part actually makes it into the G-code. If they (or your copies) **don't all fit one bed, Slicely splits them across multiple plates** and slices each — one metrics panel per plate ("Plate 1 of 3"). Plate packing mirrors PrusaSlicer's arranger (no part rotation, profile-derived spacing), so a plate it accepts is one the slicer can place; over-packed plates are caught, not silently shortened. Oversized parts are flagged to scale down. Open any plate in PrusaSlicer with one click. |
| 🎛️ **Max-out slicing** | Beyond settings: make N auto-arranged **copies**, **scale**, **rotate**, **merge** parts, and set a **filament colour** (preview-only on a single-extruder printer — Slicely says so plainly). **Supports and brim are decided automatically** from geometry, and for a multi-part plate they're aggregated across **all** parts (supports on if any part needs them; brim sized for the trickiest part). |
| 📐 **Inspect** | Runs `PrusaSlicer --info` for real dimensions, volume, triangle count, watertightness. |
| 🧠 **Reason about the print** | Picks accurate settings from the model's geometry **and your goal** — fast (draft), detail (quality), or strength (functional) — plus material (PLA/PETG/ABS) and nozzle. Sets layer height (nozzle-bounded), infill % + pattern, walls, solid layers, supports + threshold, and brim, each with a rationale. Warns on bed-fit, non-watertight meshes, and material gotchas so prints don't fail. |
| 🖨️ **Printer setup for newcomers** | If you've never run PrusaSlicer's wizard, Slicely detects it and asks which printer you have, then synthesizes a matching config (bed size + nozzle + **filament density/cost** so weight & cost are realistic). Forces plain-text G-code so metrics always parse. Already configured? It uses your profile — the most accurate option. |
| 🍰 **Slice** | Slices to G-code with PrusaSlicer and reports estimated print time, filament used (g / m), cost, and layer count. "Just slice it" auto-applies the goal-aware recommended settings — no extra step. |
| 🪄 **Show me the finished slice** | Say *"slice it and open it"*, *"show me the finished product"*, or *"open the export g-code"* and Slicely slices headlessly for accurate numbers, **then opens the finished result in PrusaSlicer's G-code viewer — the toolpath/export view, no Slice click needed**. A "View finished slice" button on every metrics panel does the same. (A plain *"open it"* instead opens the **editable** PrusaSlicer with your settings loaded, ready to slice — PrusaSlicer has no API to auto-press Slice inside the editor, so the only zero-click finished view is the G-code viewer, reserved for these explicit requests.) |
| 💬 **Clean chat UI** | Replies render as real markdown (headings, **bold**, lists, `code`, callouts), with the model's reasoning in a collapsible "Thought process" block. |
| 🧠 **Pick model & effort** | A dropdown under the chat box (Cursor/ChatGPT-style) lets you choose the Claude model (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) and reasoning effort. Slicely only sends each model the params it supports, so the picker never errors. |
| 🟢 **Live slicer status** | A status pill shows in real time whether PrusaSlicer is installed and whether you have it **open** — and it doesn't confuse Slicely's own background slices for the app being open. |
| 🖥️ **Hand off** | Opens any model (or the whole multi-part plate) in the **editable PrusaSlicer** with your settings loaded, ready to slice; opens the finished **G-code in the viewer** when you ask to see the result; or reveals the G-code in Finder. |

---

## Requirements

- **macOS** (the app drives the macOS PrusaSlicer app bundle).
- **Node.js 18+** and npm — to install and run. (Get it from [nodejs.org](https://nodejs.org) or `brew install node`.)
- **[PrusaSlicer](https://www.prusa3d.com/page/prusaslicer_424/)** installed at `/Applications/PrusaSlicer.app` (for inspect/slice; search & import work without it).
- An **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)).
- A free **Thingiverse App Token** ([thingiverse.com/apps/create](https://www.thingiverse.com/apps/create)) — needed only for in-app downloads.

---

## Setup

```bash
git clone https://github.com/ishmael07/slicely.git
cd slicely
npm install

# Configure your keys
cp .env.example .env
#   then open .env and fill in:
#     ANTHROPIC_API_KEY=...           (required)
#     THINGIVERSE_APP_TOKEN=...       (for in-app downloads)
```

### Getting the keys

- **Anthropic API key** → [console.anthropic.com](https://console.anthropic.com) → *Settings → API Keys*.
- **Thingiverse App Token** → sign in at [thingiverse.com/apps/create](https://www.thingiverse.com/apps/create), create an app (any name), and copy the **App Token** it shows. No OAuth flow needed — the static token works for search and download.

### (Recommended) Give PrusaSlicer your real printer profile

By default, slices use PrusaSlicer's generic built-in settings. For numbers that match *your* printer and filament:

1. Open PrusaSlicer, pick your printer + print + filament presets.
2. **File → Export → Export Config…** → save the `.ini`.
3. In `.env`, set `PRUSASLICER_CONFIG_INI=/absolute/path/to/your-config.ini`.

---

## Run

```bash
npm start
```

This compiles the TypeScript and launches the Slicely chat-bar window.

To build a distributable `.dmg`:

```bash
npm run dist:mac
```

---

## Using it

Type what you want to print, or click one of the example prompts:

- *"I want to 3D print a model car"* → Slicely searches and shows cards.
- Click **Import** on a Thingiverse card → it downloads, reads the dimensions, and recommends settings.
- *"Slice it with 0.2mm layers and 20% infill"* → real print-time and filament metrics.
- *"Open it in PrusaSlicer"* → opens the **editable PrusaSlicer** with your settings loaded and **auto-slicing on** (Slicely flips PrusaSlicer's background-processing preference), so just click the **Preview** tab — the toolpaths are already there, no Slice click.
- *"Show me the finished product"* / *"open the export g-code"* → slices for accurate numbers, then opens the finished **G-code in PrusaSlicer's read-only viewer** (toolpaths + export) — zero clicks.

**Upload your own model:** drag an STL (or 3MF / OBJ / AMF / STEP, or a **ZIP of parts**) anywhere onto the window, or click the **＋** button next to the composer. It's copied into your workspace, becomes the active model, and Slicely inspects + offers to slice it. Multiple parts (or a ZIP) are arranged together on one plate.

**Max out a print:** ask Slicely to *"print 4 copies"*, *"scale to 50%"*, *"rotate 90°"*, *"merge the parts"*, or *"set the colour to blue"*. (On a single-extruder printer, colour only changes the preview, not the physical print — Slicely will remind you.)

**Choose model & effort:** click the model pill **under the chat box** (e.g. "Opus 4.8 · high"). Pick Opus 4.8 / Sonnet 4.6 / Haiku 4.5 and a reasoning-effort tier. Your choice persists across restarts, and unavailable effort tiers are greyed out per model.

> **On "live" GUI control:** PrusaSlicer exposes no API to puppeteer its already-open window, auto-press the Slice button, or open the editor straight onto its Preview tab (any action flag forces headless mode; tab control is internal). So Slicely does the honest equivalent: *"open it"* opens the **editable PrusaSlicer** with the model arranged, your settings loaded, and PrusaSlicer's **background-processing** preference turned on — so the model slices in the background as it loads and you just click **Preview** (no Slice click, no wait). If PrusaSlicer was already running when that preference had to change, it'll say to restart it once for auto-slicing to apply. When you only want to **look** at the finished result (*"show me the finished slice"*), Slicely slices **headlessly** and opens the **already-sliced G-code in the read-only viewer** (zero clicks). More reliable than fragile click-automation.

For Printables/MakerWorld cards, click **Open in browser** to download from the source.

---

## Configuration reference (`.env`)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | — | Powers the agent. |
| `THINGIVERSE_APP_TOKEN` | for downloads | — | Enables in-app Thingiverse search + download. |
| `SLICELY_MODEL` | | `claude-opus-4-8` | Default Claude model (the in-app model picker under the chat box overrides this and persists your choice). |
| `SLICELY_EFFORT` | | `high` | Default reasoning effort: `low`/`medium`/`high`/`xhigh`/`max` (also overridable in-app). |
| `PRUSASLICER_PATH` | | `/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer` | PrusaSlicer binary. |
| `PRUSASLICER_CONFIG_INI` | | — | Your exported printer/filament config (strongly recommended). |
| `SLICELY_WORKDIR` | | `~/Slicely` | Where downloads (`/downloads`) and G-code (`/slices`) are saved. |

---

## How it's built

```
src/
  shared/types.ts          Types shared across main / preload / renderer + IPC contract
  main/
    config.ts              Loads .env into a typed config
    main.ts                Electron main: frameless window + IPC wiring
    preload.ts             contextBridge → secure window.slicely API
    agent/
      agent.ts             Streaming Claude tool-use loop (Anthropic SDK)
      tools.ts             Tool schemas + executor (search/import/inspect/slice…)
      state.ts             Per-session state (last results, active model)
    providers/
      thingiverse.ts       Search + direct download (App Token, Bearer auth)
      printables.ts        GraphQL search (download → browser)
      makerworld.ts        Best-effort search (download → browser)
      index.ts             Parallel multi-source search + download dispatch
    prusaslicer.ts         CLI: detect/version, --info parse, slice, metric parse, GUI open
  renderer/
    index.html / styles.css / renderer.ts   The chat-rectangle UI
```

The agent is a streaming [Anthropic tool-use loop](https://docs.anthropic.com/): Claude decides when to search, import, inspect, recommend, and slice. Each tool both feeds a result back to the model *and* emits a structured event that the UI renders as model cards or metric panels — so the chat stays readable while the rich data shows up inline.

The renderer is compiled separately as an ES module (`tsconfig.renderer.json`) so it runs safely in the browser context with no Node access; the main process and preload are CommonJS. Communication is exclusively over a typed, context-isolated IPC bridge.

---

## Notes & limitations

- **Downloads:** Only Thingiverse supports unattended in-app download. Printables and MakerWorld gate downloads behind login, so Slicely hands those off to your browser. (MakerWorld's default license is also not open-source — it's there for discovery.)
- **Slicing recommendations** are geometry-based heuristics and a starting point, not a guarantee — always eyeball the PrusaSlicer preview for overhangs before printing.
- **Binary G-code:** Slicely parses plaintext G-code comments for metrics. If your PrusaSlicer profile outputs binary G-code (`.bgcode`), disable that option so metrics can be read.
- This is an MVP. PrusaSlicer is the only wired-up slicer; the detection layer already recognizes OrcaSlicer/BambuStudio/Cura/SuperSlicer for a future multi-slicer release.

## License

MIT
