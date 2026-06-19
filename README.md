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
| 📐 **Inspect** | Runs `PrusaSlicer --info` for real dimensions, volume, triangle count, watertightness. |
| 🎛️ **Recommend settings** | Suggests layer height / infill / supports / brim based on the model's geometry, with a plain-language rationale. |
| 🍰 **Slice** | Slices to G-code with PrusaSlicer and reports estimated print time, filament used (g / m), cost, and layer count. "Just slice it" auto-applies the recommended settings — no extra step needed. |
| 🟢 **Live slicer status** | A status pill shows in real time whether PrusaSlicer is installed and whether you have it **open** — and it doesn't confuse Slicely's own background slices for the app being open. |
| 🖥️ **Hand off** | Opens any model (or the sliced G-code) in the PrusaSlicer GUI, or reveals the G-code in Finder. |

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
- *"Open it in PrusaSlicer"* → hands off to the GUI.

For Printables/MakerWorld cards, click **Open in browser** to download from the source.

---

## Configuration reference (`.env`)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | — | Powers the agent. |
| `THINGIVERSE_APP_TOKEN` | for downloads | — | Enables in-app Thingiverse search + download. |
| `SLICELY_MODEL` | | `claude-opus-4-8` | Claude model id. |
| `SLICELY_EFFORT` | | `high` | Agent reasoning effort: `low`/`medium`/`high`/`xhigh`/`max`. |
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
