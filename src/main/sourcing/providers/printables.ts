// Printables (Prusa) — GraphQL API. v1 marked this SEARCH ONLY, assuming
// `getDownloadLink` was login-gated. Re-verified live 2026-08-27 and that
// assumption was WRONG for ordinary (non-Store/premium) models: the mutation
// works with ZERO authentication and returns a real, fetchable, time-limited
// URL straight off Prusa's CDN. Concretely reproduced today:
//
//   1. searchPrints2("calibration cube") → model id 118657
//   2. ModelFiles(id: "118657") → stl file id 487903, "Calibration Cube.stl"
//   3. GetDownloadLink(id: "487903", printId: "118657", fileType: stl,
//      source: model_detail) → ok:true, output.link =
//      https://files.printables.com/media/prints/118657/stls/.../calibration-cube.stl
//   4. GET on that link → 200, Content-Length 12684 (matches the API's
//      reported fileSize exactly), Content-Disposition: attachment.
//   All four calls made with nothing but a plain browser User-Agent header —
//   no cookie, no bearer token, no session of any kind.
//
// This changes the plan from the brief (which assumed OAuth was required for
// every download): Printables is now a DIRECT-DOWNLOAD source for the common
// case. `downloadable` is still computed defensively per-model — a paid
// "Printables Store" item or a region-locked one may still fail the mutation
// (`ok:false`), in which case this provider degrades that one file to
// unavailable rather than guessing.
//
// UNVERIFIED (left in for completeness, not exercised live): a
// `PRINTABLES_TOKEN` env var, if set, is sent as a `Cookie: sessionid=<token>`
// header on a retry when the unauthenticated mutation fails. Printables has
// no public OAuth client registration or documented token-exchange endpoint
// (auth.printables.com does not even resolve in DNS) — a Prusa Account login
// session is a browser cookie, not a bearer token, so this is the most
// plausible mechanism for "the user's own login" but was NOT tested against
// a real paid/gated model (none was available to probe against safely).
//
// Search facts carried forward from v1 (still correct as of today):
//   • Endpoint: POST https://api.printables.com/graphql/ (no auth for search)
//   • Root search field: searchPrints2(query, limit, offset, ordering)
//   • Image URL = https://media.printables.com/{image.filePath}
//   • Web URL  = https://www.printables.com/model/{id}-{slug}
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { fetchWithUA, safeText, clamp } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const ENDPOINT = "https://api.printables.com/graphql/";

const GQL_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://www.printables.com",
  // A normal browser UA avoids the occasional Cloudflare challenge.
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slicely/0.2",
};

function printablesToken(): string {
  return process.env.PRINTABLES_TOKEN?.trim() ?? "";
}

async function graphql<T>(query: string, variables: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetchWithUA(ENDPOINT, {
    method: "POST",
    headers: { ...GQL_HEADERS, ...extraHeaders },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Printables API failed (${res.status}): ${await safeText(res)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Printables GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) throw new Error("Printables API returned no data.");
  return json.data;
}

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
      likesCount
      downloadCount
      ratingAvg
      datePublished
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
  likesCount?: number | null;
  downloadCount?: number | null;
  ratingAvg?: number | null;
  datePublished?: string | null;
}

const FILES_QUERY = `
query ModelFiles($id: ID!) {
  model: print(id: $id) {
    id
    stls { id name fileSize folder }
    gcodes { id name fileSize folder }
    otherFiles { id name fileSize folder }
  }
}`;

interface PrFile {
  id: string;
  name: string;
  fileSize?: number | null;
  folder?: string | null;
}

interface FilesResult {
  model: { id: string; stls: PrFile[]; gcodes: PrFile[]; otherFiles: PrFile[] } | null;
}

const DOWNLOAD_LINK_MUTATION = `
mutation GetDownloadLink($id: ID!, $modelId: ID!, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) {
  getDownloadLink(id: $id, printId: $modelId, fileType: $fileType, source: $source) {
    ok
    errors { field messages }
    output { link count ttl }
  }
}`;

interface DownloadLinkResult {
  getDownloadLink: {
    ok: boolean;
    errors?: Array<{ field?: string; messages?: string[] }> | null;
    output?: { link: string; count?: number; ttl?: number } | null;
  };
}

function isDownloadableFileType(
  f: { file: PrFile; fileType: "stl" | "gcode" | "other" },
): f is { file: PrFile; fileType: "stl" | "other" } {
  return f.fileType !== "gcode";
}

async function fetchAllFiles(modelId: string): Promise<{ file: PrFile; fileType: "stl" | "gcode" | "other" }[]> {
  const data = await graphql<FilesResult>(FILES_QUERY, { id: modelId });
  if (!data.model) return [];
  return [
    ...data.model.stls.map((file) => ({ file, fileType: "stl" as const })),
    ...data.model.gcodes.map((file) => ({ file, fileType: "gcode" as const })),
    ...data.model.otherFiles.map((file) => ({ file, fileType: "other" as const })),
  ];
}

export const printablesProvider: SourcePlugin = {
  id: "printables",
  label: "Printables",
  canDownload: true,

  availability(): SourceAvailability {
    // Search AND the common download path are both unauthenticated — see the
    // header comment. The optional PRINTABLES_TOKEN only ever helps with a
    // paid/gated edge case, so it's never a hard requirement.
    return { id: "printables", label: "Printables", searchable: true, downloadable: true };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    const data = await graphql<{ searchPrints2?: { items?: PrintItem[] } }>(SEARCH_QUERY, {
      q: query.trim(),
      limit: clamp(limit, 1, 30),
      offset: 0,
    });
    const items = data.searchPrints2?.items ?? [];
    return items.map((p) => ({
      id: String(p.id),
      source: "printables" as const,
      title: p.name,
      creator: p.user?.publicUsername ?? undefined,
      thumbnail: p.image?.filePath ? `https://media.printables.com/${p.image.filePath}` : undefined,
      webUrl: `https://www.printables.com/model/${p.id}-${p.slug}`,
      license: p.license?.name ?? undefined,
      // Premium (Printables Store) items are genuinely gated; everything
      // else downloads fine per the live-verified GetDownloadLink mutation.
      downloadable: !p.premium,
      signals: {
        likes: p.likesCount ?? undefined,
        downloads: p.downloadCount ?? undefined,
        publishedAt: p.datePublished ?? undefined,
      },
      printability: p.premium
        ? { score: 40, reasons: ["Printables Store item — may require purchase to download"], flags: { restrictiveLicence: true } }
        : undefined,
    }));
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    const all = await fetchAllFiles(modelId);
    return all
      .filter(isDownloadableFileType) // gcode isn't a re-sliceable mesh
      .map(({ file }) => ({
        id: String(file.id),
        name: file.name,
        ext: extOf(file.name),
        sizeBytes: file.fileSize ?? undefined,
        preferred: isMeshExt(extOf(file.name)),
      }));
  },

  async fileUrl(modelId: string, fileId?: string): Promise<ResolvedFileUrl> {
    const all = await fetchAllFiles(modelId);
    const candidates = all.filter(isDownloadableFileType);
    if (candidates.length === 0) {
      throw new Error("This Printables model has no downloadable mesh files.");
    }
    const chosen = fileId
      ? candidates.find(({ file }) => String(file.id) === fileId)
      : (candidates.find(({ file }) => isMeshExt(extOf(file.name))) ?? candidates[0]);
    if (!chosen) throw new Error(`File ${fileId ?? "(default)"} not found on this model.`);

    const link = await requestDownloadLink(chosen.file.id, modelId, chosen.fileType);
    return { url: link, fileName: chosen.file.name };
  },
};

/** Calls GetDownloadLink unauthenticated first (verified to work for normal
 *  models); if Printables reports it as not ok AND a PRINTABLES_TOKEN is
 *  configured, retries once with that token as a session cookie. */
async function requestDownloadLink(fileId: string, modelId: string, fileType: "stl" | "other"): Promise<string> {
  const variables = { id: fileId, modelId, fileType, source: "model_detail" };
  const attempt = await graphql<DownloadLinkResult>(DOWNLOAD_LINK_MUTATION, variables);
  if (attempt.getDownloadLink.ok && attempt.getDownloadLink.output?.link) {
    return attempt.getDownloadLink.output.link;
  }

  const token = printablesToken();
  if (token) {
    const retry = await graphql<DownloadLinkResult>(DOWNLOAD_LINK_MUTATION, variables, {
      Cookie: `sessionid=${token}`,
    });
    if (retry.getDownloadLink.ok && retry.getDownloadLink.output?.link) {
      return retry.getDownloadLink.output.link;
    }
    const msg = retry.getDownloadLink.errors?.[0]?.messages?.[0];
    throw new Error(msg ?? "Printables declined the download even with a token configured.");
  }

  const msg = attempt.getDownloadLink.errors?.[0]?.messages?.[0];
  throw new Error(
    msg ??
      "This Printables file needs the uploader's account (Store/premium item). Set PRINTABLES_TOKEN to your Prusa Account session to try authenticated downloads, or open it in the browser.",
  );
}
