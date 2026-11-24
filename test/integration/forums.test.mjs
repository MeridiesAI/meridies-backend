// Student Forums API (routes/forums.ts, migration 20261201000001): a student posts about a college, the post waits
// for their own counselor, the feed shows approved posts only and never an author id; the author edits or deletes their
// own; another student reports a live post. Every write is the service role after the route's own check.
import { call, check, sql, user as rawUser } from "./harness.mjs";

// The host is loaded: an auth call can 504. Retry only that.
async function user(...args) {
  for (let i = 0; ; i++) {
    try {
      return await rawUser(...args);
    } catch (e) {
      if (i >= 8 || !/50[234]|unexpected error|request_timeout|fetch failed|ECONNRESET/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}
/** studentOf (imports-helpers.mjs) with a full name and class year, for the byline snapshot. */
async function studentWith(counselor, tag) {
  const s = await user(tag, "student");
  await sql(`update public.profiles set counselor_id = '${counselor.id}', full_name = 'Maria Lopez Garcia', grad_year = '2027' where id = '${s.id}'`);
  return s;
}

const [c1, c2] = (await sql("select id from public.colleges order by slug limit 2")).split("\n");
const counselor = await user("forum-counselor");
const author = await studentWith(counselor, "forum-author");
const reader = await studentWith(counselor, "forum-reader");
const loner = await user("forum-loner", "student");
const pendingCounselor = await user("forum-pending", "counselor", { approved: false });
const orphan = await studentWith(pendingCounselor, "forum-orphan");

const thought = { kind: "thought", collegeId: c1, title: "Campus visit", body: "The library is open all night." };

// ---- Create ----
const created = await call(author.token, "POST", "/me/forums", thought);
check("a student with a counselor posts a thought: 201 pending, mine", created.status === 201 && created.body.status === "pending" && created.body.mine === true, JSON.stringify(created.body));
const post = created.body;
check("the DTO carries the college and the first name only", post.college?.id === c1 && post.authorFirst === "Maria" && post.authorYear === "2027", JSON.stringify(post));
check("the DTO has no author or reviewer id", !("student_id" in post) && !("reviewed_by" in post) && !("reported_by" in post) && !JSON.stringify(post).includes(author.id), JSON.stringify(post));

const ownFeed = await call(author.token, "GET", "/me/forums");
check("the author's feed doesn't list a pending post", ownFeed.status === 200 && !ownFeed.body.posts.some((p) => p.id === post.id), JSON.stringify(ownFeed.body).slice(0, 300));
const mine = await call(author.token, "GET", "/me/forums?view=mine");
check("?view=mine lists it", mine.status === 200 && mine.body.posts.some((p) => p.id === post.id), `${mine.status}`);

const noCounselor = await call(loner.token, "POST", "/me/forums", thought);
check("no counselor: 409 forums_no_counselor", noCounselor.status === 409 && noCounselor.body.code === "forums_no_counselor", JSON.stringify(noCounselor.body));
const unapproved = await call(orphan.token, "POST", "/me/forums", thought);
check("an unapproved counselor: 409 forums_counselor_unavailable", unapproved.status === 409 && unapproved.body.code === "forums_counselor_unavailable", JSON.stringify(unapproved.body));

// ---- Validation ----
const lookalike = await call(author.token, "POST", "/me/forums", { kind: "video", collegeId: c1, title: "Tour", link: "https://youtube.com.evil.example/x" });
check("a video on a lookalike host: 400 forum_link, the allowlist message", lookalike.status === 400 && lookalike.body.code === "forum_link" && lookalike.body.error === "Use a YouTube, TikTok or Instagram link.", JSON.stringify(lookalike.body));
const longLink = "https://a.example/" + "é".repeat(1977);
const tooLong = await call(author.token, "POST", "/me/forums", { ...thought, link: longLink });
check(`a ${longLink.length}-character link that normalizes past 2,000: 400 forum_link too long`, longLink.length < 2000 && tooLong.status === 400 && tooLong.body.code === "forum_link" && tooLong.body.error === "That link is too long.", JSON.stringify(tooLong.body));
const blank = await call(author.token, "POST", "/me/forums", { ...thought, title: "   " });
check("a blank title: 400 forum_title", blank.status === 400 && blank.body.code === "forum_title", JSON.stringify(blank.body));
const noCollege = await call(author.token, "POST", "/me/forums", { ...thought, collegeId: "00000000-0000-4000-8000-000000000000" });
check("an unknown college: 400 forum_college", noCollege.status === 400 && noCollege.body.code === "forum_college", JSON.stringify(noCollege.body));
const extraKey = await call(author.token, "PATCH", `/me/forums/${post.id}`, { title: "New", studentId: reader.id });
check("an unknown key in PATCH: 400", extraKey.status === 400, JSON.stringify(extraKey.body));
const extraCreate = await call(author.token, "POST", "/me/forums", { ...thought, status: "approved" });
check("an unknown key in POST: 400", extraCreate.status === 400, JSON.stringify(extraCreate.body));

// ---- Edit and delete ----
await sql(`update public.forum_posts set status = 'rejected', review_note = 'Leave out names.' where id = '${post.id}'`);
const edited = await call(author.token, "PATCH", `/me/forums/${post.id}`, { title: "Campus visit, again" });
check("PATCH own post: back to pending, note cleared", edited.status === 200 && edited.body.status === "pending" && edited.body.reviewNote === null && edited.body.title === "Campus visit, again", JSON.stringify(edited.body));
const badEdit = await call(author.token, "PATCH", `/me/forums/${post.id}`, { kind: "video" });
check("PATCH is checked as a whole draft (a video with no link): 400 forum_link", badEdit.status === 400 && badEdit.body.code === "forum_link", JSON.stringify(badEdit.body));
const otherEdit = await call(reader.token, "PATCH", `/me/forums/${post.id}`, { title: "Mine now" });
check("PATCH another student's post: 404", otherEdit.status === 404, `${otherEdit.status}`);
const otherDelete = await call(reader.token, "DELETE", `/me/forums/${post.id}`);
check("DELETE another student's post: 404", otherDelete.status === 404, `${otherDelete.status}`);
const pendingReport = await call(reader.token, "POST", `/me/forums/${post.id}/report`);
check("reporting a non-approved post: 404", pendingReport.status === 404, `${pendingReport.status}`);
const stillThere = await sql(`select title || '|' || status from public.forum_posts where id = '${post.id}'`);
check("none of that changed the row", stillThere === "Campus visit, again|pending", stillThere);

const doomed = await call(author.token, "POST", "/me/forums", { kind: "food", collegeId: c2, title: "Taco truck", link: "tacos.example/menu" });
check("a food spot with a bare host gets https", doomed.status === 201 && doomed.body.url === "https://tacos.example/menu", JSON.stringify(doomed.body));
const del = await call(author.token, "DELETE", `/me/forums/${doomed.body.id}`);
check("DELETE own post: 204", del.status === 204, `${del.status}`);
const delAgain = await call(author.token, "DELETE", `/me/forums/${doomed.body.id}`);
check("then 404", delAgain.status === 404, `${delAgain.status}`);

// ---- Approved: the feed and reports ----
await sql(`update public.forum_posts set status = 'approved', review_note = 'internal' where id = '${post.id}'`);
const feed = await call(reader.token, "GET", `/me/forums?collegeId=${c1}&kind=thought`);
const seen = feed.body.posts?.find((p) => p.id === post.id);
check("another student's feed lists it: mine false, no note", feed.status === 200 && seen?.mine === false && seen.reviewNote === null && seen.reportedAt === null, JSON.stringify(seen));
check("the feed never carries an author id", !JSON.stringify(feed.body).includes(author.id), "");
check("the feed lists approved posts only", feed.body.posts.every((p) => p.status === "approved"), "");
const otherCollege = await call(reader.token, "GET", `/me/forums?collegeId=${c2}`);
check("the college filter narrows the feed", otherCollege.status === 200 && !otherCollege.body.posts.some((p) => p.id === post.id), "");

const selfReport = await call(author.token, "POST", `/me/forums/${post.id}/report`);
check("the author reporting their own post: 409", selfReport.status === 409, JSON.stringify(selfReport.body));
const report = await call(reader.token, "POST", `/me/forums/${post.id}/report`);
check("a second student reports it", report.status === 200 && report.body.reported === true, JSON.stringify(report.body));
const reportedRow = await sql(`select status || '|' || (reported_by = '${reader.id}') || '|' || (reported_at is not null) from public.forum_posts where id = '${post.id}'`);
check("stored as reported, by whom and when", reportedRow === "reported|true|true", reportedRow);
const afterReport = await call(reader.token, "GET", "/me/forums");
check("it leaves the feed", !afterReport.body.posts.some((p) => p.id === post.id), "");
const authorFeed = await call(author.token, "GET", "/me/forums");
check("it leaves the author's feed too", !authorFeed.body.posts.some((p) => p.id === post.id), "");
const reportAgain = await call(reader.token, "POST", `/me/forums/${post.id}/report`);
check("a reported post can't be reported again: 404", reportAgain.status === 404, `${reportAgain.status}`);

const editReported = await call(author.token, "PATCH", `/me/forums/${post.id}`, { body: "Edited after a report." });
const kept = await sql(`select status || '|' || (reported_at is not null) || '|' || (reported_by = '${reader.id}') from public.forum_posts where id = '${post.id}'`);
check("editing a reported post keeps the report (reported_at and reported_by)", editReported.status === 200 && kept === "pending|true|true", `${editReported.status} ${kept}`);
check("the author sees the report time on their own post", editReported.body.reportedAt !== null && !("reported_by" in editReported.body), JSON.stringify(editReported.body));

// ---- Rate limit ----
const busy = await studentWith(counselor, "forum-busy");
const codes = [];
for (let i = 0; i < 11; i++) codes.push((await call(busy.token, "POST", "/me/forums", { ...thought, title: `Post ${i}` })).status);
check("the 11th create in an hour: 429", codes.slice(0, 10).every((s) => s === 201) && codes[10] === 429, codes.join(","));

// ---- Clean up ----
await sql(`delete from public.forum_posts where student_id in ('${author.id}', '${busy.id}')`);

// ---- Counselor review and notices (Task 4) ----
// Only the author's assigned, approved counselor reviews; a collaborator, another counselor or the author never does.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HREF = "/dashboard/counselor/forums";
/** The forum notices a counselor has, after the fire-and-forget insert has had time to land. */
async function forumNotices(who) {
  await wait(1500);
  const r = await call(who.token, "GET", "/notifications?kind=system");
  return r.status === 200 ? r.body.filter((n) => n.href === HREF) : [`status ${r.status}`];
}
const cA = await user("forum-review-a");
const cB = await user("forum-review-b");
const collab = await user("forum-collab");
const a1 = await studentWith(cA, "forum-a1");
const a2 = await studentWith(cA, "forum-a2");
const b1 = await studentWith(cB, "forum-b1");
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${a1.id}', '${collab.id}', 'read')`);

const p1 = (await call(a1.token, "POST", "/me/forums", { ...thought, title: "First" })).body;
let aNotes = await forumNotices(cA);
check("a post gives the assigned counselor one low system notice linking the review page", aNotes.length === 1 && aNotes[0].kind === "system" && aNotes[0].urgency === "low" && aNotes[0].title === "Maria sent a Forums post for review" && aNotes[0].body === null, JSON.stringify(aNotes));
const p2 = (await call(a1.token, "POST", "/me/forums", { ...thought, title: "Second" })).body;
aNotes = await forumNotices(cA);
check("a second post within the hour adds no notice", aNotes.length === 1, JSON.stringify(aNotes));
check("the other counselor has none", (await forumNotices(cB)).length === 0, "");
await call(a1.token, "DELETE", `/me/forums/${p2.id}`);
await wait(20);
const p3 = (await call(a2.token, "POST", "/me/forums", { ...thought, title: "Third" })).body;
check("another student's post is noticed on its own", (await forumNotices(cA)).length === 2, "");
const pb = (await call(b1.token, "POST", "/me/forums", { ...thought, title: "B's" })).body;

// ---- The review list ----
const listA = await call(cA.token, "GET", "/forums/review");
check("counselor A's review tab: A1's and A2's pending posts, oldest first", listA.status === 200 && listA.body.posts.map((p) => p.id).join() === [p1.id, p3.id].join(), JSON.stringify(listA.body).slice(0, 300));
check("counts: review 2, approved 0", listA.body.counts?.review === 2 && listA.body.counts?.approved === 0, JSON.stringify(listA.body.counts));
check("the review list carries no author id", !JSON.stringify(listA.body).includes(a1.id) && !JSON.stringify(listA.body).includes(a2.id), "");
const listB = await call(cB.token, "GET", "/forums/review");
check("counselor B sees only B1's post", listB.status === 200 && listB.body.posts.map((p) => p.id).join() === pb.id && listB.body.counts.review === 1, JSON.stringify(listB.body).slice(0, 300));
const listCollab = await call(collab.token, "GET", "/forums/review");
check("a read-only collaborator's review list is empty", listCollab.status === 200 && listCollab.body.posts.length === 0, JSON.stringify(listCollab.body).slice(0, 200));
const listStudent = await call(a1.token, "GET", "/forums/review");
check("a student calling the review list: 403", listStudent.status === 403, `${listStudent.status}`);
const listOne = await call(cA.token, "GET", "/forums/review?limit=1");
check("?limit=1 gives one post", listOne.status === 200 && listOne.body.posts.length === 1 && listOne.body.counts.review === 2, `${listOne.status}`);
const listBig = await call(cA.token, "GET", "/forums/review?limit=201");
check("?limit=201: 400", listBig.status === 400, `${listBig.status}`);

// ---- Who may review ----
const approve = (p, extra = {}) => ({ decision: "approve", updatedAt: p.updatedAt, ...extra });
const byB = await call(cB.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("counselor B reviewing A1's post: 404", byB.status === 404, JSON.stringify(byB.body));
const byCollab = await call(collab.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("a read-only collaborator reviewing it: 404", byCollab.status === 404, JSON.stringify(byCollab.body));
const byAuthor = await call(a1.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("the author's own token: 403", byAuthor.status === 403, JSON.stringify(byAuthor.body));
const byStudent = await call(b1.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("another student's token: 403", byStudent.status === 403, JSON.stringify(byStudent.body));
const byPending = await call(pendingCounselor.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("an unapproved counselor: 403 account_pending", byPending.status === 403 && byPending.body.code === "account_pending", JSON.stringify(byPending.body));
const extraReview = await call(cA.token, "POST", `/forums/${p1.id}/review`, approve(p1, { status: "approved" }));
check("an unknown key in review: 400", extraReview.status === 400, JSON.stringify(extraReview.body));
const noStamp = await call(cA.token, "POST", `/forums/${p1.id}/review`, { decision: "approve" });
check("a review without updatedAt: 400", noStamp.status === 400, JSON.stringify(noStamp.body));
const row1 = () => sql(`select status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(review_note, '-') from public.forum_posts where id = '${p1.id}'`);
check("none of that changed the post", (await row1()) === "pending|-|-", await row1());

// ---- Stale updatedAt, then approve ----
await call(a1.token, "PATCH", `/me/forums/${p1.id}`, { body: "Edited before the counselor clicked." });
const stale = await call(cA.token, "POST", `/forums/${p1.id}/review`, approve(p1));
check("approving with a stale updatedAt: 409 forum_post_changed", stale.status === 409 && stale.body.code === "forum_post_changed" && stale.body.error === "This post changed. Reload to see the latest.", JSON.stringify(stale.body));
check("and the post is unchanged", (await row1()) === "pending|-|-", await row1());
const fresh = (await call(cA.token, "GET", "/forums/review")).body.posts.find((p) => p.id === p1.id);
const ok1 = await call(cA.token, "POST", `/forums/${p1.id}/review`, approve(fresh));
check("approving with the current updatedAt: approved, no note, no report", ok1.status === 200 && ok1.body.status === "approved" && ok1.body.reviewNote === null && ok1.body.reportedAt === null && ok1.body.id === p1.id, JSON.stringify(ok1.body));
const stamped = await sql(`select (reviewed_by = '${cA.id}') || '|' || (reviewed_at is not null) from public.forum_posts where id = '${p1.id}'`);
check("stored with the reviewer and the time", stamped === "true|true", stamped);
check("it is in another student's feed", (await call(b1.token, "GET", "/me/forums")).body.posts.some((p) => p.id === p1.id), "");

const race = await Promise.all([1, 2].map(() => call(cA.token, "POST", `/forums/${p3.id}/review`, approve(p3))));
check("two approvals with the same updatedAt: one wins, the other 409", race.map((r) => r.status).sort().join() === "200,409", race.map((r) => `${r.status} ${r.body.code ?? ""}`).join(" / "));

const approvedTab = await call(cA.token, "GET", "/forums/review?tab=approved");
check("?tab=approved: approved only, newest first", approvedTab.status === 200 && approvedTab.body.posts.map((p) => p.id).join() === [p3.id, p1.id].join() && approvedTab.body.counts.approved === 2 && approvedTab.body.counts.review === 0, JSON.stringify(approvedTab.body).slice(0, 300));

// ---- Reject and Remove ----
const p4 = (await call(a2.token, "POST", "/me/forums", { ...thought, title: "Fourth" })).body;
const blankNote = await call(cA.token, "POST", `/forums/${p4.id}/review`, { decision: "reject", note: "   ", updatedAt: p4.updatedAt });
check("reject with a blank note: 400 A rejection needs a note.", blankNote.status === 400 && blankNote.body.error === "A rejection needs a note.", JSON.stringify(blankNote.body));
const noNote = await call(cA.token, "POST", `/forums/${p4.id}/review`, { decision: "reject", updatedAt: p4.updatedAt });
check("reject with no note: 400", noNote.status === 400 && noNote.body.error === "A rejection needs a note.", JSON.stringify(noNote.body));
const longNote = await call(cA.token, "POST", `/forums/${p4.id}/review`, { decision: "reject", note: "x".repeat(501), updatedAt: p4.updatedAt });
check("a 501-character note: 400", longNote.status === 400, `${longNote.status}`);
const rejected = await call(cA.token, "POST", `/forums/${p4.id}/review`, { decision: "reject", note: " Leave out names. ", updatedAt: p4.updatedAt });
check("reject with a note: rejected, the note trimmed", rejected.status === 200 && rejected.body.status === "rejected" && rejected.body.reviewNote === "Leave out names.", JSON.stringify(rejected.body));
const a2Mine = (await call(a2.token, "GET", "/me/forums?view=mine")).body.posts.find((p) => p.id === p4.id);
check("the author's mine view shows the note", a2Mine?.status === "rejected" && a2Mine.reviewNote === "Leave out names.", JSON.stringify(a2Mine));
const again = await call(cA.token, "POST", `/forums/${p4.id}/review`, { decision: "reject", note: "Again", updatedAt: rejected.body.updatedAt });
check("reviewing an already rejected post: 409", again.status === 409, JSON.stringify(again.body));
const approveRejected = await call(cA.token, "POST", `/forums/${p4.id}/review`, approve(rejected.body));
check("approving a rejected post: 409 (the author edits first)", approveRejected.status === 409, JSON.stringify(approveRejected.body));

const p3now = approvedTab.body.posts.find((p) => p.id === p3.id);
const removed = await call(cA.token, "POST", `/forums/${p3.id}/review`, { decision: "reject", note: "Taken down.", updatedAt: p3now.updatedAt });
check("Remove (reject an approved post): rejected", removed.status === 200 && removed.body.status === "rejected", JSON.stringify(removed.body));
const feeds = await Promise.all([a1, a2, b1, reader].map((s) => call(s.token, "GET", "/me/forums")));
check("a removed post is in no student's feed", feeds.every((f) => f.status === 200 && !f.body.posts.some((p) => p.id === p3.id)), feeds.map((f) => f.status).join());

// ---- Reports ----
const bBefore = (await forumNotices(cB)).length;
const rep = await call(b1.token, "POST", `/me/forums/${p1.id}/report`);
check("B1 reports A1's live post", rep.status === 200, JSON.stringify(rep.body));
const reportNotes = (await forumNotices(cA)).filter((n) => n.title === "A post by Maria was reported");
check("the report gives the AUTHOR's counselor one normal notice", reportNotes.length === 1 && reportNotes[0].urgency === "normal" && reportNotes[0].kind === "system", JSON.stringify(reportNotes));
check("the reporter's counselor gets none", (await forumNotices(cB)).length === bBefore, "");
const inReview = (await call(cA.token, "GET", "/forums/review")).body.posts.find((p) => p.id === p1.id);
check("a reported post is back in counselor A's review tab with reportedAt", inReview?.status === "reported" && inReview.reportedAt !== null, JSON.stringify(inReview));
const cleared = await call(cA.token, "POST", `/forums/${p1.id}/review`, approve(inReview));
check("approving a reported post clears reportedAt", cleared.status === 200 && cleared.body.status === "approved" && cleared.body.reportedAt === null, JSON.stringify(cleared.body));
check("and puts it back in the feed", (await call(b1.token, "GET", "/me/forums")).body.posts.some((p) => p.id === p1.id), "");
const reportedAtSql = await sql(`select coalesce(reported_at::text, '-') from public.forum_posts where id = '${p1.id}'`);
check("reported_at is null in the table", reportedAtSql === "-", reportedAtSql);

await call(b1.token, "POST", `/me/forums/${p1.id}/report`);
const reportNotes2 = (await forumNotices(cA)).filter((n) => n.title === "A post by Maria was reported");
check("a second report of the same post within a day adds no notice", reportNotes2.length === 1, JSON.stringify(reportNotes2.length));
const editAfter = await call(a1.token, "PATCH", `/me/forums/${p1.id}`, { body: "Edited after the second report." });
check("an author edit of a reported post keeps reportedAt", editAfter.status === 200 && editAfter.body.status === "pending" && editAfter.body.reportedAt !== null, JSON.stringify(editAfter.body));
const stillInReview = (await call(cA.token, "GET", "/forums/review")).body.posts.find((p) => p.id === p1.id);
check("and it stays in the review tab with reportedAt", stillInReview?.status === "pending" && stillInReview.reportedAt !== null, JSON.stringify(stillInReview));

// An approved post whose author's counselor is not approved (seeded: such a student can't post): a report notifies nobody.
const pendingPost = await sql(`insert into public.forum_posts (student_id, college_id, kind, title, body, status, author_first) values ('${orphan.id}', '${c1}', 'thought', 'Seeded', 'Seeded body', 'approved', 'Maria') returning id`).then((out) => out.split("\n")[0]);
const repPending = await call(b1.token, "POST", `/me/forums/${pendingPost}/report`);
await wait(1500);
const pendingNotes = await sql(`select count(*) from public.notifications where recipient_id = '${pendingCounselor.id}' and href = '${HREF}'`);
check("an unapproved counselor gets no notice for a report", repPending.status === 200 && pendingNotes === "0", `${repPending.status} ${pendingNotes}`);
const pendingReview = await call(pendingCounselor.token, "POST", `/forums/${pendingPost}/review`, { decision: "approve", updatedAt: new Date().toISOString() });
check("and can't review their own student's post: 403", pendingReview.status === 403, `${pendingReview.status}`);

await sql(`delete from public.forum_posts where student_id in ('${a1.id}', '${a2.id}', '${b1.id}', '${orphan.id}')`);
