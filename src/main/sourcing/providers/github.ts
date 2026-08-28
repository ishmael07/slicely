// GitHub as a model source: engineering and open-hardware parts that live in
// project repos (printable enclosures, jigs, robotics parts, Voron/RepRap mod
// libraries) rather than on a marketplace. Downloads via
// raw.githubusercontent.com.
//
// SEARCHES REPOSITORIES, NOT CODE. Code search was the obvious approach and is
// the wrong one, verified live 2026-08-28:
//   • `extension:stl` alone returns ~2756 hits, which makes code search LOOK
//     like it works.
//   • Add any keyword and it returns ZERO — every time. GitHub's code index
//     matches file CONTENT, and a binary STL has no indexable text. Neither
//     `in:path` nor `filename:` rescues it; both also return 0.
//   • Code search is additionally capped at 10 requests/minute, which a
//     federated search that fans out several phrasings would exhaust.
// So this searches repositories (30/min) and then enumerates each candidate's
// mesh files through the git trees API (5000/hour), which is both accurate and
// far cheaper on quota.
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

/** Repos inspected per search. Each costs one git-trees call, so this
 *  trades breadth against the core rate limit. */
const MAX_REPOS = 6;
/** Meshes taken from any one repo, so a big library cannot dominate. */
const MAX_FILES_PER_REPO = 4;

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
        : "GitHub's search API requires a token even for public repos. Add GITHUB_TOKEN to your .env.",
      setupUrl: has ? undefined : "https://github.com/settings/tokens",
    };
  },

  async search(query: string, limit: number): Promise<SourcedModel[]> {
    if (!githubToken()) return [];

    // Find repos first. Adding "3d print" biases toward printable projects
    // rather than software that merely shares a name ("dragon" is a great
    // example of a word that is mostly libraries on GitHub).
    const repoQuery = `${query.trim()} 3d print`;
    const repoUrl =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(repoQuery)}` +
      `&per_page=${clamp(MAX_REPOS, 1, 10)}&sort=stars&order=desc`;

    const res = await fetchWithUA(repoUrl, { headers: headers() });
    if (!res.ok) {
      throw new Error(`GitHub repository search failed (${res.status}): ${await safeText(res)}`);
    }
    const data = (await res.json()) as {
      items?: Array<{
        full_name: string;
        description?: string | null;
        default_branch?: string;
        stargazers_count?: number;
        html_url: string;
        owner?: { login?: string };
      }>;
    };
    const repos = data.items ?? [];
    if (repos.length === 0) return [];

    // Enumerate each repo's meshes. One tree call covers a whole repo, and a
    // repo with none simply contributes nothing rather than failing the search.
    const perRepo = await Promise.all(
      repos.map(async (repo) => {
        const [owner, name] = repo.full_name.split("/");
        if (!owner || !name) return [] as SourcedModel[];
        try {
          const files = await listGithubTree(
            owner,
            name,
            repo.default_branch ?? "",
            "",
          );
          return files.slice(0, MAX_FILES_PER_REPO).map((f) => ({
            id: f.id,
            source: "github" as const,
            title: `${f.name} — ${repo.full_name}`,
            creator: repo.owner?.login,
            webUrl: repo.html_url,
            downloadable: true,
            summary: repo.description ?? `Mesh file in ${repo.full_name}`,
            signals: { likes: repo.stargazers_count },
          }));
        } catch {
          // A private, empty, or oversized repo must not blank the source.
          return [] as SourcedModel[];
        }
      }),
    );

    // Interleave across repos so one large model library cannot fill the page.
    const out: SourcedModel[] = [];
    for (let i = 0; out.length < limit; i++) {
      let added = false;
      for (const list of perRepo) {
        if (i < list.length) {
          out.push(list[i]);
          added = true;
          if (out.length >= limit) break;
        }
      }
      if (!added) break;
    }
    return out;
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
