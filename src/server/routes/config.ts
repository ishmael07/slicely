// ─────────────────────────────────────────────────────────────────────────────
// GET /api/config — the one call the client makes before it can render
// anything: which mode this server runs in, whether THIS session has an
// Anthropic key connected, whether a slicer exists here at all, and the legal /
// source links the page footer needs.
//
// It replaces two older hacks: the client probing a privileged endpoint and
// reading the 403 as "multi-user", and Electron's env-derived `ConfigState`.
//
// `sourceCommit` is not decoration. Slicely runs AGPL software (PrusaSlicer) as
// a network service, so §13 requires offering the running version's source to
// its users — the commit here is what `REPO_URL/tree/<commit>` in the footer
// points at. A deployed image sets `SLICELY_SOURCE_COMMIT`; a dev checkout asks
// git; anything else says "dev" rather than lying about a commit.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../../main/config";
import { getMode, isHosted } from "../../main/mode";
import { getUserApiKey, userKeyHint } from "../../main/userkey";

/** Repo root from this file's compiled location (`dist/server/routes/`) — the
 *  same three levels up from `src/server/routes/`, so it resolves either way. */
const REPO_ROOT = join(__dirname, "..", "..", "..");

const DEFAULT_REPO_URL = "https://github.com/ishmael07/slicely";

export interface ConfigResponse {
  mode: "hosted" | "desktop";
  hasKey: boolean;
  keyHint?: string;
  multiUser: boolean;
  slicerAvailable: boolean;
  sourceCommit: string;
  version: string;
  repoUrl: string;
  termsUrl: "/terms";
  privacyUrl: "/privacy";
}

let commitCache: string | undefined;

/** The commit this server is running, resolved once. */
function sourceCommit(): string {
  if (commitCache) return commitCache;
  const fromEnv = process.env.SLICELY_SOURCE_COMMIT?.trim();
  if (fromEnv) {
    commitCache = fromEnv;
    return commitCache;
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // A packaged app has no .git, and a stray git failure must not turn into a
    // fake commit in a legally-meaningful field.
    if (/^[0-9a-f]{7,40}$/i.test(head)) {
      commitCache = head;
      return commitCache;
    }
  } catch {
    /* no git, no checkout, or not a repo */
  }
  commitCache = "dev";
  return commitCache;
}

let versionCache: string | undefined;

function appVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    versionCache = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }
  return versionCache;
}

/** Is a slicer binary present on THIS machine? A plain stat, not
 *  prusaslicer.getStatus(): that also shells out to `pgrep`/`lsappinfo` to see
 *  whether the GUI is open, which is meaningless on a server and far too
 *  expensive for a call every page load makes. */
function slicerAvailable(): boolean {
  try {
    return existsSync(getConfig().prusaSlicerPath);
  } catch {
    return false;
  }
}

export function createConfigRouter(): Router {
  const router = Router();
  // Resolve the commit AT BOOT (app construction), not on the first request:
  // asking git is a subprocess, and no visitor should wait for it.
  sourceCommit();

  router.get("/config", (_req: Request, res: Response) => {
    const body: ConfigResponse = {
      mode: getMode(),
      hasKey: Boolean(getUserApiKey()),
      // The hint is the ONLY thing about the key that ever crosses the wire:
      // four characters, so a user can tell which key is connected.
      keyHint: userKeyHint(),
      multiUser: isHosted(),
      slicerAvailable: slicerAvailable(),
      sourceCommit: sourceCommit(),
      version: appVersion(),
      repoUrl: process.env.SLICELY_REPO_URL?.trim() || DEFAULT_REPO_URL,
      termsUrl: "/terms",
      privacyUrl: "/privacy",
    };
    res.json(body);
  });

  return router;
}
