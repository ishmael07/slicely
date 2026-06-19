// Printables (Prusa) provider — SEARCH ONLY. Downloads are login-gated behind
// the `getDownloadLink` mutation, so the UI hands these off to the browser.
//
// Verified API facts (live-probed 2026-06-19):
//   • Endpoint: POST https://api.printables.com/graphql/  (no auth for search)
//   • Root search field: searchPrints2(query, limit, offset, ordering: best_match)
//   • Image URL = https://media.printables.com/{image.filePath}
//   • Web URL  = https://www.printables.com/model/{id}-{slug}
import type { ModelResult } from "../../shared/types";
import type { SearchProvider } from "./types";

const ENDPOINT = "https://api.printables.com/graphql/";

const SEARCH_QUERY = `
query SlicelySearch($q: String!, $limit: Int, $offset: Int) {
  searchPrints2(query: $q, limit: $limit, offset: $offset, ordering: best_match) {
    items {
      id
      name
      slug
      image { filePath }
      user { publicUsername }
      license { name }
      premium
    }
    totalCount
  }
}`;

interface PrintItem {
  id: string;
  name: string;
  slug: string;
  image?: { filePath?: string } | null;
  user?: { publicUsername?: string } | null;
  license?: { name?: string } | null;
  premium?: boolean | null;
}

export class PrintablesProvider implements SearchProvider {
  readonly id = "printables";

  // Search is unauthenticated, so the provider is always available.
  isAvailable(): boolean {
    return true;
  }

  async search(query: string, limit: number): Promise<ModelResult[]> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.printables.com",
        // A normal browser UA avoids the occasional Cloudflare challenge.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slicely/0.1",
      },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { q: query.trim(), limit: clamp(limit, 1, 30), offset: 0 },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Printables search failed (${res.status}): ${await safeText(res)}`,
      );
    }

    const json = (await res.json()) as {
      data?: { searchPrints2?: { items?: PrintItem[] } };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      throw new Error(`Printables GraphQL error: ${json.errors[0].message}`);
    }

    const items = json.data?.searchPrints2?.items ?? [];
    return items.map((p) => ({
      id: String(p.id),
      source: "printables" as const,
      title: p.name,
      creator: p.user?.publicUsername ?? undefined,
      thumbnail: p.image?.filePath
        ? `https://media.printables.com/${p.image.filePath}`
        : undefined,
      webUrl: `https://www.printables.com/model/${p.id}-${p.slug}`,
      license: p.license?.name ?? undefined,
      // Download requires login at source → handed off to the browser.
      downloadable: false,
    }));
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
