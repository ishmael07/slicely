// The universal URL resolver — paste ANY url, get back what Slicely can do
// with it. This is the highest-value file in the sourcing layer: it's what
// turns "I found a model on some random site" into a printable file, and
// what lets a meta-search hit (Thangs/Yeggi/STLfinder, which never host
// files themselves) actually resolve to something downloadable.
//
// Classification order matters — most to least specific:
//   1. model-page  — a known marketplace URL → delegate to that provider.
//   2. git-repo    — a GitHub or GitLab repo/tree/blob/release URL.
//   3. archive     — path ends in .zip.
//   4. direct-mesh — path ends in a mesh extension, confirmed by peeking at
//                    the actual bytes (never trust the extension alone: a
//                    login-gated "download" link routinely serves an HTML
//                    error page at a URL that still ends in ".stl").
//   5. scraped-page — fetch the HTML, use cheerio to find mesh/archive links.
//   6. unsupported — always with a message saying why.
//
// SSRF guard runs FIRST, before any network activity, via net.ts's
// `assertPublicHttpUrl` (rejects localhost/127.*/10.*/192.168.*/172.16-31.*/
// 169.254.*/::1 — see net.ts for the exact ranges and how DNS-rebinding is
// handled too).
import * as cheerio from "cheerio";
import type {
  SourcedFile,
  SourcedModel,
  SourceId,
  UrlResolution,
} from "../../shared/sourcing";
import { assertPublicHttpUrl, fetchJson, guardedFetch, peekBytes } from "./net";
import { extOf, isArchiveExt, isMeshExt, filenameFromUrl } from "./fsutil";
import { looksLikeErrorPage, sniffMagicBytes } from "./sniff";
import { getProvider } from "./providers/registry";
import { listMeshFilesInGithubUrl } from "./providers/github";
import { extractDownloadCandidates, isBotChallenge } from "./providers/scrape-common";

interface ModelPageMatch {
  source: SourceId;
  modelId: string;
}

/** Known marketplace URL shapes → (source, modelId). Order-independent;
 *  first match wins. */
const MODEL_PAGE_PATTERNS: Array<{ re: RegExp; source: SourceId }> = [
  { re: /thingiverse\.com\/thing:(\d+)/i, source: "thingiverse" },
  { re: /printables\.com\/(?:[a-z]{2}\/)?model\/(\d+)/i, source: "printables" },
  { re: /makerworld\.com\/(?:[a-z]{2}\/)?models\/(\d+)/i, source: "makerworld" },
  { re: /myminifactory\.com\/object\/[^/?#]*?-(\d+)\/?(?:[?#]|$)/i, source: "myminifactory" },
  { re: /myminifactory\.com\/object\/(\d+)\/?(?:[?#]|$)/i, source: "myminifactory" },
  { re: /3d\.nih\.gov\/entries\/([a-z0-9-]+)/i, source: "nih3d" },
  { re: /si\.edu\/object\/([^?#]+)/i, source: "smithsonian" },
];

function matchModelPage(url: string): ModelPageMatch | undefined {
  for (const { re, source } of MODEL_PAGE_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return { source, modelId: decodeURIComponent(m[1]) };
  }
  return undefined;
}

function placeholderModel(source: SourceId, modelId: string, url: string): SourcedModel {
  const provider = getProvider(source);
  return {
    id: modelId,
    source,
    title: `${provider?.label ?? source} — ${modelId}`,
    webUrl: url,
    downloadable: provider?.canDownload ?? false,
  };
}

async function resolveModelPage(match: ModelPageMatch, url: string): Promise<UrlResolution> {
  const provider = getProvider(match.source);
  if (!provider?.listFiles) {
    return {
      kind: "unsupported",
      files: [],
      message: `Recognized this as a ${match.source} model page, but Slicely has no file listing for that source yet.`,
    };
  }
  try {
    const files = await provider.listFiles(match.modelId);
    const avail = provider.availability();
    return {
      kind: "model-page",
      model: placeholderModel(match.source, match.modelId, url),
      files,
      message:
        files.length > 0
          ? `Found ${files.length} file(s) on ${provider.label}.`
          : avail.downloadable
            ? `${provider.label} reports no downloadable mesh files for this model.`
            : `${provider.label} models aren't downloadable in-app (${avail.blockedReason ?? "login required"}) — opening in your browser instead.`,
    };
  } catch (err) {
    return {
      kind: "model-page",
      model: placeholderModel(match.source, match.modelId, url),
      files: [],
      message: `Couldn't list files from ${provider.label}: ${(err as Error).message}`,
    };
  }
}

// ── git-repo ──────────────────────────────────────────────────────────────

const GITHUB_RE = /(?:^https?:\/\/)?(?:www\.)?github\.com\//i;
const GITLAB_RE = /(?:^https?:\/\/)?(?:www\.)?gitlab\.com\//i;

/** GitLab support, implemented directly here (GitLab isn't a `SourceId` —
 *  it's not a searchable source, only ever reached by resolving a pasted
 *  URL). UNVERIFIED live this session (GitHub was the one probed) — the
 *  `/-/raw/{ref}/{path}` direct-download convention and the
 *  `/-/(blob|tree)/{ref}/{path}` URL shape are standard, well-documented
 *  GitLab conventions, not independently re-confirmed here. Falls back to
 *  the GitLab REST API (`/api/v4/projects/:id/repository/tree`) for
 *  enumerating a tree/repo-root URL — also unverified. */
async function resolveGitlabUrl(url: string): Promise<UrlResolution> {
  const afterDomain = url.replace(GITLAB_RE, "");
  const dashIdx = afterDomain.indexOf("/-/");
  if (dashIdx === -1) {
    // Bare repo root: group/project (no /-/blob or /-/tree).
    const projectPath = afterDomain.replace(/\/+$/, "").replace(/[?#].*$/, "");
    return listGitlabTree(projectPath, "HEAD", "", url);
  }

  const projectPath = afterDomain.slice(0, dashIdx);
  const rest = afterDomain.slice(dashIdx + 3); // strip "/-/"
  const blobMatch = /^blob\/([^/]+)\/(.+)$/.exec(rest);
  if (blobMatch) {
    const [, ref, path] = blobMatch;
    const ext = extOf(path);
    if (!isMeshExt(ext)) {
      return { kind: "unsupported", files: [], message: "That GitLab file isn't a recognized mesh format." };
    }
    const rawUrl = `https://gitlab.com/${projectPath}/-/raw/${ref}/${path}`;
    return {
      kind: "git-repo",
      files: [{ id: rawUrl, name: path.split("/").pop() ?? path, ext, url: rawUrl, preferred: true }],
      message: "Found 1 mesh file in this GitLab blob.",
    };
  }

  const treeMatch = /^tree\/([^/]+)\/?(.*)$/.exec(rest);
  if (treeMatch) {
    const [, ref, subpath] = treeMatch;
    return listGitlabTree(projectPath, ref, subpath, url);
  }

  return { kind: "unsupported", files: [], message: "Couldn't understand that GitLab URL." };
}

async function listGitlabTree(projectPath: string, ref: string, subpath: string, originalUrl: string): Promise<UrlResolution> {
  const encodedProject = encodeURIComponent(projectPath);
  const apiUrl = `https://gitlab.com/api/v4/projects/${encodedProject}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(ref)}${subpath ? `&path=${encodeURIComponent(subpath)}` : ""}`;
  try {
    const entries = await fetchJson<Array<{ path: string; type: string; name: string }>>(apiUrl);
    const files: SourcedFile[] = entries
      .filter((e) => e.type === "blob" && isMeshExt(extOf(e.path)))
      .map((e) => {
        const rawUrl = `https://gitlab.com/${projectPath}/-/raw/${ref}/${e.path}`;
        return { id: rawUrl, name: e.name, ext: extOf(e.name), url: rawUrl, preferred: extOf(e.name) === ".stl" };
      });
    return {
      kind: "git-repo",
      files,
      message: files.length > 0 ? `Found ${files.length} mesh file(s) in this GitLab repo.` : "No mesh files found in this GitLab repo/path.",
    };
  } catch (err) {
    return { kind: "unsupported", files: [], message: `Couldn't read that GitLab repo: ${(err as Error).message}. (${originalUrl})` };
  }
}

async function resolveGitRepoUrl(url: string): Promise<UrlResolution> {
  if (GITHUB_RE.test(url)) {
    const files = await listMeshFilesInGithubUrl(url);
    return {
      kind: "git-repo",
      files,
      message: files.length > 0 ? `Found ${files.length} mesh file(s) in this GitHub repo.` : "No mesh files found at that GitHub URL.",
    };
  }
  if (GITLAB_RE.test(url)) {
    return resolveGitlabUrl(url);
  }
  return { kind: "unsupported", files: [], message: "Unrecognized git host." };
}

// ── direct-mesh / archive / scraped-page ─────────────────────────────────

async function resolveDirectOrScraped(url: string): Promise<UrlResolution> {
  const ext = extOf(new URL(url).pathname);

  if (isArchiveExt(ext)) {
    const name = filenameFromUrl(url) ?? "archive.zip";
    return {
      kind: "archive",
      files: [{ id: url, name, ext: ".zip", url, preferred: false }],
      message: "This is a ZIP archive — its meshes will be extracted when downloaded.",
    };
  }

  if (isMeshExt(ext)) {
    // Confirm with real bytes rather than trusting the extension — catches a
    // login-gated link that quietly serves an HTML page at a ".stl" URL.
    try {
      const { res, head } = await peekBytes(url, 512);
      if (!res.ok) {
        return { kind: "unsupported", files: [], message: `That link returned ${res.status} — it may require login or no longer exist.` };
      }
      const sniffed = sniffMagicBytes(head);
      if (looksLikeErrorPage(sniffed)) {
        return { kind: "unsupported", files: [], message: "That link serves a webpage, not a file — it's likely login-gated or expired." };
      }
      const name = filenameFromUrl(url) ?? `model${ext}`;
      const lenHeader = res.headers.get("content-length");
      return {
        kind: "direct-mesh",
        files: [{ id: url, name, ext, url, sizeBytes: lenHeader ? Number(lenHeader) : undefined, preferred: true }],
        message: `Direct ${ext.slice(1).toUpperCase()} file.`,
      };
    } catch (err) {
      return { kind: "unsupported", files: [], message: `Couldn't reach that URL: ${(err as Error).message}` };
    }
  }

  return resolveScrapedPage(url);
}

async function resolveScrapedPage(url: string): Promise<UrlResolution> {
  let res: Response;
  try {
    res = await guardedFetch(url, { headers: { Accept: "text/html,*/*" } });
  } catch (err) {
    return { kind: "unsupported", files: [], message: `Couldn't reach that URL: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { kind: "unsupported", files: [], message: `That page returned ${res.status}.` };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    // Not HTML and not a recognized mesh/archive extension — sniff the body
    // in case it's an untyped/extensionless mesh URL (some CDNs serve files
    // with no extension), otherwise give up honestly.
    const { head } = await peekBytes(url, 512).catch(() => ({ head: Buffer.alloc(0) }));
    const sniffed = sniffMagicBytes(head);
    if (sniffed === "stl-binary" || sniffed === "stl-ascii") {
      const name = filenameFromUrl(url) ?? "model.stl";
      return { kind: "direct-mesh", files: [{ id: url, name, ext: ".stl", url, preferred: true }], message: "Direct STL file (detected by content, not extension)." };
    }
    return { kind: "unsupported", files: [], message: `Unrecognized content type "${contentType || "unknown"}" at that URL.` };
  }

  const html = await res.text();
  if (isBotChallenge(html)) {
    return { kind: "unsupported", files: [], message: "That site's bot-protection blocked this request — open the link in your browser instead." };
  }

  const files = extractDownloadCandidates(html, url);
  if (files.length === 0) {
    const title = cheerio.load(html)("title").first().text().trim();
    return {
      kind: "unsupported",
      files: [],
      message: `No downloadable mesh or archive links found on "${title || url}".`,
    };
  }

  return {
    kind: "scraped-page",
    files,
    message: `Found ${files.length} candidate file link(s) on that page.`,
  };
}

/**
 * Resolve any URL the user pastes into whatever Slicely can do with it. See
 * the module header for the full classification order.
 */
export async function resolveUrl(rawUrl: string): Promise<UrlResolution> {
  let url: URL;
  try {
    url = await assertPublicHttpUrl(rawUrl);
  } catch (err) {
    return { kind: "unsupported", files: [], message: (err as Error).message };
  }

  const modelPage = matchModelPage(url.toString());
  if (modelPage) return resolveModelPage(modelPage, url.toString());

  if (GITHUB_RE.test(url.toString()) || GITLAB_RE.test(url.toString())) {
    return resolveGitRepoUrl(url.toString());
  }

  return resolveDirectOrScraped(url.toString());
}
