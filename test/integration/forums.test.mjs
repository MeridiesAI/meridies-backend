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
