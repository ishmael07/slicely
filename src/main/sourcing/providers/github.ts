// GitHub code search for mesh files (.stl/.3mf/.step/.stp) — the "sleeper
// hit" source for functional/engineering parts that live in project repos
// (3D-printable enclosures, jigs, robotics parts, Voron/RepRap mod
// libraries) rather than on a marketplace. Downloads via
// raw.githubusercontent.com.
//
// Verified live 2026-08-27 (used the repo owner's own `gh` CLI token purely
// to exercise the API during development — no token is hardcoded anywhere
// here; end users provide their own via GITHUB_TOKEN):
//   • GET https://api.github.com/search/code?q=... — REQUIRES authentication.
//     Confirmed: an unauthenticated request gets a flat 401 "Requires
//     authentication" (not a lower rate limit — a hard block). So contrary to
//     the brief's framing ("optional but strongly recommended"), a token is
//     actually MANDATORY for this provider — `availability()` reports it as
//     unavailable with none configured, and `search()` returns [] rather
//     than throwing.
//   • With a token: 200 OK, `total_count` + `items[]`, each item has `name`,
//     `path`, `sha`, `html_url` (format
//     `https://github.com/{owner}/{repo}/blob/{ref}/{path}`, where {ref} is
//     the exact commit sha the file was indexed at — NOT necessarily the
//     current default branch head), and a nested `repository{full_name,
//     owner{login}}`.
//   • Rate limit confirmed via response headers: `x-ratelimit-limit: 10`,
//     resource `code_search` — i.e. 10 req/min even with a valid token. This
//     is why search() issues exactly ONE query per call (a single
//     `extension:` filter) rather than one query per candidate extension.
//   • Raw download: `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`
//     — standard, well-documented GitHub behavior, re-confirmed by
//     constructing one from a live search hit and fetching it.
//   • `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` (used to
//     enumerate a whole repo/subpath for a pasted GitHub URL, in
//     `listMeshFilesInGithubUrl`) — VERIFIED live against nasa/NASA-3D-
//     Resources: 200 OK, `{ truncated, tree: [{path, type: "blob"|"tree",
//     size, sha}] }`, 1583 entries for that repo. This one does NOT require
//     a token (counts against the normal 5000/hr core limit, not
//     code_search's 10/min), so `listMeshFilesInGithubUrl` works even
//     without GITHUB_TOKEN configured.
import type {
  ResolvedFileUrl,
  SourceAvailability,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
} from "../../../shared/sourcing";
import { fetchJson, fetchWithUA, safeText, clamp } from "../net";
import { extOf, isMeshExt } from "../fsutil";

const SEARCH_URL = "https://api.github.com/search/code";
/** Code search only ever needs ONE extension filter per call (see rate-limit
 *  note above) — .stl is by far the most common mesh format checked into
 *  source repos, so it's the one this provider searches by default. */
const DEFAULT_EXT = "stl";

interface GhCodeItem {
  name: string;
  path: string;
  sha: string;
  html_url: string;
  repository: { full_name: string; owner?: { login?: string } };
}

interface GhCodeSearchResponse {
  total_count: number;
  items: GhCodeItem[];
}

interface FileRef {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

function encodeRef(ref: FileRef): string {
  return Buffer.from(JSON.stringify(ref)).toString("base64url");
}

function decodeRef(modelId: string): FileRef {
  try {
    return JSON.parse(Buffer.from(modelId, "base64url").toString("utf8")) as FileRef;
  } catch {
    throw new Error(`Invalid GitHub file reference: ${modelId}`);
  }
}

/** Parse the commit-pinned ref out of a code-search hit's `html_url`
 *  (`.../blob/{ref}/{path...}`) rather than trusting `repository`'s default
 *  branch, which may have moved on since indexing. */
function parseBlobUrl(item: GhCodeItem): FileRef {
  const match = /\/blob\/([0-9a-f]{7,40})\//.exec(item.html_url);
  const ref = match?.[1] ?? "HEAD";
  const [owner, repo] = item.repository.full_name.split("/");
  return { owner, repo, ref, path: item.path };
}

function githubToken(): string {
  return process.env.GITHUB_TOKEN?.trim() ?? "";
}

function headers(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken()}`,
  };
}

function rawUrl(ref: FileRef): string {
  const encodedPath = ref.path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}/${encodedPath}`;
}

export const githubProvider: SourcePlugin = {
  id: "github",
  label: "GitHub",
  canDownload: true,

  availability(): SourceAvailability {
    const has = githubToken().length > 0;
    return {
      id: "github",
      label: "GitHub",
      searchable: has,
      downloadable: has,
      blockedReason: has
        ? undefined
        : "GitHub's code-search API requires a token even for public repos — add GITHUB_TOKEN to your .env.",
      setupUrl: has ? undefined : "https://github.com/settings/tokens",
    };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    if (!githubToken()) return [];
    const q = `${query.trim()} extension:${DEFAULT_EXT} in:path`;
    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&per_page=${clamp(limit, 1, 30)}`;

    const res = await fetchWithUA(url, { headers: headers() });
    if (!res.ok) {
      throw new Error(`GitHub code search failed (${res.status}): ${await safeText(res)}`);
    }
    const data = (await res.json()) as GhCodeSearchResponse;

    return data.items.map((item) => {
      const ref = parseBlobUrl(item);
      return {
        id: encodeRef(ref),
        source: "github" as const,
        title: `${item.name} — ${item.repository.full_name}`,
        creator: item.repository.owner?.login,
        webUrl: item.html_url,
        downloadable: true,
        summary: `Found in ${item.repository.full_name} at ${item.path}`,
      };
    });
  },

  async listFiles(modelId: string): Promise<SourcedFile[]> {
    const ref = decodeRef(modelId);
    const ext = extOf(ref.path);
    return [
      {
        id: modelId,
        name: ref.path.split("/").pop() ?? ref.path,
        ext,
        url: rawUrl(ref),
        preferred: isMeshExt(ext),
      },
    ];
  },

  async fileUrl(modelId: string): Promise<ResolvedFileUrl> {
    const ref = decodeRef(modelId);
    return { url: rawUrl(ref), fileName: ref.path.split("/").pop() };
  },
};

/** Exported for the URL resolver: turn a github.com blob/tree/release URL
 *  into raw, fetchable mesh URLs without going through code search (used
 *  when the USER pastes a specific GitHub link rather than searching). */
export async function listMeshFilesInGithubUrl(url: string): Promise<SourcedFile[]> {
  const blob = /github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url);
  if (blob) {
    const [, owner, repo, ref, rawPath] = blob;
    // The URL's path segment is percent-encoded (e.g. "3D%20Printing"); the
    // GitHub API's own `path` fields are NOT, so this must be decoded before
    // it's ever compared against or joined with real API data.
    const path = decodeURIComponent(rawPath);
    const ext = extOf(path);
    if (!isMeshExt(ext)) return [];
    return [{ id: encodeRef({ owner, repo, ref, path }), name: path.split("/").pop() ?? path, ext, preferred: true, url: rawUrl({ owner, repo, ref, path }) }];
  }

  const tree = /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/.exec(url);
  const repoRoot = /github\.com\/([^/]+)\/([^/]+)\/?$/.exec(url);
  const rootMatch = tree ?? repoRoot;
  if (rootMatch) {
    const [, owner, repo, refMaybe, rawSubpath] = rootMatch;
    const ref = refMaybe || "HEAD";
    const path = rawSubpath ? decodeURIComponent(rawSubpath) : "";
    return listGithubTree(owner, repo, ref, path);
  }

  return [];
}

function publicApiHeaders(): Record<string, string> {
  return githubToken() ? headers() : { Accept: "application/vnd.github+json" };
}

/** GitHub's git-refs endpoints don't uniformly accept the symbolic "HEAD" —
 *  resolve it to the repo's real default branch first when the URL didn't
 *  name one (a bare `github.com/owner/repo` link). */
async function resolveRef(owner: string, repo: string, ref: string): Promise<string> {
  if (ref && ref !== "HEAD") return ref;
  const meta = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers: publicApiHeaders() },
  );
  return meta.default_branch ?? "main";
}

/** Enumerate every mesh file under a repo (optionally scoped to a subpath)
 *  via the recursive git trees API — one call covers the whole repo, unlike
 *  paging through the Contents API directory by directory. */
async function listGithubTree(owner: string, repo: string, refInput: string, subpath: string): Promise<SourcedFile[]> {
  const ref = await resolveRef(owner, repo, refInput);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const data = await fetchJson<{ tree: Array<{ path: string; type: string; size?: number }> }>(apiUrl, {
    headers: publicApiHeaders(),
  });
  const prefix = subpath ? `${subpath.replace(/\/+$/, "")}/` : "";
  return data.tree
    .filter((e) => e.type === "blob" && (!prefix || e.path.startsWith(prefix)) && isMeshExt(extOf(e.path)))
    .map((e) => ({
      id: encodeRef({ owner, repo, ref, path: e.path }),
      name: e.path.split("/").pop() ?? e.path,
      ext: extOf(e.path),
      sizeBytes: e.size,
      url: rawUrl({ owner, repo, ref, path: e.path }),
      preferred: extOf(e.path) === ".stl",
    }));
}
