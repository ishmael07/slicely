// ─────────────────────────────────────────────────────────────────────────────
// What the user said about colour, in one shape the whole pipeline understands.
//
// slice_model and open_in_slicer took a single `filamentColour` string. A
// request naming two colours — "make it teal and black", the commonest
// multi-colour ask there is — had nowhere to put the second one, so the agent
// either dropped one or had to abandon these tools entirely for plan_job. One
// of two named colours silently disappearing is not a smaller version of the
// request; it is the wrong print.
//
// This normalises all three ways of asking into a single answer, so the
// decision "is this a multi-colour print, and where do the colours change" is
// made once rather than at every call site.
// ─────────────────────────────────────────────────────────────────────────────
import { normalizeHex } from "../jobs/colour";
import type { ColourStop } from "../jobs/colourchange";

export interface ColourRequest {
  /** The colour the print STARTS in — the swatch PrusaSlicer opens showing. */
  filamentColour?: string;
  /** Colours stacked bottom-first, when the user named several without
   *  saying where they change. Empty unless there are at least two. */
  bands: string[];
  /** Colour changes at heights the user actually named. */
  stops: ColourStop[];
  /** True when this needs more than one filament — the signal to route
   *  through the machinery that can deliver that. */
  isMultiColour: boolean;
}

/**
 * Read a tool call's colour arguments.
 *
 * `colourStops` beats `colours`: naming a height is a more specific request
 * than naming a sequence, and a caller that sent both meant the specific one.
 * Anything that isn't recognisably a colour is dropped rather than guessed at —
 * inventing a colour is how a plate nobody asked to be white got printed white.
 */
export function colourRequest(input: Record<string, unknown>): ColourRequest {
  const explicit = normalizeHex(asString(input.filamentColour));

  const stops = readStops(input.colourStops);
  if (stops.length > 0) {
    return {
      // A stop at or below the bed IS the starting colour; it needs no swap,
      // so it never appears in the changes and would otherwise be invisible.
      filamentColour: explicit ?? startingColourOf(stops),
      bands: [],
      stops,
      isMultiColour: true,
    };
  }

  const colours = readColours(input.colours);
  if (colours.length >= 2) {
    return {
      filamentColour: explicit ?? colours[0],
      bands: colours,
      stops: [],
      isMultiColour: true,
    };
  }

  // One colour, however it was spelled: an ordinary single-filament print.
  return {
    filamentColour: explicit ?? colours[0],
    bands: [],
    stops: [],
    isMultiColour: false,
  };
}

/** The colour a stop list starts in: the one that begins at the bed. */
function startingColourOf(stops: ColourStop[]): string | undefined {
  const base = stops.find(
    (s) =>
      (s.atZ !== undefined && s.atZ <= 0) ||
      (s.atLayer !== undefined && s.atLayer <= 1) ||
      (s.atFraction !== undefined && s.atFraction <= 0),
  );
  return base ? normalizeHex(base.colourHex) : undefined;
}

function readColours(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => normalizeHex(asString(c)))
    .filter((c): c is string => !!c);
}

function readStops(raw: unknown): ColourStop[] {
  if (!Array.isArray(raw)) return [];
  const out: ColourStop[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const colourHex = normalizeHex(asString(e.colourHex));
    if (!colourHex) continue;
    const stop: ColourStop = { colourHex };
    if (typeof e.atZ === "number") stop.atZ = e.atZ;
    else if (typeof e.atLayer === "number") stop.atLayer = e.atLayer;
    else if (typeof e.atFraction === "number") stop.atFraction = e.atFraction;
    else continue; // a stop with no position says nothing about where
    out.push(stop);
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
