import assert from "node:assert/strict";
import test from "node:test";
import { canReport, checkDraft, checkLink, editPost, newPost, reportPost, reviewPost } from "../../src/lib/forumPosts.js";

const t = "2026-11-23T10:00:00.000Z";
const t2 = "2026-11-23T11:00:00.000Z";

const pending = newPost({
  id: "p1",
  authorId: "s1",
  authorFirst: "Maria",
  authorYear: "2027",
  collegeId: "stanford",
  kind: "thought",
  title: "Campus visit",
  body: "Loved it.",
  url: null,
  now: t,
});
const approved = reviewPost(pending, "approve", "", t);

test("a video link must be on the allowlist, by host", () => {
  assert.deepEqual(checkLink("video", "https://youtube.com.evil.example/x"), { ok: false, message: "Use a YouTube, TikTok or Instagram link." });
  assert.deepEqual(checkLink("video", "youtu.be/abc"), { ok: true, url: "https://youtu.be/abc" });
});

test("http and javascript links are refused", () => {
  const msg = "Links have to start with https://.";
  assert.deepEqual(checkLink("thought", "http://example.com"), { ok: false, message: msg });
  assert.deepEqual(checkLink("thought", "javascript:alert(1)"), { ok: false, message: msg });
});

test("a draft reports the first problem with its field", () => {
  const ok = { kind: "thought" as const, collegeId: "stanford", title: "Hi", body: "Text", link: "" };
  const blankTitle = checkDraft({ ...ok, title: "  " });
  assert.equal(blankTitle.ok, false);
  assert.equal(!blankTitle.ok && blankTitle.field, "title");
  const blankBody = checkDraft({ ...ok, body: "" });
  assert.deepEqual(blankBody, { ok: false, field: "body", message: "Write your thought." });
});

test("editing a reported post keeps the report", () => {
  const reported = reportPost(approved, t);
  assert.equal(reported.status, "reported");
  const edited = editPost(reported, { title: "x" }, t2);
  assert.equal(edited.status, "pending");
  assert.equal(edited.reportedAt, t);
});

test("rejecting needs a note", () => {
  assert.throws(() => reviewPost(pending, "reject", " ", t), RangeError);
});

test("only a live post by someone else can be reported", () => {
  assert.equal(canReport(approved, "s2"), true);
  assert.equal(canReport(approved, "s1"), false);
  assert.equal(canReport(pending, "s2"), false);
});
