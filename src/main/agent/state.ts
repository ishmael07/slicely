// Per-process session state shared between the agent loop and tool executor.
// Slicely is a single-window personal app, so a module-level singleton is fine.
import type { ModelResult, SliceParams } from "../../shared/types";

interface SessionState {
  /** The most recent search results (so the agent can reference them by id). */
  lastResults: ModelResult[];
  /** Absolute path of the most recently imported model (primary part). */
  lastModelPath: string;
  /** All mesh part paths of the active model (>=1) — for multi-part plates. */
  lastModelParts: string[];
  /** The last recommendation, used as defaults when slicing. */
  lastRecommendation: SliceParams;
  /** The exact effective params of the most recent slice — so open_in_slicer
   *  can open the GUI with settings identical to what was sliced. */
  lastSliceParams?: SliceParams;
  /** The base config .ini resolved for the most recent slice. */
  lastConfigIni?: string;
  /** The printer the user picked this session (key into KNOWN_PRINTERS). */
  printerKey?: string;
  /** The material chosen this session (for synthesized filament density/cost). */
  material?: string;
  /** Bridge to open a URL in the user's default browser (set by main). */
  openExternal?: (url: string) => void;
}

export const sessionState: SessionState = {
  lastResults: [],
  lastModelPath: "",
  lastModelParts: [],
  lastRecommendation: {},
};
