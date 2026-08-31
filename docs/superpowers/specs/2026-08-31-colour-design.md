# Colour, made real

**Status:** implemented
**Date:** 2026-08-31

Colour is the feature Slicely was worst at. Asking for an Arduino Uno R3 board
"in teal/blue and black" produced a plate that opened in PrusaSlicer **white** —
not teal, not black, and not the colours the model already shipped with. This
spec fixes the cause and makes colour a first-class part of the pipeline, from
what a downloaded model already knows about itself through to what comes out of
the nozzle.

Two constraints were set by the user and hold throughout:

- **Both printer classes are first-class.** Single-extruder machines (colour via
  `M600` pause-and-swap and one-colour-per-plate grouping) and AMS/MMU machines
  (colour via real tool changes on one plate) are each verified end to end.
  Neither is a degraded mode of the other.
- **Imported colour goes all the way down to painted triangles.** A model whose
  author painted it must open painted.

## What is broken today

### 1. Slicely invents white and writes it into the project

`src/main/jobs/colour.ts` `resolveOne`, single-extruder branch:

```ts
colourHex: requested ?? usable[0]?.colourHex ?? "#ffffff",
```

With no colour requested and no filament slots known — the ordinary case, since
slot data only exists once a printer has been polled — this fabricates
`#ffffff` and labels it `reason: "user"`. `planner.ts` stamps it onto every
part, `plate.colours` becomes `["#ffffff"]`, and `runner.ts` hands it to
`synthesizeConfigForGeometry`, which writes `filament_colour = #FFFFFF` into the
config embedded in the plate's `.3mf`.

The user never asked for white. Passing nothing would have left PrusaSlicer's
own default, which is strictly better than a confident wrong answer. This alone
accounts for the reported symptom.

### 2. Colour bands never reach PrusaSlicer

`colourBands` are applied by `runner.ts` `applyColourBands`, which rewrites the
finished G-code with `M600`. But the plate's `.3mf` is written with `[]` for its
colour changes (`runner.ts` in both `sliceOnePlate` and
`sliceMultiMaterialPlate`) even though `threemf.ts` already implements
`Slic3r_PE_custom_gcode_per_print_z.xml`. So the project a user opens shows one
flat colour, the swaps are invisible in Preview, and they cannot be nudged by
hand.

### 3. Two colours on one model cannot be expressed on the normal path

`slice_model`, `slice_and_open` and `open_in_slicer` accept a single
`filamentColour` string. A request naming two colours has nowhere to put the
second; the agent must know to abandon that path entirely for `plan_job` +
`colourBands`. In practice one colour is silently dropped.

### 4. Colour that arrives with the model is discarded

`mesh.ts` `parse3mf` merges every `<object>` into one triangle soup and throws
away everything that carries colour:

- per-object extruder assignment (`Metadata/Slic3r_PE_model.config`)
- Bambu/MakerWorld's `Metadata/model_settings.config`
- per-triangle painting: PrusaSlicer's `slic3rpe:mmu_segmentation`, Bambu's
  `paint_color`
- 3MF `<basematerials>` / colour groups and `pid`/`pindex` references
- the `<build>`/`<component>` transform graph

A multi-colour Printables or MakerWorld 3MF therefore arrives as one
uncoloured blob, and its colours are unrecoverable downstream.

### 5. Height colouring is equal bands only

`bandsToChanges` divides the model height into equal fractions. "black up to
5 mm", "change at layer 40", "bottom third in black" have no expression.

## Design

### A. Never fabricate a colour

`resolveOne` returns `colourHex: undefined` when nothing was requested and no
slot matched, with a new `reason: "unset"` added to `ColourAssignment`.
`ColourAssignment.colourHex` becomes optional.

Every consumer is audited so an absent colour means *absent*, not white:

- `planner.ts` leaves `part.colourHex` undefined; `plate.colours` omits it.
- `runner.ts` passes `undefined` to `synthesizeConfigForGeometry`, which already
  emits no `filament_colour` line for that case.
- `multimaterial.ts` keeps its `#FFFFFF` padding **only** for extruder slots a
  plate genuinely does not use — a real "nothing loaded here" — and never as a
  stand-in for a part's colour.

**Test:** planning a part with no requested colour and no slots produces a
config containing no `filament_colour` key at all. This is the regression test
for the white plate.

### B. Colour changes travel with the project

`JobPlate` gains `colourChanges?: ColourChange[]`, resolved at plan time from
`job.colourBands` (and from the new explicit stops in E) against the plate's own
height rather than the job's.

`runner.ts` passes them to `writeThreeMf` on **both** plate paths, and sets the
config's `filament_colour` to the *first* band's colour so the plate opens
showing the colour it starts in. `applyColourBands` still post-processes the
G-code, because the CLI ignores `custom_gcode_per_print_z` — the two are
complementary, not alternatives, and the existing verified comment in
`colourchange.ts` stays true.

On an AMS/MMU printer PrusaSlicer turns the same entries into tool changes; the
`<mode value="SingleExtruder"/>` element in `customGcodeXml` is set from the
printer's usable slot count rather than hardcoded.

**Test:** a plate with bands yields a `.3mf` containing
`Slic3r_PE_custom_gcode_per_print_z.xml` with one `<code>` per change at the
quantised heights, and G-code containing the matching `M600`s.

### C. Colour reaches the normal tool path

`SLICE_PROPERTIES` gains, alongside the existing `filamentColour`:

- `colours: string[]` — stacked bottom-first, the simple "teal then black" case.
- `colourChanges: Array<{ atZ?: number; atLayer?: number; colourHex: string }>` —
  explicit stops for "black up to 5 mm" / "change at layer 40".

Declared on `slice_model`, `slice_and_open` **and** `open_in_slicer`, so a
request that names size, angle and two colours is one call. When more than one
colour is present for a single mesh, the slice path routes through the band
machinery instead of dropping the extra.

`agent.ts` gains a COLOUR rule: when a user names more than one colour for one
model, never collapse it to `filamentColour`; use `colours`/`colourChanges`, or
`split_parts` first when the colours describe distinct pieces rather than
heights. State which mechanism was used and what the user must do (swap a spool,
or nothing on an AMS).

### D. Import the colours the model already has

New module `src/main/jobs/threemfColour.ts`. Reading only; it does not parse
geometry, so `mesh.ts` stays the single owner of triangles.

```ts
export interface ImportedPaint {
  /** Per-triangle paint codes, indexed as the triangles were parsed. */
  codes: Map<number, string>;
  /** Which dialect the codes are in — they are re-emitted in the same one. */
  dialect: "prusa" | "bambu";
}

export interface ImportedObject {
  objectId: string;
  name?: string;
  extruder?: number;
  colourHex?: string;
  paint?: ImportedPaint;
}

export interface ImportedColours {
  objects: ImportedObject[];
  /** Distinct colours the file uses, in extruder order. */
  palette: string[];
}

export function readThreeMfColours(path: string): Promise<ImportedColours>;
```

Sources read, in precedence order: `Metadata/Slic3r_PE_model.config`, then
Bambu's `Metadata/model_settings.config`, then core-spec `<basematerials>` /
colour groups resolved through `pid`/`pindex`.

`mesh.ts` `parse3mf` is extended to keep object boundaries — it returns
triangles grouped per object with their source `objectId`, and applies the
`<build>` item transforms so an assembly lands laid out rather than stacked at
the origin. The existing merged-soup return stays the default so no current
caller changes behaviour; the grouped form is a new exported function.

`threemf.ts` `ThreeMfPart` gains `paint?: ImportedPaint`. `modelXml` emits the
paint attribute on each `<triangle>` in its original dialect, mapped through the
vertex de-duplication so a code follows its triangle. The relevant namespace
declaration is added to `<model>` when any part carries paint.

Wiring: import records the colours on the model; `plan_job` seeds each part's
`colourHex` from them when the user did not ask for something else; the agent
gets a short line reporting what the model shipped with ("this model ships 4
colours — use them, or tell me different ones").

**Tests:** fixture 3MFs in each dialect round-trip — object extruders and
palette read back correctly, and a painted mesh re-written by `writeThreeMf`
retains a paint code on the same triangles.

### E. Real heights, not just equal bands

`bandsToChanges` keeps its equal-band behaviour and is joined by
`stopsToChanges(modelHeightMm, layerHeightMm, stops)`, resolving:

- absolute mm (`atZ`)
- layer numbers (`atLayer`, resolved against the active layer height)
- fractions (`"bottom third"` arrives as a resolved mm value from the agent)

Out-of-range stops are still skipped and reported, as `insertColourChanges`
already does.

## Testing

Each module keeps its existing `node:test` style and gains cases beside the
current ones: `colour.test.ts` (A), `runner.test.ts` + a new
`threemfColour.test.ts` (B, D), `colourchange.test.ts` (E), `tools` coverage for
the new schema (C). Beyond unit tests, both printer classes are exercised
against real PrusaSlicer 2.9.5 the way `multimaterial.ts` documents its
findings: a single-extruder band print must emit `M600` at the reported heights,
and a two-slot job must emit real `T0`/`T1` tool changes with per-extruder
filament totals.

## Found during implementation

Two things this design did not anticipate, both discovered by pointing the new
reader at a real MakerWorld download already in `downloads/`.

### 6. Slicely could not read a Bambu/MakerWorld 3MF at all

`mesh.ts` read only `3D/3dmodel.model`. Bambu Studio — and therefore every
MakerWorld file — uses the 3MF **production extension**, which puts each
object's geometry in its own part file, referenced by
`<component p:path="/3D/Objects/object_1.model">`. The root document holds no
triangles, so `parseMesh` threw "no mesh triangles found" on exactly the files
multi-colour models come from. This predates the colour work and blocked all of
it.

`parse3mfObjects` now reads every `.model` document in the archive and resolves
component references across them, composing the component transform with the
build item's — Bambu puts the model's **scale** on the item, so applying one
without the other gives a part of the wrong size in the wrong place. Recursion
is depth-capped, so a cyclic file terminates rather than hangs.

### 7. Paint has to be read by whatever owns the triangles

The design put paint reading in `threemfColour.ts`. That is wrong: the codes
index a triangle list, and a second independent walk over the mesh would have
to agree with the first about ordering, component flattening and dropped
degenerate faces. In a Bambu file it agreed about nothing, because the root
document it walked has no triangles.

Reading moved into `parse3mfObjects`, which produces the indices — including
across component boundaries, where a component's codes shift by however many
triangles preceded it. `threemfColour.ts` keeps the `ImportedPaint` shape and
the palette, and no longer claims to read painting.

## Verified, and not

Every change is covered by tests in the existing `node:test` style (369 pass),
and the import path is verified against a real MakerWorld 3MF: it reads as
48 triangles at 78.7 x 46.0 x 6.4 mm, with a two-colour palette and one painted
part, where before it could not be parsed at all.

NOT verified on this machine: PrusaSlicer is not installed here, so the
end-to-end claims this design inherits from `multimaterial.ts` — that a banded
plate emits `M600` at the reported heights on a single-extruder machine, and
that a two-slot job emits real `T0`/`T1` tool changes — have not been re-run
against 2.9.5. The `<mode value="MultiAsSingle"/>` value is taken from
PrusaSlicer's own `CustomGCode::Mode` enum rather than observed output.

## Out of scope

- Painting a mesh by region *in Slicely*. `split_parts` (shells.ts) already
  turns the common case into separate colourable parts, and true interactive
  painting is a GUI job.
- Colour-accurate rendering in Slicely's own web preview beyond the flat
  per-part colour it shows now.
