// The sourcing façade — the only module other layers (jobs, server, agent
// tools) should import from. Fixed public surface; see the six exports
// below. Fans a federated search out to every available provider in
// parallel with a per-source timeout, so one dead/slow source never blanks
// the whole result set (each provider's outcome is reported individually in
// `SearchOutcome.sources`).
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  SearchOptions,
  SearchOutcome,
  SourceAvailability,
  SourceId,
  SourcedFile,
  SourcedModel,
  SourcePlugin,
  UrlResolution,
} from "../../shared/sourcing";
import type { DownloadPart, DownloadResult } from "../../shared/types";
import { getConfig } from "../config";
import { allProviders, getProvider } from "./providers/registry";
import { rankAndDedupe } from "./ranking";
import { resolveUrl as resolveUrlImpl } from "./resolve";
import { downloadUrlToDir } from "./download";
import { sanitizeFileName } from "./fsutil";

const DEFAULT_LIMIT = 12;
const DEFAULT_PER_SOURCE = 10;
const PER_SOURCE_TIMEOUT_MS = 10_000;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Reject after `ms` (or when `signal` aborts) without cancelling the
 *  underlying provider call — SourcePlugin.search() takes no AbortSignal, so
 *  a timed-out provider keeps running in the background and its result is
 *  simply ignored; this only bounds how long the CALLER waits. */
function raceTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Federated search across every available source, in parallel, each bounded
 * by its own timeout. Results are fused + ranked + deduplicated (see
 * ranking.ts) before being truncated to `opts.limit`.
 */
/**
 * Narrow a padded query down to its subject terms for a retry.
 *
 * Sources differ in how they combine terms: Printables ANDs them (so every
 * extra word shrinks the result set to nothing), while Thingiverse ORs them
 * (so extra generic words drag in unrelated models). Keeping the leading two
 * tokens targets the subject — "Acura logo emblem" becomes "Acura logo" —
 * because qualifiers are conventionally trailing.
 *
 * Returns undefined when there is nothing useful to narrow (2 tokens or less).
 */
export function narrowQuery(query: string): string | undefined {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 2) return undefined;
  return tokens.slice(0, 2).join(" ");
}

export async function searchModels(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
  const perSource = opts.perSource ?? DEFAULT_PER_SOURCE;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const wanted = opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : undefined;

  const targets = allProviders().filter((p) => {
    if (wanted && !wanted.has(p.id)) return false;
    return p.availability().searchable;
  });

  const sourcesReport: SearchOutcome["sources"] = [];
  const allResults: SourcedModel[] = [];

  await Promise.all(
    targets.map(async (provider) => {
      const start = Date.now();
      try {
        const results = await raceTimeout(
          provider.search(query, perSource),
          PER_SOURCE_TIMEOUT_MS,
          opts.signal,
        );
        allResults.push(...results);
        sourcesReport.push({ id: provider.id, ok: true, count: results.length, ms: Date.now() - start });
      } catch (err) {
        sourcesReport.push({
          id: provider.id,
          ok: false,
          count: 0,
          ms: Date.now() - start,
          error: describeError(err),
        });
      }
    }),
  );

  // Some sources AND every term together, so one extra word returns nothing:
  // Printables gives 8 hits for "acura logo" and 0 for "acura logo emblem".
  // Rather than trust the caller to phrase it well, retry the sources that
  // came back empty using just the leading (subject) terms.
  const narrowed = narrowQuery(query);
  const emptyOnes = targets.filter((p) =>
    sourcesReport.some((r) => r.id === p.id && r.ok && r.count === 0),
  );
  if (narrowed && emptyOnes.length > 0) {
    await Promise.all(
      emptyOnes.map(async (provider) => {
        try {
          const results = await raceTimeout(
            provider.search(narrowed, perSource),
            PER_SOURCE_TIMEOUT_MS,
            opts.signal,
          );
          if (results.length === 0) return;
          allResults.push(...results);
          const row = sourcesReport.find((r) => r.id === provider.id);
          if (row) {
            row.count = results.length;
            row.narrowedTo = narrowed;
          }
        } catch {
          // The first attempt already succeeded-with-zero; a failed retry
          // changes nothing and must not turn that into an error row.
        }
      }),
    );
  }

  const ranked = rankAndDedupe(query, allResults, { downloadableOnly: opts.downloadableOnly }).slice(
    0,
    limit,
  );

  // NOTE on SearchOptions.bed: accepted for contract compatibility, but no
  // provider's search response includes real-world dimensions pre-download
  // (every source needs a follow-up per-model call for that, which isn't
  // done here to avoid multiplying request volume on every search) — so it
  // currently has no effect. Oversized detection happens later, in the
  // existing post-download mesh-inspection step.

  return { results: ranked, sources: sourcesReport };
}

/** Resolve any pasted URL — model page, direct mesh, archive, git repo, or
 *  an arbitrary page with mesh links — to whatever Slicely can do with it. */
export async function resolveUrl(url: string): Promise<UrlResolution> {
  return resolveUrlImpl(url);
}

/** List a model's downloadable files from a specific source. */
export async function listFiles(source: SourceId, modelId: string): Promise<SourcedFile[]> {
  const provider = getProvider(source);
  if (!provider?.listFiles) {
    throw new Error(`Source "${source}" doesn't support file listing.`);
  }
  return provider.listFiles(modelId);
}

/** Resolve one file to a fetchable URL: prefer a URL already embedded on the
 *  SourcedFile (no extra API call needed), falling back to the provider's
 *  `fileUrl` for sources where a download link must be minted per-file
 *  (Thingiverse's signed CDN url, Printables' GetDownloadLink mutation). */
async function resolveFileDownload(
  file: SourcedFile,
  provider?: SourcePlugin,
  modelId?: string,
): Promise<{ url: string; headers?: Record<string, string>; fileName?: string }> {
  if (file.url) return { url: file.url, fileName: file.name };
  if (!provider?.fileUrl || !modelId) {
    throw new Error(`No download URL available for "${file.name}".`);
  }
  return provider.fileUrl(modelId, file.id);
}

/** Download every file in `files` into `destDir`, skipping (not failing on)
 *  any single file that errors — mirrors v1's "grab the whole model" so a
 *  multi-part model (several STLs that are physically separate parts) comes
 *  down as one DownloadResult with every part, matching DownloadResult's
 *  documented primary+parts shape. */
async function downloadManyFiles(
  files: SourcedFile[],
  destDir: string,
  opts: { provider?: SourcePlugin; modelId?: string } = {},
): Promise<DownloadResult> {
  await mkdir(destDir, { recursive: true });
  const parts: DownloadPart[] = [];

  for (const file of files) {
    try {
      const resolved = await resolveFileDownload(file, opts.provider, opts.modelId);
      const result = await downloadUrlToDir(resolved.url, destDir, {
        headers: resolved.headers,
        suggestedName: resolved.fileName ?? file.name,
      });
      parts.push(
        ...(result.parts ?? [
          {
            localPath: result.localPath,
            fileName: result.fileName,
            sizeBytes: result.sizeBytes,
            ext: extname(result.fileName).toLowerCase(),
          },
        ]),
      );
    } catch (err) {
      console.warn(`[sourcing] skipped "${file.name}": ${describeError(err)}`);
    }
  }

  if (parts.length === 0) {
    throw new Error("Couldn't download any files for this model.");
  }

  const primary =
    [...parts].filter((p) => p.ext === ".stl").sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ??
    [...parts].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];

  return { localPath: primary.localPath, fileName: primary.fileName, sizeBytes: primary.sizeBytes, parts };
}

/** Download a model — every mesh file it has by default (grouped into one
 *  per-model folder), or just `opts.fileId` when the caller wants one
 *  specific file. */
export async function downloadModel(
  source: SourceId,
  modelId: string,
  opts: { fileId?: string; destDir?: string } = {},
): Promise<DownloadResult> {
  const provider = getProvider(source);
  if (!provider) throw new Error(`Unknown source "${source}".`);
  if (!provider.canDownload || !provider.fileUrl) {
    throw new Error(`"${provider.label}" can't be downloaded in-app — open it in your browser instead.`);
  }
  const avail = provider.availability();
  if (!avail.downloadable) {
    throw new Error(avail.blockedReason ?? `"${provider.label}" isn't configured for downloads.`);
  }

  const baseDir = opts.destDir ?? getConfig().downloadsDir;
  const destDir = join(baseDir, sanitizeFileName(`${source}-${modelId}`, `${source}-model`));

  if (opts.fileId) {
    const resolved = await provider.fileUrl(modelId, opts.fileId);
    await mkdir(destDir, { recursive: true });
    return downloadUrlToDir(resolved.url, destDir, { headers: resolved.headers, suggestedName: resolved.fileName });
  }

  const files = provider.listFiles ? await provider.listFiles(modelId) : [];
  if (files.length === 0) {
    // No file listing available (or it came back empty) — fall back to the
    // provider's own notion of "the default file" for this model.
    const resolved = await provider.fileUrl(modelId);
    await mkdir(destDir, { recursive: true });
    return downloadUrlToDir(resolved.url, destDir, { headers: resolved.headers, suggestedName: resolved.fileName });
  }

  return downloadManyFiles(files, destDir, { provider, modelId });
}

/** Download whatever `resolveUrl` finds at a pasted URL. */
export async function downloadFromUrl(url: string, opts: { destDir?: string } = {}): Promise<DownloadResult> {
  const resolution = await resolveUrlImpl(url);
  if (resolution.kind === "unsupported" || resolution.files.length === 0) {
    throw new Error(resolution.message);
  }

  const baseDir = opts.destDir ?? getConfig().downloadsDir;

  // A scraped page's links are unrelated candidates, not confirmed parts of
  // one model — download only the best-ranked one. Every other kind's files
  // are all genuinely part of the same resolved target (a model's file list,
  // a repo's mesh files, or the single direct-mesh/archive file itself).
  if (resolution.kind === "scraped-page") {
    return downloadManyFiles([resolution.files[0]], baseDir);
  }

  if (resolution.kind === "model-page" && resolution.model) {
    const provider = getProvider(resolution.model.source);
    const destDir = join(baseDir, sanitizeFileName(`${resolution.model.source}-${resolution.model.id}`));
    return downloadManyFiles(resolution.files, destDir, { provider, modelId: resolution.model.id });
  }

  const destDir =
    resolution.files.length > 1 ? join(baseDir, sanitizeFileName(folderNameFromUrl(url))) : baseDir;
  return downloadManyFiles(resolution.files, destDir);
}

function folderNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return `${u.hostname}-${segs.slice(0, 2).join("-") || "download"}`;
  } catch {
    return "download";
  }
}

/** Which sources are configured/reachable right now, and why not when
 *  they aren't — surfaced so the UI can explain a gap instead of just
 *  showing fewer results. */
export function sourceAvailability(): SourceAvailability[] {
  return allProviders().map((p) => p.availability());
}
