// Regression tests for the search bug where asking for "Acura logo emblem"
// returned "Star Wars Rebel Logo", "Batman Logo", and Terraforming Mars tiles.
//
// Two independent defects, both covered here:
//   1. Every query token was weighted equally, so a model matching only the
//      generic word "logo" scored a third of the way up and then won on raw
//      popularity.
//   2. Sources that AND their terms (Printables) returned nothing at all for
//      the padded query, so the good results were never in the pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  textRelevance,
  tokenWeights,
  essentialTokens,
  matchesEssential,
  rankAndDedupe,
} from "./ranking";
import { narrowQuery } from "./index";
import type { SourcedModel } from "../../shared/sourcing";

function model(
  title: string,
  extra: Partial<SourcedModel> = {},
): SourcedModel {
  return {
    id: title.replace(/\s+/g, "-").toLowerCase(),
    source: "thingiverse",
    title,
    webUrl: `https://example.test/${encodeURIComponent(title)}`,
    downloadable: true,
    ...extra,
  };
}

test("a model matching only a generic term is dropped from the results", () => {
  const pool = [
    model("Star Wars Rebel Logo", { signals: { downloads: 500_000 } }),
    model("Batman Logo", { signals: { downloads: 400_000 } }),
    model("ACURA Logo Emblem", { signals: { downloads: 200 } }),
  ];
  const out = rankAndDedupe("Acura logo emblem", pool);

  const titles = out.map((m) => m.title);
  assert.deepEqual(titles, ["ACURA Logo Emblem"]);
  assert.ok(
    !titles.includes("Star Wars Rebel Logo"),
    "matching only the generic word 'logo' must not qualify as a result",
  );
});

test("huge popularity cannot lift an irrelevant model above a relevant one", () => {
  const pool = [
    model("Batman Logo", { signals: { downloads: 10_000_000, likes: 90_000 } }),
    model("Acura Logo", { signals: { downloads: 12 } }),
  ];
  const out = rankAndDedupe("acura logo", pool);
  assert.equal(out[0].title, "Acura Logo");
});

test("essentialTokens keeps identifying words and drops generic descriptors", () => {
  assert.deepEqual(essentialTokens("Acura logo emblem"), ["acura"]);
  assert.deepEqual(essentialTokens("Acura car emblem badge"), ["acura", "car"]);
  // An entirely generic query has nothing to filter on — the filter must
  // disable itself rather than reject every result.
  assert.deepEqual(essentialTokens("logo"), []);
  assert.deepEqual(essentialTokens("3d printable model"), []);
});

test("a fully generic query disables the filter instead of returning nothing", () => {
  const pool = [model("Mercedes Logo"), model("F1 Logo")];
  const out = rankAndDedupe("logo", pool);
  assert.equal(out.length, 2, "nothing to be distinctive about — keep them all");
});

test("matchesEssential looks at summary and creator, not just the title", () => {
  const essential = ["acura"];
  assert.ok(matchesEssential(model("Car badge", { summary: "An Acura emblem" }), essential));
  assert.ok(matchesEssential(model("Car badge", { creator: "acura" }), essential));
  assert.ok(!matchesEssential(model("Car badge", { summary: "A Honda emblem" }), essential));
});

test("token weights make a word most candidates share count for less", () => {
  const pool = [
    model("Star Wars Rebel Logo"),
    model("Batman Logo"),
    model("Mercedes Logo"),
    model("Acura Logo"),
  ];
  const w = tokenWeights("acura logo", pool);
  assert.ok(
    (w.get("acura") ?? 0) > (w.get("logo") ?? 0),
    "'acura' (1 of 4 candidates) must outweigh 'logo' (all 4)",
  );
});

test("weighted relevance scores a generic-only match below a distinctive match", () => {
  const pool = [model("Star Wars Rebel Logo"), model("Acura Logo")];
  const w = tokenWeights("acura logo", pool);
  const generic = textRelevance("acura logo", pool[0], w);
  const real = textRelevance("acura logo", pool[1], w);
  assert.ok(real > generic, `expected ${real} > ${generic}`);
});

test("narrowQuery names the broader fallback phrasing, or nothing to broaden", () => {
  // It now reports the SUBJECT-only variant rather than a positional trim.
  // "Acura logo emblem" reduces to just "acura" once filler is dropped, so
  // there is no broader phrasing left to fall back to.
  assert.equal(narrowQuery("Acura logo emblem"), undefined);
  assert.equal(narrowQuery("Acura car emblem badge"), "acura");
  assert.equal(narrowQuery("buff pikachu with a tail"), "pikachu");
  assert.equal(narrowQuery("benchy"), undefined);
});


// ── Query strategy ──────────────────────────────────────────────────────────
// Model sites are keyword matchers. One literal query fails three ways, all
// observed on "buff pikachu with a tail": filler words shrink AND-matching
// sources to nothing, each extra word narrows the pool, and the subject alone
// finds models the full phrase misses.

import { queryVariants } from "./index";
import { essentialCoverage } from "./ranking";

test("filler words are dropped, and the subject is searched on its own too", () => {
  assert.deepEqual(queryVariants("buff pikachu with a tail"), [
    "buff pikachu tail",
    "pikachu",
  ]);
});

test("a query that is already one identifying term is searched once", () => {
  assert.deepEqual(queryVariants("acura logo"), ["acura"]);
  assert.deepEqual(queryVariants("benchy"), ["benchy"]);
});

test("an all-generic query still searches something", () => {
  assert.deepEqual(queryVariants("3d printable model"), ["3d printable model"]);
  assert.deepEqual(queryVariants("   "), []);
});

test("essentialCoverage counts how many identifying terms matched", () => {
  const essential = ["buff", "pikachu", "tail"];
  const of = (title: string): number =>
    essentialCoverage(
      { id: "1", source: "thingiverse", title, webUrl: "x", downloadable: true },
      essential,
    );
  assert.equal(of("Low Poly Pikachu with strong tail"), 2 / 3);
  assert.equal(of("Buff Pikachu with a tail"), 1);
  assert.equal(of("Low-Poly Pikachu"), 1 / 3);
  assert.equal(of("Traffic Cone"), 0);
});

test("matching more of the request outranks matching one term strongly", () => {
  const pool = [
    // Hugely popular, but only matches the subject.
    model("Pikachu", { signals: { downloads: 900_000, likes: 40_000 } }),
    // Less popular, but matches two of the three things asked for.
    model("Pikachu with a big tail", { signals: { downloads: 40 } }),
  ];
  const out = rankAndDedupe("pikachu with a big tail", pool);
  assert.equal(
    out[0].title,
    "Pikachu with a big tail",
    "the extra words are why the user typed them; popularity must not erase them",
  );
});
