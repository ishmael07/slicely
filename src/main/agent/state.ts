// Conversation state shared between the agent loop and the tool executor.
//
// In Electron this behaves exactly like the module-level singleton it used to
// be. On the web server, every visitor needs their own — so the exported
// `sessionState` is a Proxy that resolves to the ambient session's record (see
// session-context.ts). Every existing `sessionState.foo` read/write keeps
// working unchanged; it just lands in the right session's bucket.
import type { ModelResult, SliceParams, PrinterPref } from "../../shared/types";
import { currentSessionId } from "../session-context";

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
  /** Path of the most recently sliced .gcode — the default target when the
   *  user says "send it to the printer" without naming a file. */
  lastGcodePath?: string;
  /** Id of the most recently planned multi-plate job, so run_job/job_status
   *  work without the user repeating it. */
  lastJobId?: string;
  /** The printer the user picked this session (key into KNOWN_PRINTERS).
   *  Seeded from saved preferences; set "custom" when using customPrinter. */
  printerKey?: string;
  /** A custom (typed) printer geometry, when the saved/chosen printer isn't a
   *  catalog entry. Carries explicit bed + nozzle. */
  customPrinter?: PrinterPref;
  /** The material chosen this session (for synthesized filament density/cost). */
  material?: string;
  /** Bridge to open a URL in the user's default browser (set by main). */
  openExternal?: (url: string) => void;
}

function freshState(): SessionState {
  return {
    lastResults: [],
    lastModelPath: "",
    lastModelParts: [],
    lastRecommendation: {},
  };
}

/** One record per session, created on first touch. */
const states = new Map<string, SessionState>();

function stateFor(id: string): SessionState {
  let st = states.get(id);
  if (!st) {
    st = freshState();
    states.set(id, st);
  }
  return st;
}

/**
 * The ambient session's conversation state.
 *
 * A Proxy rather than a plain object so the ~40 existing `sessionState.x` call
 * sites need no changes: each access resolves the current session first. Under
 * Electron there is only ever the default session, so this is equivalent to the
 * old singleton.
 */
export const sessionState: SessionState = new Proxy({} as SessionState, {
  get(_target, prop) {
    return stateFor(currentSessionId())[prop as keyof SessionState];
  },
  set(_target, prop, value) {
    (stateFor(currentSessionId()) as unknown as Record<string | symbol, unknown>)[
      prop
    ] = value;
    return true;
  },
  has(_target, prop) {
    return prop in stateFor(currentSessionId());
  },
  deleteProperty(_target, prop) {
    delete (stateFor(currentSessionId()) as unknown as Record<
      string | symbol,
      unknown
    >)[prop];
    return true;
  },
  ownKeys() {
    return Reflect.ownKeys(stateFor(currentSessionId()));
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(stateFor(currentSessionId()), prop);
  },
});

/** Drop a session's conversation state (called when a web session is evicted). */
export function disposeSessionState(id: string): void {
  states.delete(id);
}

/** Make the session's printer/material AUTHORITATIVELY reflect the user's saved
 *  preferences, so a returning user never has to re-state their printer or
 *  filament. Called when the agent is constructed and after the preferences are
 *  changed in the UI — so clearing the printer/material in Settings clears it
 *  live too (not just after a restart). A subsequent in-chat set_printer (which
 *  also persists) still wins, because it writes the prefs and re-seeds. */
export function seedSessionFromPreferences(prefs: {
  printer?: PrinterPref;
  material?: string;
}): void {
  if (prefs.printer) {
    sessionState.printerKey = prefs.printer.key;
    sessionState.customPrinter =
      prefs.printer.key === "custom" ? prefs.printer : undefined;
  } else {
    sessionState.printerKey = undefined;
    sessionState.customPrinter = undefined;
  }
  sessionState.material = prefs.material;
}
