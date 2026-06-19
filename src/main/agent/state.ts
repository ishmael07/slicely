// Per-process session state shared between the agent loop and tool executor.
// Slicely is a single-window personal app, so a module-level singleton is fine.
import type { ModelResult, SliceParams } from "../../shared/types";

interface SessionState {
  /** The most recent search results (so the agent can reference them by id). */
  lastResults: ModelResult[];
  /** Absolute path of the most recently imported model. */
  lastModelPath: string;
  /** The last recommendation, used as defaults when slicing. */
  lastRecommendation: SliceParams;
  /** The printer the user picked this session (key into KNOWN_PRINTERS). */
  printerKey?: string;
  /** Bridge to open a URL in the user's default browser (set by main). */
  openExternal?: (url: string) => void;
}

export const sessionState: SessionState = {
  lastResults: [],
  lastModelPath: "",
  lastRecommendation: {},
};
