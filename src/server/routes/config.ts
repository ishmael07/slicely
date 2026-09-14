// ─────────────────────────────────────────────────────────────────────────────
// GET /api/config — the one call the client makes before it can render
// anything: which mode this server runs in, which AI providers a key can be
// connected to and whether THIS session has each one, whether a slicer exists
// here at all, and the legal / source links the page footer needs.
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
import { getUserApiKey, hasAnyUserApiKey, userKeyHint } from "../../main/userkey";
import { PROVIDERS, providerForModel } from "../../main/agent/provider";
import { getSettings } from "../../main/settings";
import type { ProviderInfo } from "../../shared/types";

/** A string that is not a key and not one of the prefixes any provider names
 *  specially, so `formatMessage` returns its GENERAL refusal — the sentence the
 *  client needs when it turns a paste away locally. */
const UNRECOGNISED_KEY = "?";

/** Repo root from this file's compiled location (`dist/server/routes/`) — the
 *  same three levels up from `src/server/routes/`, so it resolves either way. */
const REPO_ROOT = join(__dirname, "..", "..", "..");

const DEFAULT_REPO_URL = "https://github.com/ishmael07/slicely";

export interface ConfigResponse {
  mode: "hosted" | "desktop";
  /** Does this session have a usable key for ANY provider? A user with only an
   *  OpenAI key is not a user without a key, so this is not per-provider. */
  hasKey: boolean;
  /** The hint for the ACTIVE model's provider — the key that would pay for the
   *  next message. Undefined when that provider has no key, even if the other
   *  one does. */
  keyHint?: string;
  /** Every provider a key can be connected to, in UI order. */
  providers: ProviderInfo[];
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
    const active = providerForModel(getSettings().model).id;
    const body: ConfigResponse = {
      mode: getMode(),
      hasKey: hasAnyUserApiKey(),
      // The hint is the ONLY thing about a key that ever crosses the wire: four
      // characters, so a user can tell which key is connected.
      keyHint: userKeyHint(active),
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        hasKey: Boolean(getUserApiKey(p.id)),
        keyHint: userKeyHint(p.id),
        keyHelp: {
          label: p.keyHelp.label,
          placeholder: p.keyHelp.placeholder,
          consoleUrl: p.keyHelp.consoleUrl,
          consoleLabel: p.keyHelp.consoleLabel,
          formatMessage: p.keyHelp.formatMessage(UNRECOGNISED_KEY),
        },
      })),
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
