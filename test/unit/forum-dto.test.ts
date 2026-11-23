import assert from "node:assert/strict";
import test from "node:test";
import { authorSnapshot, FORUM_COLUMNS, forumErr, rowToPost, toDto, type ForumRow } from "../../src/lib/forums.js";

const row: ForumRow = {
  id: "p1",
  student_id: "s1",
  college_id: "c1",
  kind: "thought",
  title: "Campus visit",
  body: "Loved it.",
  url: null,
  status: "rejected",
  review_note: "Please leave out names.",
  reported_at: "2026-11-23T11:00:00.000Z",
  author_first: "Maria",
  author_year: "2027",
  created_at: "2026-11-23T10:00:00.000Z",
  updated_at: "2026-11-23T11:00:00.000Z",
  college: { id: "c1", slug: "stanford", name: "Stanford University" },
};

test("toDto hides the review note and report time unless the viewer may see them", () => {
  const hidden = toDto(row, "s2", { seesPrivate: false });
  assert.equal(hidden.reviewNote, null);
  assert.equal(hidden.reportedAt, null);
  const shown = toDto(row, "s1", { seesPrivate: true });
  assert.equal(shown.reviewNote, "Please leave out names.");
  assert.equal(shown.reportedAt, "2026-11-23T11:00:00.000Z");
});

test("toDto: mine only for the author, and no author or reviewer id is ever sent", () => {
  assert.equal(toDto(row, "s1", { seesPrivate: true }).mine, true);
  assert.equal(toDto(row, "s2", { seesPrivate: false }).mine, false);
  const leaky = { ...row, reviewed_by: "c9", reported_by: "s3" } as ForumRow;
  const dto = toDto(leaky, "s1", { seesPrivate: true });
  for (const k of ["student_id", "reviewed_by", "reported_by", "authorId", "studentId"]) assert.ok(!(k in dto), k);
  assert.ok(!JSON.stringify(dto).includes("s1"));
  assert.deepEqual(dto.college, { id: "c1", slug: "stanford", name: "Stanford University" });
  assert.equal(dto.authorFirst, "Maria");
  assert.equal(dto.authorYear, "2027");
});

test("FORUM_COLUMNS never reads who reviewed or reported a post", () => {
  assert.ok(!/reviewed_by|reported_by/.test(FORUM_COLUMNS));
  assert.ok(FORUM_COLUMNS.includes("college:colleges(id, slug, name)"));
});

test("rowToPost maps to the rules module's shape", () => {
  const p = rowToPost(row);
  assert.equal(p.authorId, "s1");
  assert.equal(p.collegeId, "c1");
  assert.equal(p.inCaseload, true);
  assert.equal(p.reportedAt, row.reported_at);
});

test("authorSnapshot keeps a first name and a four-digit year only", () => {
  assert.deepEqual(authorSnapshot({ full_name: "Maria Lopez Garcia", grad_year: "2027" }), { author_first: "Maria", author_year: "2027" });
  assert.deepEqual(authorSnapshot({ full_name: "   ", grad_year: null }), { author_first: "A student", author_year: null });
  assert.deepEqual(authorSnapshot({ full_name: null, grad_year: "soon" }), { author_first: "A student", author_year: null });
});

test("forumErr: a missing table is 503 forums_unavailable", () => {
  for (const code of ["42P01", "42703", "PGRST200", "PGRST202", "PGRST204", "PGRST205"]) {
    const e = forumErr({ code, message: "x", details: "", hint: "", name: "PostgrestError" });
    assert.equal(e.statusCode, 503, code);
    assert.equal(e.code, "forums_unavailable");
  }
  assert.equal(forumErr({ code: "PGRST116", message: "x", details: "", hint: "", name: "PostgrestError" }).statusCode, 404);
});
