// ─────────────────────────────────────────────────────────────────────────────
// The two filesystem rules that more than one guard needs.
//
// Slicely decides "may this process touch this path?" in two places, for two
// different reasons:
//
//   • printers/util.ts `assertAllowedOutputDir` — the folder a desktop user
//     picked for a G-code file to be saved into.
//   • session-context.ts `isInsideSessionWorkspace` — the path the AGENT (i.e.
//     the model, i.e. the conversation) handed a tool.
//
// Both have to answer the same two sub-questions: is a dot-prefixed path
// component involved (`~/.ssh`, `<workdir>/.session-secret`, `.Trashes`), and
// where does the `/Volumes` mount root live. Two copies of an answer is one
// copy that drifts, so they live here once.
//
// Pure Node with no project imports on purpose: printers/util.ts reaches
// server/errors.ts, which reaches session-context.ts, so anything these two
// share has to sit below all of them or the import graph closes a cycle.
// ─────────────────────────────────────────────────────────────────────────────
import { sep } from "node:path";

/** The mount point macOS puts removable drives under. Not a constant because
 *  `setVolumesRootForTests` swaps it: `/Volumes/Macintosh HD` is itself a
 *  symlink to `/` on every real Mac — the very case containment must survive —
 *  so tests need a fake root they can actually write into. */
let volumes = `${sep}Volumes`;

/** Where mounted drives live. Call it; don't cache it (tests swap it). */
export function volumesRoot(): string {
  return volumes;
}

/** Tests only: point the /Volumes containment checks at a fake root (e.g. a
 *  temp dir standing in for the real, unwritable-in-CI /Volumes) so symlink
 *  and traversal scenarios can be built without touching real hardware. Pass
 *  `undefined` to restore the real `/Volumes`. */
export function setVolumesRootForTests(root: string | undefined): void {
  volumes = root ?? `${sep}Volumes`;
}

/**
 * True when any component of this ALREADY-RELATIVE path starts with a dot.
 *
 * `~/.ssh`, `~/.config`, `~/.aws` hold credentials and app config;
 * `<workdir>/.session-secret` is the key every session cookie is signed with;
 * on a mounted volume `.Trashes` and `.fseventsd` are filesystem bookkeeping.
 * Excluding every dot-prefixed segment costs a user nothing — nobody keeps
 * their models or their prints in a hidden folder — and removes the whole
 * class in one rule rather than a blocklist that has to be kept current.
 *
 * Pass the path RELATIVE to the allowed root, never an absolute one: the root
 * itself is allowed to be hidden (`~/.slicely` would be a perfectly good
 * workdir) — it's reaching into a hidden place *below* the root that's refused.
 */
export function hasHiddenSegment(relativePath: string): boolean {
  return relativePath.split(sep).some((segment) => segment.startsWith("."));
}
