// ─────────────────────────────────────────────────────────────────────────────
// The electron-builder config, with the signing half decided by the ENVIRONMENT
// rather than by a checked-in boolean.
//
// The `build` block in package.json is the description of a SIGNED release: a
// hardened runtime, our entitlements, ready for notarization. That is what we
// want to ship the day there is an Apple Developer ID to ship it with. But there
// isn't one yet, and today's builds are unsigned — so the same config has to
// produce a working unsigned app too, and the two cases genuinely need different
// settings:
//
//   * Unsigned, the identity has to be `"-"` (AD-HOC), not absent. With no
//     identity at all electron-builder skips `codesign` entirely, and an arm64
//     Mac refuses to launch a `.app` with no signature — injecting `app.asar`
//     into `Contents/Resources` invalidates the signature the Electron dist
//     shipped with, so "leave it alone" is not an option. `"-"` re-seals it with
//     a signature that carries no identity, which is exactly what an unsigned
//     release wants.
//   * Ad-hoc AND `hardenedRuntime: true` is the one combination that builds
//     cleanly and then fails at launch: library validation under the hardened
//     runtime rejects the ad-hoc-signed framework unless
//     `com.apple.security.cs.disable-library-validation` is granted — which
//     would mean weakening the entitlements file that the eventual signed build
//     depends on. So the hardened runtime is off for the ad-hoc path and on for
//     the signed one, and `build/entitlements.mac.plist` stays as it should be.
//
// Notarization follows the same rule: it needs an Apple account, so it is on
// only when the three credentials are all present.
//
// Pointed at by `dist:mac` / `release:mac` via `--config`. Everything not named
// here comes from package.json unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const { build } = require("../package.json");

const appleId = process.env.APPLE_ID;
const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const teamId = process.env.APPLE_TEAM_ID;
const canSign = Boolean(appleId && applePassword && teamId);

if (!canSign) {
  console.log(
    "[electron-builder] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — " +
      "building an AD-HOC SIGNED, un-notarized app. Users will need build/How to open.txt.",
  );
}

module.exports = {
  ...build,
  mac: {
    ...build.mac,
    // `"-"` = ad-hoc. Unset (the default) would let a stray "Apple Development"
    // certificate in the local keychain decide what the release is signed with,
    // which would make the build depend on whose machine ran it.
    identity: canSign ? undefined : "-",
    hardenedRuntime: canSign,
    notarize: canSign ? { teamId } : false,
  },
};
