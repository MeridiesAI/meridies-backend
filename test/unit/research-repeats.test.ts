import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptedCopyOf, copiesOf, markRepeats, normalizeTitle, recommendationKey, type RepeatCandidate,
} from "../../src/lib/research/repeats.js";

let n = 0;
function rec(over: Partial<RepeatCandidate> & { title: string }): RepeatCandidate {
  n += 1;
  return {
    id: over.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    feature: over.feature ?? "activities",
    title: over.title,
    details: over.details ?? null,
    status: over.status ?? "suggested",
    createdAt: over.createdAt ?? `2026-10-${String(10 + (n % 10)).padStart(2, "0")}T00:00:00.000Z`,
  };
}

test("titles fold case, accents, punctuation, width and ampersands", () => {
  assert.equal(normalizeTitle("Marine Science Program (A)"), "marine science program a");
  assert.equal(normalizeTitle("  marine   science—program a "), "marine science program a");
  assert.equal(normalizeTitle("Café Scholars"), normalizeTitle("cafe scholars"));
  assert.equal(normalizeTitle("Ｍａｒｉｎｅ Lab"), "marine lab");
  assert.equal(normalizeTitle("Arts & Sciences Camp"), normalizeTitle("Arts and Sciences Camp"));
  assert.notEqual(normalizeTitle("Program A"), normalizeTitle("Program B"));
});

test("the key includes the feature, and a college with a catalog id is that college", () => {
  const a = rec({ title: "Alpha College", feature: "college_list", details: { collegeId: "c1" } });
  const b = rec({ title: "alpha college", feature: "college_list", details: { collegeId: "c1" } });
  const c = rec({ title: "Alpha College", feature: "activities" });
  assert.equal(recommendationKey(a), recommendationKey(b));
  assert.notEqual(recommendationKey(a), recommendationKey(c));
  // An activity's details never carry a college id, and one that did would be ignored.
  const d = rec({ title: "Lab", feature: "activities", details: { collegeId: "c1" } });
  const e = rec({ title: "lab", feature: "activities" });
  assert.equal(recommendationKey(d), recommendationKey(e));
  // Without an id, a college is its title.
  assert.equal(recommendationKey(rec({ title: "Beta U", feature: "college_list" })), recommendationKey(rec({ title: "beta u", feature: "college_list" })));
});

test("older suggested copies point at the newest; the newest is unmarked", () => {
  const old = rec({ title: "Marine Science Program A", createdAt: "2026-10-01T00:00:00.000Z" });
  const mid = rec({ title: "marine science program a", createdAt: "2026-10-05T00:00:00.000Z" });
  const nu = rec({ title: "Marine Science Program A.", createdAt: "2026-10-09T00:00:00.000Z" });
  const other = rec({ title: "Community Lab Program B", createdAt: "2026-10-01T00:00:00.000Z" });
  const marks = markRepeats([nu, mid, old, other], [nu, mid, old, other], new Set());
  assert.equal(marks.get(nu.id), null);
  assert.deepEqual(marks.get(mid.id), { id: nu.id, status: "suggested" });
  assert.deepEqual(marks.get(old.id), { id: nu.id, status: "suggested" });
  assert.equal(marks.get(other.id), null);
});

test("a suggestion accepted before marks only the newest suggested copy, and only while its thing exists", () => {
  const done = rec({ title: "Lab B", status: "accepted", createdAt: "2026-10-01T00:00:00.000Z" });
  const again = rec({ title: "lab b", createdAt: "2026-10-08T00:00:00.000Z" });
  const older = rec({ title: "Lab B", createdAt: "2026-10-04T00:00:00.000Z" });
  const pool = [done, again, older];
  const live = markRepeats([again, older, done], pool, new Set([done.id]));
  assert.deepEqual(live.get(again.id), { id: done.id, status: "accepted" });
  assert.deepEqual(live.get(older.id), { id: again.id, status: "suggested" });
  assert.equal(live.get(done.id), null, "accepted rows are never marked");
  // The task was deleted: the accepted row no longer blocks a new copy.
  const gone = markRepeats([again], pool, new Set());
  assert.equal(gone.get(again.id), null);
});

test("dismissed rows neither mark nor get marked", () => {
  const dis = rec({ title: "Lab C", status: "dismissed", createdAt: "2026-10-09T00:00:00.000Z" });
  const sug = rec({ title: "Lab C", createdAt: "2026-10-01T00:00:00.000Z" });
  const marks = markRepeats([dis, sug], [sug], new Set([dis.id]));
  assert.equal(marks.get(dis.id), null);
  assert.equal(marks.get(sug.id), null);
});

test("a target's own status wins over a stale pool copy, and ties fall back to the id", () => {
  const a = rec({ id: "00000000-0000-4000-8000-0000000000aa", title: "Same", createdAt: "2026-10-01T00:00:00.000Z" });
  const b = rec({ id: "00000000-0000-4000-8000-0000000000bb", title: "same", createdAt: "2026-10-01T00:00:00.000Z" });
  const marks = markRepeats([a, b], [a, b], new Set());
  assert.equal(marks.get(b.id), null);
  assert.deepEqual(marks.get(a.id), { id: b.id, status: "suggested" });
  // The pool still says suggested, but the target was just dismissed: it no longer leads.
  const marks2 = markRepeats([{ ...b, status: "dismissed" }, a], [a, b], new Set());
  assert.equal(marks2.get(a.id), null);
});

test("features never mix", () => {
  const act = rec({ title: "Alpha", feature: "activities", createdAt: "2026-10-09T00:00:00.000Z" });
  const col = rec({ title: "Alpha", feature: "college_list", createdAt: "2026-10-01T00:00:00.000Z" });
  const marks = markRepeats([act, col], [act, col], new Set());
  assert.equal(marks.get(act.id), null);
  assert.equal(marks.get(col.id), null);
});

test("copiesOf and acceptedCopyOf find the same suggestion and skip the row itself", () => {
  const self = rec({ title: "Lab D" });
  const twin = rec({ title: "LAB D" });
  const decidedTwin = rec({ title: "Lab D", status: "dismissed" });
  const unrelated = rec({ title: "Lab E" });
  const accepted = rec({ title: "lab d", status: "accepted" });
  const rows = [self, twin, decidedTwin, unrelated, accepted];
  assert.deepEqual(copiesOf(self, rows), [twin.id]);
  assert.equal(acceptedCopyOf(self, rows, new Set([accepted.id]))?.id, accepted.id);
  assert.equal(acceptedCopyOf(self, rows, new Set()), null, "an accepted copy whose task is gone doesn't count");
  assert.equal(acceptedCopyOf(accepted, rows, new Set([accepted.id])), null, "a row is never its own copy");
});
