// Provider interface shared by every marketplace client.
import type { ModelResult, ModelFile, DownloadResult } from "../../shared/types";

export interface SearchProvider {
  readonly id: string;
  /** Returns true if this provider has the credentials it needs to run. */
  isAvailable(): boolean;
  /** Free-text search. Returns normalized results (may be empty). */
  search(query: string, limit: number): Promise<ModelResult[]>;
}

/** A provider that can additionally download files in-app. */
export interface DownloadProvider extends SearchProvider {
  /** List downloadable mesh files for a model. */
  listFiles(modelId: string): Promise<ModelFile[]>;
  /** Download a specific file (or the best default) to disk. */
  download(
    modelId: string,
    destDir: string,
    fileId?: string,
  ): Promise<DownloadResult>;
}

export function isDownloadProvider(
  p: SearchProvider,
): p is DownloadProvider {
  return (
    typeof (p as DownloadProvider).download === "function" &&
    typeof (p as DownloadProvider).listFiles === "function"
  );
}
