// STLfinder — meta-search engine spanning dozens of sites. SEARCH ONLY, same
// reach-not-hosting role as Thangs/Yeggi.
//
// Verified live 2026-08-27: EVEN `https://stlfinder.com/robots.txt` itself
// returns a full Cloudflare "Sorry, you have been blocked" page (HTTP,
// title "Attention Required! | Cloudflare") to a plain request — i.e. this
// site's edge WAF blocks non-browser clients before robots.txt can even be
// read, let alone a search page. That's the strongest signal of the three
// meta-search sources that a respectful, honestly-identified fetch cannot
// reach this site at all right now. Implemented anyway (rather than omitted)
// so the plugin is real and will start working the moment that block lifts
// or differs by network — but `search()` will realistically return the
// "blocked" error on most networks today, and the HTML-parsing selectors
// below are UNVERIFIED (no real search-results page was ever reached to
// confirm markup).
import type { SourceAvailability, SourcedModel, SourcePlugin } from "../../../shared/sourcing";
import { fetchWithUA , scrapersEnabled } from "../net";
import { isBotChallenge } from "./scrape-common";
import * as cheerio from "cheerio";

const SEARCH_URL = "https://stlfinder.com/search";

export const stlfinderProvider: SourcePlugin = {
  id: "stlfinder",
  label: "STLFinder",
  canDownload: false,

  availability(): SourceAvailability {
    return {
      id: "stlfinder",
      label: "STLFinder",
      // Off unless SLICELY_ENABLE_SCRAPERS is set: this source is
      // bot-blocked in practice and only adds latency. See net.ts.
      searchable: scrapersEnabled(),
      downloadable: false,
      blockedReason: scrapersEnabled()
        ? "STLfinder's Cloudflare edge blocks non-browser requests outright — best-effort only."
        : "Off by default: STLfinder's Cloudflare edge blocks non-browser requests outright. Set SLICELY_ENABLE_SCRAPERS=1 to try it.",
    };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query.trim())}`;
    const res = await fetchWithUA(url, { headers: { Accept: "text/html" } });
    const html = await res.text();
    if (!res.ok || isBotChallenge(html)) {
      throw new Error("STLfinder blocked this request (Cloudflare) — try again later or search on stlfinder.com directly.");
    }

    const $ = cheerio.load(html);
    const results: SourcedModel[] = [];
    $(".model-item a, .search-item a, article a").each((_i, el) => {
      if (results.length >= limit) return;
      const href = $(el).attr("href");
      if (!href) return;
      const title = $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text().trim();
      if (!title) return;
      const abs = new URL(href, "https://stlfinder.com").toString();
      const thumbnail = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      results.push({
        id: abs,
        source: "stlfinder",
        title,
        thumbnail: thumbnail || undefined,
        webUrl: abs,
        downloadable: false,
      });
    });

    return results;
  },
};
