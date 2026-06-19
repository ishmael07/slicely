// Provider registry — wires the marketplace clients together and exposes a
// single search/download surface for the agent tools.
import type { ModelResult, ModelFile, DownloadResult } from "../../shared/types";
import { getConfig } from "../config";
import type { SearchProvider, DownloadProvider } from "./types";
import { isDownloadProvider } from "./types";
import { ThingiverseProvider } from "./thingiverse";
import { PrintablesProvider } from "./printables";
import { MakerWorldProvider } from "./makerworld";

export type SourceFilter = "all" | "thingiverse" | "printables" | "makerworld";

let registry: SearchProvider[] | null = null;

function providers(): SearchProvider[] {
  if (registry) return registry;
  const cfg = getConfig();
  registry = [
    new ThingiverseProvider(cfg.thingiverseToken),
    new PrintablesProvider(),
    new MakerWorldProvider(),
  ];
  return registry;
}

function find(id: string): SearchProvider | undefined {
  return providers().find((p) => p.id === id);
}

/**
 * Search across one or all providers, in parallel. A provider that throws or is
 * unavailable is skipped (with a console warning) rather than failing the whole
 * search — so one flaky source never blanks the results.
 */
export async function searchModels(
  query: string,
  opts: { source?: SourceFilter; limit?: number } = {},
): Promise<ModelResult[]> {
  const limit = opts.limit ?? 8;
  const source = opts.source ?? "all";

  const targets = providers().filter(
    (p) => p.isAvailable() && (source === "all" || p.id === source),
  );

  const settled = await Promise.allSettled(
    targets.map((p) => p.search(query, limit)),
  );

  const results: ModelResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      results.push(...s.value);
    } else {
      console.warn(
        `[providers] ${targets[i].id} search failed:`,
        s.reason?.message ?? s.reason,
      );
    }
  });

  // Interleave sources so one provider doesn't dominate the top of the list.
  return interleaveBySource(results).slice(0, source === "all" ? limit * 2 : limit);
}

export async function listModelFiles(
  source: string,
  modelId: string,
): Promise<ModelFile[]> {
  const p = find(source);
  if (!p || !isDownloadProvider(p)) {
    throw new Error(`Source "${source}" does not support file listing.`);
  }
  return p.listFiles(modelId);
}

export async function downloadModel(
  source: string,
  modelId: string,
  fileId?: string,
): Promise<DownloadResult> {
  const p = find(source);
  if (!p || !isDownloadProvider(p)) {
    throw new Error(
      `Source "${source}" can't be downloaded in-app — open it in your browser instead.`,
    );
  }
  if (!p.isAvailable()) {
    throw new Error(
      `Thingiverse isn't configured. Add THINGIVERSE_APP_TOKEN to your .env to enable downloads.`,
    );
  }
  return (p as DownloadProvider).download(modelId, getConfig().downloadsDir, fileId);
}

/** Round-robin the results by source for a balanced first page. */
function interleaveBySource(results: ModelResult[]): ModelResult[] {
  const bySource = new Map<string, ModelResult[]>();
  for (const r of results) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }
  const queues = [...bySource.values()];
  const out: ModelResult[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}
