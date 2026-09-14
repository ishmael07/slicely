// ─────────────────────────────────────────────────────────────────────────────
// GET/PATCH /api/settings and PATCH /api/preferences — the web equivalent of
// the Electron settings sheet: which model (from either provider) and reasoning
// effort to use, and the persistent printing defaults (printer geometry,
// material, goal, infill, pattern, supports, brim).
//
// These read and write through main/settings.ts, which is session-scoped (see
// main/session-context.ts), so each visitor gets their own settings.json under
// their own session directory. sessionMiddleware has already established the
// ambient session by the time any handler here runs, so nothing needs to be
// threaded through explicitly.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import type { Request, Response } from "express";
import { sendError, WireError } from "../errors";
import {
  getSettings,
  updateSettings,
  updatePreferences,
  MODEL_CATALOG,
  EFFORT_LEVELS,
} from "../../main/settings";
import { providerForModel } from "../../main/agent/provider";
import { resolveTurnFunding } from "../../main/agent/funding";
import { getUserApiKey } from "../../main/userkey";
import { signinProvidersFromEnv } from "./config";
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
      provider: m.provider,
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

/**
 * True when THIS request's next chat turn would be paid for out of free credit.
 *
 * Asked by resolving the funding for real, rather than by re-deriving the rule,
 * so the picker and the chat route cannot disagree about who is paying. Every
 * refusal `resolveTurnFunding` can throw — not signed in, blocked, capped, broke
 * — means the caller is not currently ON credit, and those cases fall through to
 * the per-model key check below, which is the answer they had before accounts
 * existed.
 */
function onFreeCredit(req: Request): boolean {
  try {
    return resolveTurnFunding({
      accountId: req.session?.accountId,
      oauthConfigured: signinProvidersFromEnv().length > 0,
    }).source === "free";
  } catch {
    return false;
  }
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
      sendError(res, new WireError(400, "No valid model or effort supplied."));
      return;
    }
    // ON FREE CREDIT THERE IS NO PICKER. The free tier runs one model at one
    // effort — that is what makes fifty cents buy a real trial — and
    // `resolveTurnFunding` would override a stored choice anyway, so saving one
    // would only ever be a lie the Settings sheet told. The refusal names the
    // fix, and the SENTENCE IS THE ONE THE UI SHOWS, deliberately: two copies of
    // it is how the server and the client come to say different things.
    //
    // The provider asked about is the one for the REQUESTED model (or the current
    // one for an effort-only change): someone who holds an OpenAI key and is on
    // credit for an Anthropic model can still switch to the model they can pay
    // for. That is the point of the switch.
    if (onFreeCredit(req)) {
      const target = providerForModel(patch.model ?? getSettings().model);
      if (!getUserApiKey(target.id)) {
        sendError(res, new WireError(403, "Add your own key to choose models.", "forbidden"));
        return;
      }
    }
    // A model is only choosable if the key that pays for it exists. Refusing
    // here — with the provider NAMED, since that is the missing piece — beats
    // saving the choice and failing on the user's next message, which is where
    // they would have to work out for themselves which key was missing.
    if (patch.model) {
      const provider = providerForModel(patch.model);
      if (!getUserApiKey(provider.id)) {
        sendError(
          res,
          new WireError(409, `Connect your ${provider.label} API key in Settings to use that model.`, "no_key"),
        );
        return;
      }
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
      sendError(res, new WireError(400, "Expected a preferences object."));
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
