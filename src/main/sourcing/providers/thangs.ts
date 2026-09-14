// Thangs — meta-search/aggregator with its own index. SEARCH ONLY: Thangs'
// own downloads require an account, and its real value to Slicely is reach
// (a Thangs hit often points back at a file hosted elsewhere that the URL
// resolver CAN fetch) — so results are always handed to resolveUrl rather
// than downloaded directly from here.
//
// Verified live 2026-08-27: `https://thangs.com/search/{query}` and
// `https://thangs.com/robots.txt` both return Cloudflare's JS challenge page
// ("Just a moment...", HTTP 403) to a plain, honestly-identified request —
// confirmed by fetching both directly. No API endpoint was found either (the
// same challenge intercepts `/api/search`). Per the legal/ethical
// constraint, this provider does NOT spoof a browser fingerprint or attempt
// to solve the challenge — it sends Slicely's real User-Agent, detects the
// challenge page, and reports itself blocked rather than pretending to
// return results. The scraping logic below is real and will work the moment
// the block doesn't trigger (Cloudflare's bot score is per-IP/session, so
// this may behave differently from a residential network than it did from
// this sandbox) — but that HTML structure is UNVERIFIED, inferred from
// Thangs' general page conventions (a search results grid of `/3d-model/...`
// links), not confirmed against real markup.
import type { SourceAvailability, SourcedModel, SourcePlugin } from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { fetchWithUA , scrapersEnabled } from "../net";
import { isBotChallenge } from "./scrape-common";
import * as cheerio from "cheerio";

const SEARCH_BASE = "https://thangs.com/search";

export const thangsProvider: SourcePlugin = {
  id: "thangs",
  label: "Thangs",
  canDownload: false,

  availability(): SourceAvailability {
    const on = scrapersEnabled();
    return sourceState({
      id: "thangs",
      label: "Thangs",
      // Off unless SLICELY_ENABLE_SCRAPERS is set: this source is
      // bot-blocked in practice and only adds latency. See net.ts.
      status: on ? "search_only" : "off",
      searchable: on,
      downloadable: false,
      operatorHint: on
        ? "Best-effort scrape — Thangs sits behind Cloudflare and may block automated requests."
        : "Off by default: Thangs sits behind Cloudflare and blocks automated requests. Set SLICELY_ENABLE_SCRAPERS=1 to try it.",
    });
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const url = `${SEARCH_BASE}/${encodeURIComponent(query.trim())}`;
    const res = await fetchWithUA(url, { headers: { Accept: "text/html" } });
    const html = await res.text();
    if (!res.ok || isBotChallenge(html)) {
      throw new Error("Thangs blocked this request (bot-protection challenge) — try again later or search on thangs.com directly.");
    }

    const $ = cheerio.load(html);
    const results: SourcedModel[] = [];
    $('a[href^="/3d-model/"]').each((_i, el) => {
      if (results.length >= limit) return;
      const href = $(el).attr("href");
      if (!href) return;
      const title = $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text().trim();
      if (!title) return;
      const idMatch = /\/3d-model\/([^/?#]+)/.exec(href);
      if (!idMatch) return;
      const thumbnail = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      results.push({
        id: idMatch[1],
        source: "thangs",
        title,
        thumbnail: thumbnail || undefined,
        webUrl: new URL(href, "https://thangs.com").toString(),
        downloadable: false,
      });
    });

    return results;
  },
};
