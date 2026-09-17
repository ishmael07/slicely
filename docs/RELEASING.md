# Releasing the macOS app

How to cut and ship a Slicely `.dmg`. Web/Docker deploys are a separate thing — see
`docs/DEPLOY.md`.

## Steps

1. **Bump the version.** Edit `version` in `package.json` (semver: patch for fixes,
   minor for features, major for breaking changes). Nothing else reads this except
   `electron-builder`, which uses it for the DMG filename and the app's own version.

2. **Update the changelog, if one exists.** There is no `CHANGELOG.md` in this repo yet —
   check before you write this step off; if one has been added since, add an entry here.
   Until then, the GitHub Release notes (step 5) are the changelog.

3. **Commit and tag.**
   ```bash
   git add package.json
   git commit -m "slicely-v3: release v<version>"
   git tag v<version>
   git push && git push --tags
   ```

4. **Build and publish.**
   ```bash
   npm run release:mac
   ```
   This builds the app and uploads the DMG straight to GitHub Releases (the `publish`
   block in `package.json` points at `ishmael07/slicely`) — you'll need a `GH_TOKEN` with
   `repo` scope in your environment. If you'd rather upload by hand (no token, or
   double-checking the build first), run `npm run dist:mac` instead and drag
   `release/Slicely-<version>-universal.dmg` onto a manually-created GitHub Release.

   The DMG is **universal** — one download runs on both Intel and Apple silicon Macs
   (`build.mac.target[0].arch` is `["universal"]` in `package.json`). electron-builder
   builds both arch-specific `.app`s and merges them with `lipo`; that needs both
   Electron zips (`electron-v<version>-darwin-arm64.zip` and `-x64.zip`) in
   `~/Library/Caches/electron/`, and takes noticeably longer and more disk than a
   single-arch build (both temp app dirs exist briefly before being merged and removed).

   Always build through `npm run dist:mac` or `npm run release:mac`, never by calling
   `electron-builder` directly: only the npm scripts pass `scripts/electron-builder.config.cjs`,
   which is where the ad-hoc identity and the hardened-runtime switch live. A bare
   `electron-builder --mac` would try to sign with whatever certificate it finds and turn the
   hardened runtime on, which produces an app that may not launch.

   The build is also **unsigned and ad-hoc** (no Apple Developer ID, not notarized).
   Signing and notarization turn on automatically — no code change — once `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are all set in the environment.

4b. **Launch the built app once and prove the bridge is alive.** Open the DMG, start
   Slicely.app, then in its window press ⌥⌘I (DevTools) and run `typeof window.slicely`
   — it must print `"object"`. If it prints `"undefined"`, the preload failed silently
   (a sandboxed preload may only `require("electron")`; anything else throws before
   `contextBridge` runs), and the app is a browser tab in a frame: no drag region, no
   "Open in PrusaSlicer", no file-drop shortcut. `src/main/preload-channels.test.ts`
   guards this in CI, but only a real launch proves the packaged binary.

5. **Write the GitHub Release notes.** Use this template:

   ```markdown
   ## What's new
   - ...

   ## Fixes
   - ...

   ## Known issues
   - Unsigned build — see "How to open an unsigned build" below.

   ## How to open an unsigned build
   This build isn't signed with an Apple Developer ID yet. First launch:
   right-click **Slicely.app** → **Open** → **Open**. Or: **System Settings →
   Privacy & Security → Open Anyway**. (Also in `How to open.txt` inside the app.)
   ```

6. **Verify the download link.** `site/config.js`'s `DOWNLOAD_URL` already points at
   `https://github.com/ishmael07/slicely/releases/latest` — GitHub's "latest" alias, which
   always resolves to the newest published release. **You do not need to edit it per
   release.** Just open the site's download link once after publishing and confirm it
   lands on the new version's release page and the DMG asset is attached.

## Rollback

Published a bad build? Don't delete the GitHub Release — someone may already be mid-download.
Instead: publish a new patch release with the fix (steps 1–6 above), and edit the bad
release's notes to say "superseded by v<version>, please upgrade" with a link. If the bad
build is actively harmful (data loss, security issue), mark the GitHub Release as a
**pre-release** so it drops out of "latest" — `releases/latest` then serves the previous
good version again — and say so in its notes.
