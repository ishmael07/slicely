# Slicely landing page

The static marketing site, plus the Terms and Privacy pages the app itself serves at
`/terms` and `/privacy`. Plain HTML + CSS + one small vanilla JS file — **no build step,
no framework, no secrets.**

```
site/
├── index.html        # the landing page
├── terms.html        # Terms of Service  (template — needs a lawyer)
├── privacy.html      # Privacy Policy    (template — needs a lawyer)
├── og.html           # source for og.png; rendered by scripts/make-og.mjs
├── og.png            # 1200×630 share card (committed; regenerate if og.html changes)
├── styles.css        # the whole design system, shared by all three pages
├── main.js           # fills links in from config.js, plus the scroll reveal
├── config.js         # every URL the site links to, in one object
├── favicon.svg       # the ◆ mark
├── robots.txt        # crawl-everything + sitemap pointer
├── sitemap.xml       # /, /terms.html, /privacy.html
├── fonts/            # Inter, latin subset, SIL OFL 1.1 (see fonts/LICENSE.txt)
└── README.md         # you are here
```

## Run it locally

```bash
cd site
python3 -m http.server 8080
# visit http://localhost:8080
```

Opening `index.html` straight off disk mostly works too, but `@font-face` and the legal
pages' relative links behave more like production over HTTP.

## Before you deploy — the checklist

1. **`config.js`** — fill in `APP_URL` (the deployed web app; it ships as the placeholder
   `https://app.slicely.example`) and `CONTACT_EMAIL`. Every CTA and footer link in
   `index.html` carries `data-href="APP_URL"` rather than a literal URL, and `main.js`
   fills the real `href` in on load, so this file is the only place `index.html` writes a
   URL down. A key with no value leaves its link inert and logs a warning — visible, not
   silent. The two legal pages deliberately run no JavaScript at all (see below), so their
   footers carry the repository URL literally; `{{CONTACT_EMAIL}}` inside them is a
   placeholder the lawyer review replaces, not something `config.js` fills in.
2. **The domain.** The canonical URL is `https://slicely.app` and, because crawlers must
   see it in the served HTML rather than after JavaScript runs, it is written out in five
   places. Change all five together:
   `index.html`, `terms.html`, `privacy.html` (`<link rel="canonical">` and `og:url` /
   `og:image`), `robots.txt` (the `Sitemap:` line) and `sitemap.xml`.
3. **The legal pages.** `terms.html` and `privacy.html` are **templates, not legal
   advice.** Each opens with an HTML comment and a visible amber banner saying so, and
   each contains `{{ENTITY}}`, `{{CONTACT_EMAIL}}`, `{{JURISDICTION}}` and
   `{{EFFECTIVE_DATE}}` placeholders. Have a lawyer review them, fill the placeholders,
   then delete the `.legal-banner` element from both pages.
4. **`og.png`** is committed, so a deploy needs nothing. Regenerate it only if you edit
   `og.html`:
   ```bash
   node scripts/make-og.mjs
   ```

## Deploy

Any static host works; there is nothing to build.

**Cloudflare Pages** — connect the repo, set the root directory to `site`, leave the build
command empty.

**GitHub Pages** — repo Settings ▸ Pages, serve from `site/`.

The app server also serves these files, so `/terms` and `/privacy` resolve inside the app
itself. Both legal pages load `styles.css` by **relative** path and use no JavaScript at
all, so they render identically whether they are served as `/terms.html` by a static host
or as `/terms` by the app.

## Fonts

`fonts/inter-latin-{400,600,700}.woff2` are subsets of the official Inter release
([rsms/inter](https://github.com/rsms/inter) v4.1, the `web/` build), cut down to the latin
range plus the few symbols the pages use (`◆ ✓ → ·`) — about 18 KB each instead of 112 KB.
Inter is licensed SIL OFL 1.1; the licence travels with the files in
[`fonts/LICENSE.txt`](./fonts/LICENSE.txt). Nothing is fetched from Google Fonts, so the
site makes no third-party requests at all. To regenerate a subset:

```bash
pip install fonttools brotli
pyftsubset web/Inter-Regular.woff2 --flavor=woff2 \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+2713,U+25C6,U+FEFF,U+FFFD' \
  --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk,rlig' \
  --output-file=site/fonts/inter-latin-400.woff2
```

## Motion

Everything that moves is CSS. The hero demo is a single ~9 s loop (typed prompt → model
card → slice metrics → "Sent to Ender 3 ✓"), and the sections fade up through one
`IntersectionObserver` in `main.js`. Under `prefers-reduced-motion: reduce` the reveal is
skipped entirely and the demo is paused on its final frame, so a reader who asked for
stillness still sees the whole story — it just doesn't move.
