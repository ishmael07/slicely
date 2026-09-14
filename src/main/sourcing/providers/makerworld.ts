// MakerWorld (Bambu Lab) — SEARCH ONLY. The search API is unofficial and
// Cloudflare-fragile; downloads are fully gated behind a Bambu account and
// the default licence is not open, so this always hands off to the browser.
// Behaviour unchanged from v1 by design (I was told to leave it as-is).
//
// Verified API facts (re-verified live 2026-08-27, unchanged since v1's
// 2026-06-19 probe):
//   • Search: GET https://makerworld.com/api/v1/search-service/select/design?query=&limit=&offset=
//   • Hit: { id, title, slug, cover (absolute url), designCreator{name},
//     license, likeCount, downloadCount, printCount, createTime }
//   • Web URL = https://makerworld.com/en/models/{id}
import type { SourceAvailability, SourcedModel, SourcePlugin } from "../../../shared/sourcing";
import { sourceState } from "../../../shared/sourcing";
import { fetchWithUA, clamp } from "../net";

const SEARCH_URL = "https://makerworld.com/api/v1/search-service/select/design";

interface MwHit {
  id: number;
  title: string;
  slug?: string;
  cover?: string;
  designCreator?: { name?: string } | null;
  license?: string;
  likeCount?: number;
  downloadCount?: number;
  printCount?: number;
  commentCount?: number;
  createTime?: string;
}

export const makerworldProvider: SourcePlugin = {
  id: "makerworld",
  label: "MakerWorld",
  canDownload: false,

  availability(): SourceAvailability {
    return sourceState({
      id: "makerworld",
      label: "MakerWorld",
      status: "search_only",
      searchable: true,
      downloadable: false,
      // Nothing an operator can configure — Bambu gates downloads behind a
      // personal login — so this stays a diagnostic sentence, not a hint.
      blockedReason: "Downloads require a Bambu account login — open in browser.",
    });
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const url = `${SEARCH_URL}?query=${encodeURIComponent(query.trim())}&limit=${clamp(limit, 1, 30)}&offset=0`;

    let res: Response;
    try {
      res = await fetchWithUA(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slicely/0.2",
        },
      });
    } catch (err) {
      throw new Error(`MakerWorld search unavailable: ${(err as Error).message}`);
    }

    if (!res.ok) {
      throw new Error(`MakerWorld search failed (${res.status}).`);
    }

    const json = (await res.json()) as { hits?: MwHit[] };
    const hits = json.hits ?? [];
    return hits.map((h) => ({
      id: String(h.id),
      source: "makerworld" as const,
      title: h.title,
      creator: h.designCreator?.name ?? undefined,
      thumbnail: h.cover,
      webUrl: `https://makerworld.com/en/models/${h.id}`,
      license: h.license,
      downloadable: false,
      signals: {
        likes: h.likeCount,
        downloads: h.downloadCount,
        makes: h.printCount,
        comments: h.commentCount,
        publishedAt: h.createTime,
      },
    }));
  },
};
