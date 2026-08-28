// ─────────────────────────────────────────────────────────────────────────────
// GET/PATCH /api/settings and PATCH /api/preferences — the web equivalent of
// the Electron settings sheet: which Claude model and reasoning effort to use,
// and the persistent printing defaults (printer geometry, material, goal,
// infill, pattern, supports, brim).
//
// These read and write through main/settings.ts, which is session-scoped (see
// main/session-context.ts), so each visitor gets their own settings.json under
// their own session directory. sessionMiddleware has already established the
// ambient session by the time any handler here runs, so nothing needs to be
// threaded through explicitly.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import {
  getSettings,
  updateSettings,
  updatePreferences,
  MODEL_CATALOG,
  EFFORT_LEVELS,
} from "../../main/settings";
import { KNOWN_PRINTERS } from "../../main/profiles";
import { seedSessionFromPreferences } from "../../main/agent/state";
import type {
  SettingsState,
  PrintMaterial,
  PrintGoal,
  EffortLevel,
} from "../../shared/types";

const MATERIALS: PrintMaterial[] = ["PLA", "PETG", "ABS"];
const GOALS: PrintGoal[] = ["draft", "quality", "functional"];

/** The full settings payload, shaped exactly like the Electron renderer's, so
 *  the web client can render the same controls from the same data. */
function settingsState(): SettingsState {
  const s = getSettings();
  return {
    current: { model: s.model, effort: s.effort },
    models: MODEL_CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      supportsEffort: m.supportsEffort,
      supportsXHigh: m.supportsXHigh,
      supportsMax: m.supportsMax,
    })),
    efforts: EFFORT_LEVELS,
    preferences: s.preferences,
    printers: Object.entries(KNOWN_PRINTERS).map(([key, p]) => ({
      key,
      label: p.label,
      nozzleMm: p.nozzleMm,
      bed: p.bed,
    })),
    materials: MATERIALS,
    goals: GOALS,
  };
}

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/settings", (_req: Request, res: Response) => {
    res.json(settingsState());
  });

  /** Change the model and/or reasoning effort for this session. */
  router.patch("/settings", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { model?: unknown; effort?: unknown };
    const patch: { model?: string; effort?: EffortLevel } = {};
    // Validate against the catalogs rather than trusting the client — an
    // unknown model id would 400 at the Anthropic API mid-turn instead.
    if (typeof body.model === "string" && MODEL_CATALOG.some((m) => m.id === body.model)) {
      patch.model = body.model;
    }
    if (
      typeof body.effort === "string" &&
      (EFFORT_LEVELS as string[]).includes(body.effort)
    ) {
      patch.effort = body.effort as EffortLevel;
    }
    if (!Object.keys(patch).length) {
      res.status(400).json({ error: "No valid model or effort supplied." });
      return;
    }
    updateSettings(patch);
    res.json(settingsState());
  });

  /**
   * Merge printing preferences. A field sent as null is CLEARED, which is how
   * the UI un-sets a saved default. main/settings.ts sanitizes every value, so
   * bad input is dropped rather than persisted.
   */
  router.patch("/preferences", (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Expected a preferences object." });
      return;
    }
    const next = updatePreferences(body as Record<string, unknown>);
    // Keep this session's agent state in step, so a preference change takes
    // effect on the next turn rather than after a reload.
    seedSessionFromPreferences({
      printer: next.preferences.printer,
      material: next.preferences.material,
    });
    res.json(settingsState());
  });

  return router;
}
