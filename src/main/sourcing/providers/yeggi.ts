// Yeggi — meta-search engine spanning dozens of 3D-model sites. SEARCH ONLY;
// like Thangs/STLfinder, its value is reach — a hit here often points at a
// file resolveUrl CAN actually fetch even though Yeggi itself never hosts it.
//
// Verified live 2026-08-27:
//   • `https://www.yeggi.com/robots.txt` — fetched successfully (not
//     challenged) and is genuinely permissive for a generic user agent:
//     `User-agent: *` disallows only `/temp/` and two `/service/...` paths;
//     search paths like `/q/{term}/` are NOT disallowed.
//   • BUT `https://www.yeggi.com/q/heart/` itself returns a JS bot-check
//     interstitial ("Please wait a moment while we check whether you are
//     human or a bot...") to a plain, honestly-identified request — so
//     although robots.txt permits a crawler here, the site's own bot
//     detection still blocks a non-browser fetch regardless. Handled the
//     same honest way as Thangs/STLfinder: detect the challenge, report
//     blocked, never spoof a browser fingerprint to get past it.
//   • The scraping selectors below (`.item`/`.thumb-wrap` result cards
//     linking to `/q/.../<id>/`) are UNVERIFIED — inferred from Yeggi's
//     general page conventions since a real results page was never reached.
import type { SourceAvailability, SourcedModel, SourcePlugin } from "../../../shared/sourcing";
import { fetchWithUA , scrapersEnabled } from "../net";
import { isBotChallenge } from "./scrape-common";
import * as cheerio from "cheerio";

const SEARCH_BASE = "https://www.yeggi.com/q";

export const yeggiProvider: SourcePlugin = {
  id: "yeggi",
  label: "Yeggi",
  canDownload: false,

  availability(): SourceAvailability {
    return {
      id: "yeggi",
      label: "Yeggi",
      // Off unless SLICELY_ENABLE_SCRAPERS is set: this source is
      // bot-blocked in practice and only adds latency. See net.ts.
      searchable: scrapersEnabled(),
      downloadable: false,
      blockedReason: scrapersEnabled()
        ? "Best-effort scrape — Yeggi's own bot-check may block automated requests even though its robots.txt allows crawling."
        : "Off by default: Yeggi's bot-check blocks automated requests, and waiting for it added ~8s to every search. Set SLICELY_ENABLE_SCRAPERS=1 to try it.",
    };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const slug = encodeURIComponent(query.trim().toLowerCase().replace(/\s+/g, "-"));
    const url = `${SEARCH_BASE}/${slug}/`;
    const res = await fetchWithUA(url, { headers: { Accept: "text/html" } });
    const html = await res.text();
    if (!res.ok || isBotChallenge(html)) {
      throw new Error("Yeggi blocked this request (bot-check challenge) — try again later or search on yeggi.com directly.");
    }

    const $ = cheerio.load(html);
    const results: SourcedModel[] = [];
    $("a.item, a.thumb-wrap, .search-result a").each((_i, el) => {
      if (results.length >= limit) return;
      const href = $(el).attr("href");
      if (!href || !/\/q\//.test(href)) return;
      const title = $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text().trim();
      if (!title) return;
      const abs = new URL(href, "https://www.yeggi.com").toString();
      const idMatch = /\/q\/[^/]+\/(\d+)\//.exec(abs) ?? /\/q\/([^/]+)\//.exec(abs);
      const thumbnail = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      results.push({
        id: idMatch?.[1] ?? abs,
        source: "yeggi",
        title,
        thumbnail: thumbnail || undefined,
        webUrl: abs,
        downloadable: false,
      });
    });

    return results;
  },
};
