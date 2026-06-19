// MakerWorld (Bambu Lab) provider — BEST-EFFORT SEARCH ONLY. The search API is
// unofficial and Cloudflare-fragile; downloads are fully gated and the default
// license is NOT open-source, so the UI always hands these off to the browser.
//
// Verified API facts (live-probed 2026-06-19):
//   • Search: GET https://makerworld.com/api/v1/search-service/select/design?query=&limit=&offset=
//   • Hit: { id, title, slug, cover (absolute url), designCreator{name}, license }
//   • Web URL = https://makerworld.com/en/models/{id}
import type { ModelResult } from "../../shared/types";
import type { SearchProvider } from "./types";

const SEARCH_URL = "https://makerworld.com/api/v1/search-service/select/design";

interface MwHit {
  id: number;
  title: string;
  slug?: string;
  cover?: string;
  designCreator?: { name?: string } | null;
  license?: string;
}

export class MakerWorldProvider implements SearchProvider {
  readonly id = "makerworld";

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, limit: number): Promise<ModelResult[]> {
    const url = `${SEARCH_URL}?query=${encodeURIComponent(
      query.trim(),
    )}&limit=${clamp(limit, 1, 30)}&offset=0`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slicely/0.1",
        },
      });
    } catch (err) {
      // Network / Cloudflare failures are non-fatal for a best-effort provider.
      throw new Error(
        `MakerWorld search unavailable: ${(err as Error).message}`,
      );
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
    }));
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
