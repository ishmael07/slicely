# Slicely landing page

A self-contained static marketing site for Slicely with a waitlist "Get access" form.
Plain HTML + CSS + vanilla JS — **no build step, no framework, no secrets.**

```
site/
├── index.html        # markup
├── styles.css        # styles + animations (dark / coral, matches the app)
├── main.js           # modal, form submit, scroll-reveal, reduced-motion
├── favicon.svg       # wordmark mark
├── apps-script.gs    # Google Apps Script for storing submissions in a Sheet
└── README.md         # you are here
```

## Run it locally

It's static — just open `index.html`, or serve the folder:

```bash
cd site
python3 -m http.server 8080
# visit http://localhost:8080
```

The form works immediately in **demo mode** (shows the success state, logs the payload to
the browser console) until you wire up the Google Sheet below.

## Wire up the waitlist (Google Sheet)

1. Create a new Google Sheet. In **row 1**, add these headers:
   `Timestamp | Name | Email | Usage | Comments`
2. **Extensions ▸ Apps Script**. Delete the stub, paste the contents of
   [`apps-script.gs`](./apps-script.gs), and **Save**.
3. **Deploy ▸ New deployment ▸** gear icon ▸ **Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy**, authorize when prompted, and copy the **Web app URL**
     (looks like `https://script.google.com/macros/s/…/exec`).
4. Open [`main.js`](./main.js) and set:
   ```js
   const WAITLIST_ENDPOINT = 'https://script.google.com/macros/s/…/exec';
   ```
5. Reload the page and submit a test entry — a new row should appear in your Sheet.

> The page POSTs form-encoded data with `mode: 'no-cors'`, so the browser never blocks the
> request and no API keys are involved. The Apps Script URL is public by design (it only
> *accepts* submissions), so it's safe to commit.

## Deploy the site

Any static host works. Two easy free options:

**Cloudflare Pages** — connect this repo, set the build output / root directory to `site`,
no build command. Add your domain (e.g. `slicely.app`).

**GitHub Pages** — push, then in repo Settings ▸ Pages, serve from the `site/` folder (or
copy its contents to a `gh-pages` branch / `docs/` folder).

## When you're ready to hand out the app

Today the page is a pure waitlist — no download is offered. When you want to distribute the
DMG, build it and attach it to a GitHub Release:

```bash
npm run dist:mac   # produces dist/Slicely-<version>.dmg
```

Then either email the Release asset URL to people on the list, or swap the waitlist CTA for
a direct download button pointing at that URL.
