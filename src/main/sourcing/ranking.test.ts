import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourcedModel } from "../../shared/sourcing";
import { rankAndDedupe, textRelevance, dedupKey } from "./ranking";

function model(overrides: Partial<SourcedModel>): SourcedModel {
  return {
    id: "1",
    source: "thingiverse",
    title: "Test Model",
    webUrl: "https://example.com/1",
    downloadable: false,
    ...overrides,
  };
}

test("textRelevance scores an exact title match highest and an unrelated title lowest", () => {
  const exact = model({ title: "Articulated Dragon" });
  const partial = model({ title: "Dragon Egg Stand" });
  const unrelated = model({ title: "Phone Case" });

  const exactScore = textRelevance("articulated dragon", exact);
  const partialScore = textRelevance("articulated dragon", partial);
  const unrelatedScore = textRelevance("articulated dragon", unrelated);

  assert.equal(exactScore, 1);
  assert.ok(partialScore > unrelatedScore);
  assert.equal(unrelatedScore, 0);
});

test("a downloadable result outranks an equally-relevant non-downloadable one", () => {
  const downloadable = model({
    id: "a",
    source: "nih3d",
    title: "Heart Model",
    downloadable: true,
  });
  const gated = model({
    id: "b",
    source: "makerworld",
    title: "Heart Model",
    creator: "someone-else",
    downloadable: false,
  });

  const ranked = rankAndDedupe("heart model", [gated, downloadable]);
  // Different creators (or none) so this isn't a dedup collapse — both
  // should survive, with the downloadable one first.
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "a");
  assert.equal(ranked[0].downloadable, true);
});

test("downloadableOnly filters out non-downloadable results after ranking", () => {
  const downloadable = model({ id: "a", downloadable: true, title: "Vase" });
  const gated = model({ id: "b", downloadable: false, title: "Vase", creator: "other" });
  const ranked = rankAndDedupe("vase", [downloadable, gated], { downloadableOnly: true });
  assert.deepEqual(
    ranked.map((m) => m.id),
    ["a"],
  );
});

test("dedupKey collapses the same title+creator regardless of case/punctuation", () => {
  const a = model({ title: "Low-Poly Fox!", creator: "Jane Doe" });
  const b = model({ title: "low poly fox", creator: "jane" });
  assert.equal(dedupKey(a), dedupKey(b));
});

test("rankAndDedupe collapses the same model cross-posted to two sources, keeping the downloadable copy", () => {
  const onThingiverse = model({
    id: "111",
    source: "thingiverse",
    title: "Low Poly Fox",
    creator: "Jane Doe",
    downloadable: true,
    signals: { downloads: 500 },
  });
  const onMakerworld = model({
    id: "222",
    source: "makerworld",
    title: "Low Poly Fox",
    creator: "Jane Doe",
    downloadable: false,
    signals: { likes: 9000 }, // huge raw number on a different scale — must not just "win" on that alone
  });

  const ranked = rankAndDedupe("low poly fox", [onMakerworld, onThingiverse]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].source, "thingiverse");
  assert.equal(ranked[0].downloadable, true);
});

test("rankAndDedupe keeps genuinely different models with similar titles separate", () => {
  const a = model({ id: "1", title: "Phone Stand", creator: "Alice" });
  const b = model({ id: "2", title: "Phone Stand", creator: "Bob" });
  const ranked = rankAndDedupe("phone stand", [a, b]);
  assert.equal(ranked.length, 2);
});

test("rankAndDedupe normalizes popularity per-source so one source's raw scale doesn't dominate", () => {
  // Thingiverse download counts here are on a "thousands" scale; NIH's are
  // on a "tens" scale. Without per-source normalization the NIH result
  // would look irrelevantly unpopular by comparison.
  const tvNoisy = model({ id: "tv1", source: "thingiverse", title: "Unrelated Gizmo", signals: { downloads: 100000 } });
  const nihMatch = model({ id: "nih1", source: "nih3d", title: "Heart Valve Model", downloadable: true, signals: { downloads: 40 } });

  const ranked = rankAndDedupe("heart valve", [tvNoisy, nihMatch]);
  // The query-relevant NIH result should rank first despite a tiny raw
  // download count, because relevance + normalized-per-source popularity +
  // the downloadable bonus dominate an irrelevant title's raw count.
  assert.equal(ranked[0].id, "nih1");
});
