import assert from "node:assert/strict";
import { test } from "node:test";
import type { RetrievedChunk } from "../../src/lib/axis/ports.js";
import { dropNearDuplicates, maximalMarginalRelevance, reciprocalRankFusion, retrievalQueries } from "../../src/lib/axis/retrieval.js";
import { understand } from "../../src/lib/axis/nlu.js";
import { CollegeIndex, RosterIndex } from "../../src/lib/axis/entities.js";

const chunk = (id: string, text: string): RetrievedChunk => ({ chunkId: id, documentId: `d-${id}`, studentId: "s1", title: id, text, score: 1, source: "upload" });

test("reciprocal rank fusion rewards agreement between queries", () => {
  const a = chunk("a", "AP Biology grade A minus junior year");
  const b = chunk("b", "Orchestra first violin");
  const c = chunk("c", "AP Chemistry B plus");
  const fused = reciprocalRankFusion([[b, a, c], [a, c], [a]]);
  assert.equal(fused[0]!.chunk.chunkId, "a");
  assert.ok(fused[0]!.score > fused[1]!.score);
});

test("near-duplicate passages keep only the better-ranked copy", () => {
  const text = "Junior year transcript: AP Biology A, AP Chemistry B plus, Honors English A minus, Precalculus A";
  const kept = dropNearDuplicates(reciprocalRankFusion([[chunk("x", text), chunk("y", `${text}.`), chunk("z", "Senior schedule: AP Physics C")]]));
  assert.deepEqual(kept.map((k) => k.chunk.chunkId), ["x", "z"]);
});

test("maximal marginal relevance prefers a different passage over a second near-copy of the first", () => {
  const scored = [
    { chunk: chunk("1", "AP Biology A junior year transcript"), score: 1 },
    { chunk: chunk("2", "AP Biology A junior year transcript grade"), score: 0.95 },
    { chunk: chunk("3", "Recommendation from the biology teacher praises lab work"), score: 0.9 },
  ];
  const picked = maximalMarginalRelevance(scored, 2, 10_000);
  assert.deepEqual(picked.map((p) => p.chunkId), ["1", "3"]);
});

test("maximal marginal relevance stops at the character budget", () => {
  const long = (id: string) => ({ chunk: chunk(id, `${id} `.repeat(800)), score: 1 });
  assert.equal(maximalMarginalRelevance([long("a"), long("b"), long("c")], 3, 3_000).length, 1);
});

test("queries: the question as asked, its keywords with shorthand expanded, and the named schools", () => {
  const roster = new RosterIndex([{ id: "s1", name: "Sophia Martinez" }]);
  const colleges = new CollegeIndex([{ id: "c1", name: "Cornell University", search_name: "cornell university", search_aka_list: [], catalog_source: "meridies" }]);
  const u = understand("Can you find Sophia's ED essay notes for Cornell?", { chatStudentId: null, roster, colleges, state: null });
  const qs = retrievalQueries(u, ["Sophia Martinez"]);
  assert.equal(qs.length, 3);
  assert.ok(!qs.some((q) => /sophia/i.test(q)), "the student's name is noise inside her own folder");
  assert.match(qs[1]!, /early decision/);
  assert.match(qs[2]!, /^Cornell University/);
});
