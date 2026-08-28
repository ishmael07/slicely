// Shared plumbing for the three meta-search scrapers (thangs, yeggi,
// stlfinder). Their whole value is *reach* — they each index dozens of other
// sites — but all three sit behind an anti-bot layer that a plain,
// honestly-identified fetch cannot pass (verified live below), so this
// module centralizes: challenge-page detection (so a block is reported
// clearly instead of parsed as "zero results"), and the cheerio-based link
// ranking used once/if a real results page is ever reached.
import * as cheerio from "cheerio";
import type { SourcedFile } from "../../../shared/sourcing";
import { extOf, isArchiveExt, isMeshExt } from "../fsutil";

/** True when the response body is a bot-check/challenge page rather than
 *  real content — Cloudflare's "Just a moment...", "Attention Required!",
 *  or a generic "checking your browser" interstitial. */
export function isBotChallenge(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("attention required") ||
    head.includes("checking your browser") ||
    head.includes("challenges.cloudflare.com") ||
    head.includes("cf-browser-verification") ||
    head.includes("please enable cookies")
  );
}

/** Rank every mesh/archive link found on a scraped page, best guess first:
 *  a direct mesh file outranks a zip, and a filename that echoes the query
 *  outranks one that doesn't. */
export function extractDownloadCandidates(html: string, baseUrl: string, query = ""): SourcedFile[] {
  const $ = cheerio.load(html);
  const q = query.trim().toLowerCase();
  const out: SourcedFile[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    const ext = extOf(new URL(abs).pathname);
    if (!isMeshExt(ext) && !isArchiveExt(ext)) return;
    if (seen.has(abs)) return;
    seen.add(abs);

    const name = abs.split("/").pop() ?? abs;
    out.push({ id: abs, name, ext, url: abs, preferred: isMeshExt(ext) });
  });

  out.sort((a, b) => {
    const aMesh = isMeshExt(a.ext) ? 1 : 0;
    const bMesh = isMeshExt(b.ext) ? 1 : 0;
    if (aMesh !== bMesh) return bMesh - aMesh;
    if (q) {
      const aMatch = a.name.toLowerCase().includes(q) ? 1 : 0;
      const bMatch = b.name.toLowerCase().includes(q) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return 0;
  });

  return out;
}
