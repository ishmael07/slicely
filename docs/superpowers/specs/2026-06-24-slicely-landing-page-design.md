# Slicely Landing Page — Design Spec

**Date:** 2026-06-24
**Status:** Approved, implementing

## Goal

A cool, sleek, modern, clean marketing landing page for Slicely (the macOS AI 3D-print
chat-bar app) with tasteful animations and a waitlist-style "Get access" flow. No app
changes, no backend proxy, no secrets touched.

## Decisions (locked)

- **Scope:** Landing page only. The Electron app stays as-is (local, bring-your-own-key
  via `.env`). No proxy, no in-app auth — that idea is shelved until there's demand.
- **Access model:** A "Get access" popup form (waitlist). On submit it stores the lead
  and shows a "You're on the list" confirmation. No DMG is handed out automatically — the
  owner emails access manually later.
- **Form fields:** Name, Email, Usage ("What would you print?"), Comments.
- **Storage:** Google Sheet via a Google Apps Script web-app endpoint that appends a
  timestamped row. The endpoint URL lives in one config constant (`WAITLIST_ENDPOINT`).
  Until it's filled in, the form runs in demo mode (shows success, logs to console).
- **Stack:** Self-contained static site in `site/` — HTML + CSS + vanilla JS, no build
  step, no framework. Deployable to Cloudflare Pages or GitHub Pages.
- **Brand:** Matches the app — dark near-black canvas, coral accent `#ff7a45` →
  `#ffb15c`, light text `#f4f4f7`.

## Visual direction

- Dark `#0a0a0b` canvas, single coral accent, subtle drifting aurora glow behind hero,
  faint grid, rounded "glass" cards, generous whitespace, confident large hero type.
- Animations (GPU-cheap, all gated behind `prefers-reduced-motion: reduce`):
  - Staggered fade/slide-up of hero content on load.
  - Slow-drifting aurora gradient behind hero.
  - Scroll-reveal of feature cards via IntersectionObserver.
  - Looping pure-CSS/HTML "chat → slice → metrics" hero mockup.
  - Button hover glow.

## Sections

1. **Hero** — wordmark, one-line pitch, `Get access` (primary) + `How it works`
   (secondary) buttons, animated chat-app mockup.
2. **How it works** — 3 steps: Get access → Open Slicely → Tell it what to print.
3. **Features** — scroll-reveal cards drawn from the README capabilities.
4. **Requirements** — macOS + PrusaSlicer note.
5. **Footer** — GitHub link, MIT license, made-by.

## Get-access flow

- `Get access` button opens an accessible modal (focus-trapped, ESC/backdrop closes).
- Fields: Name, Email (required), Usage, Comments.
- Submit → `POST` (form-encoded) to `WAITLIST_ENDPOINT` (Google Apps Script) → success
  state. Network/endpoint errors still show a graceful fallback message.
- Demo mode when `WAITLIST_ENDPOINT` is the placeholder: skip the network call, show
  success, `console.info` the payload.

## Files

- `site/index.html` — markup.
- `site/styles.css` — all styles + animations.
- `site/main.js` — modal, form submit, scroll-reveal, reduced-motion handling.
- `site/apps-script.gs` — Google Apps Script to paste into the Sheet's script editor.
- `site/README.md` — deploy + Google Sheet setup instructions.
- `site/favicon.svg` — coral wordmark mark.

## Non-goals / safety

- Reads/ships **no** secrets — no `.env`, no API keys. Pure static marketing + a form.
- No changes to `src/`, the Electron app, or build config.
