/**
 * Student Forums, the student half (migration 20261201000001; lib/forums.ts, lib/forumPosts.ts):
 *   GET    /me/forums              ?view=feed|mine&collegeId&kind&limit -> { posts }
 *   POST   /me/forums              { kind, collegeId, title, body?, link? } -> 201 post (pending)
 *   PATCH  /me/forums/:id          partial of the same; the author's own post goes back to pending
 *   DELETE /me/forums/:id          the author's own post -> 204
 *   POST   /me/forums/:id/report   another student's approved post -> { reported: true }
 *   GET    /forums/review          counselor: ?tab=review|approved&limit -> { posts, counts: { review, approved } }
 *   POST   /forums/:id/review      the author's assigned counselor: { decision, note?, updatedAt } -> post
 * Clients write nothing to forum_posts: every write is the service role after the caller's own RLS read (or, for a
 * create, their own profile) showed they may make it. A post the caller can't see is 404, never 403.
 * A counselor sees (RLS `forum_is_assigned_counselor`) only the posts of students whose `profiles.counselor_id` they are,
 * never a collaborator's student, so their own RLS read of a post is the review's authorization check.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isCounselorApproved } from "../lib/access.js";
import { HttpError, notFound } from "../lib/errors.js";
import { canReport, checkDraft, editPost, FORUM_KINDS, reviewPost, LINK_MAX, type DraftResult, type ForumKind } from "../lib/forumPosts.js";
import { authorSnapshot, draftError, FORUM_COLUMNS, forumErr, forumsUnavailable, rowToPost, toDto, type ForumRow } from "../lib/forums.js";
import { noticeForumPost } from "../lib/forumNotice.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";

const kind = z.enum(FORUM_KINDS as [ForumKind, ...ForumKind[]]);
const fields = {
  kind,
  collegeId: z.string().uuid(),
  title: z.string().max(200),
  body: z.string().max(2000),
  link: z.string().max(4000),
};
const createBody = z.object({ ...fields, body: fields.body.default(""), link: fields.link.default("") }).strict();
const patchBody = z.object(fields).partial().strict();
const listQuery = z
  .object({
    view: z.enum(["feed", "mine"]).default("feed"),
    collegeId: z.string().uuid().optional(),
    kind: kind.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
const idParam = z.object({ id: z.string().uuid() }).strict();
const reviewQuery = z
  .object({ tab: z.enum(["review", "approved"]).default("review"), limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();
const reviewBody = z
  .object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional(), updatedAt: z.string().datetime({ offset: true }) })
  .strict();
const IN_REVIEW = ["pending", "reported"];

function svcOrUnavailable() {
  const svc = serviceClient();
  if (!svc) throw forumsUnavailable();
  return svc;
}

/** Nobody could approve a post from a student with no counselor, or one whose counselor isn't approved. */
async function assertCanPost(request: FastifyRequest) {
  const counselorId = request.profile.counselor_id;
  if (!counselorId) throw new HttpError(409, "Connect with a counselor to post.", "forums_no_counselor");
  if (!(await isCounselorApproved(svcOrUnavailable(), counselorId))) {
    throw new HttpError(409, "Your counselor can't review posts yet.", "forums_counselor_unavailable");
  }
}

/** The rules module checks the raw link; its https form can be longer (percent-encoding), and the table holds 2,000. */
function checked(r: DraftResult) {
  if (!r.ok) throw draftError(r);
  if (r.url && r.url.length > LINK_MAX) throw draftError({ ok: false, field: "link", message: "That link is too long." });
  return r;
}

async function assertCollege(request: FastifyRequest, collegeId: string) {
  const { data, error } = await request.db.from("colleges").select("id").eq("id", collegeId).maybeSingle();
  if (error) throw forumErr(error);
  if (!data) throw draftError({ ok: false, field: "college", message: "Pick a college." });
}

async function ownPost(request: FastifyRequest, id: string): Promise<ForumRow> {
  const { data, error } = await request.db.from("forum_posts").select(FORUM_COLUMNS).eq("id", id).eq("student_id", request.auth.userId).maybeSingle();
  if (error) throw forumErr(error);
  if (!data) throw notFound("No post of yours matches that");
  return data as unknown as ForumRow;
}

export default async function forumRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  app.get("/me/forums", { preHandler: [...student, limit("me:forums:read", 120, 60)] }, async (request) => {
    const q = listQuery.parse(request.query);
    const me = request.auth.userId;
    let query = request.db.from("forum_posts").select(FORUM_COLUMNS);
    query = q.view === "mine" ? query.eq("student_id", me) : query.eq("status", "approved");
    if (q.collegeId) query = query.eq("college_id", q.collegeId);
    if (q.kind) query = query.eq("kind", q.kind);
    // shortcut: newest 200 at most, add a keyset cursor when a college passes that
    const { data, error } = await query.order("created_at", { ascending: false }).limit(q.limit);
    if (error) throw forumErr(error);
    const rows = (data ?? []) as unknown as ForumRow[];
    return { posts: rows.map((r) => toDto(r, me, { seesPrivate: r.student_id === me })) };
  });

  app.post(
    "/me/forums",
    { preHandler: [...student, limit("me:forums:create:hour", 10, 3600), limit("me:forums:create:day", 30, 86400)] },
    async (request, reply) => {
      const b = createBody.parse(request.body);
      await assertCanPost(request);
      const draft = checked(checkDraft(b));
      await assertCollege(request, b.collegeId);
      const me = request.auth.userId;
      const svc = svcOrUnavailable();
      const ins = await svc
        .from("forum_posts")
        .insert({
          student_id: me,
          college_id: b.collegeId,
          kind: b.kind,
          title: draft.title,
          body: draft.body,
          url: draft.url,
          status: "pending",
          ...authorSnapshot(request.profile),
        })
        .select(FORUM_COLUMNS)
        .single();
      if (ins.error) throw forumErr(ins.error);
      const row = ins.data as unknown as ForumRow;
      void noticeForumPost(request, row, request.profile.counselor_id, "sent").catch(() => {});
      return reply.code(201).send(toDto(ins.data as unknown as ForumRow, me, { seesPrivate: true }));
    }
  );

  app.patch("/me/forums/:id", { preHandler: [...student, limit("me:forums:edit", 60, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const p = patchBody.parse(request.body);
    const row = await ownPost(request, id);
    await assertCanPost(request);
    const merged = {
      kind: p.kind ?? row.kind,
      collegeId: p.collegeId ?? row.college_id,
      title: p.title ?? row.title,
      body: p.body ?? row.body,
      link: p.link ?? row.url ?? "",
    };
    const draft = checked(checkDraft(merged));
    if (merged.collegeId !== row.college_id) await assertCollege(request, merged.collegeId);
    const next = editPost(rowToPost(row), { kind: merged.kind, collegeId: merged.collegeId, title: draft.title, body: draft.body, url: draft.url }, new Date().toISOString());
    // reported_at / reported_by are left as they are: editing keeps a report for the counselor to answer.
    const up = await svcOrUnavailable()
      .from("forum_posts")
      .update({
        kind: next.kind,
        college_id: next.collegeId,
        title: next.title,
        body: next.body,
        url: next.url,
        status: next.status,
        review_note: next.reviewNote,
        ...authorSnapshot(request.profile),
      })
      .eq("id", id)
      .eq("student_id", request.auth.userId)
      .select(FORUM_COLUMNS)
      .maybeSingle();
    if (up.error) throw forumErr(up.error);
    if (!up.data) throw notFound("No post of yours matches that");
    void noticeForumPost(request, up.data as unknown as ForumRow, request.profile.counselor_id, "sent").catch(() => {});
    return toDto(up.data as unknown as ForumRow, request.auth.userId, { seesPrivate: true });
  });

  app.delete("/me/forums/:id", { preHandler: [...student, limit("me:forums:delete", 60, 3600)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await ownPost(request, id);
    const del = await svcOrUnavailable().from("forum_posts").delete().eq("id", id).eq("student_id", request.auth.userId);
    if (del.error) throw forumErr(del.error);
    return reply.code(204).send();
  });

  app.post("/me/forums/:id/report", { preHandler: [...student, limit("me:forums:report", 30, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const me = request.auth.userId;
    const { data, error } = await request.db.from("forum_posts").select(FORUM_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw forumErr(error);
    if (!data) throw notFound("That post isn't there any more");
    const row = data as unknown as ForumRow;
    // The author reads their own post in every state; anyone else's that isn't live is already 404 by RLS.
    if (!canReport(rowToPost(row), me)) {
      throw row.student_id === me
        ? new HttpError(409, "You can't report your own post.", "forum_own_post")
        : new HttpError(409, "That post isn't live.", "forum_not_live");
    }
    const now = new Date().toISOString();
    // Conditional on still approved, so two reports (or a counselor's decision) racing write once.
    const up = await svcOrUnavailable()
      .from("forum_posts")
      .update({ status: "reported", reported_by: me, reported_at: now })
      .eq("id", id)
      .eq("status", "approved")
      .select("id")
      .maybeSingle();
    if (up.error) throw forumErr(up.error);
    if (!up.data) throw notFound("That post isn't there any more");
    void reportNotice(request, row).catch(() => {});
    return { reported: true };
  });

  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/forums/review", { preHandler: [...counselor, limit("forums:review:read", 120, 60)] }, async (request) => {
    const q = reviewQuery.parse(request.query);
    const me = request.auth.userId;
    // RLS shows a counselor only their assigned students' posts; nothing here widens that.
    const count = (statuses: string[]) => request.db.from("forum_posts").select("id", { count: "exact", head: true }).in("status", statuses);
    const list = request.db
      .from("forum_posts")
      .select(FORUM_COLUMNS)
      .in("status", q.tab === "review" ? IN_REVIEW : ["approved"])
      .order("created_at", { ascending: q.tab === "review" })
      .limit(q.limit);
    const [rows, review, approved] = await Promise.all([list, count(IN_REVIEW), count(["approved"])]);
    for (const r of [rows, review, approved]) if (r.error) throw forumErr(r.error);
    return {
      posts: ((rows.data ?? []) as unknown as ForumRow[]).map((r) => toDto(r, me, { seesPrivate: true })),
      counts: { review: review.count ?? 0, approved: approved.count ?? 0 },
    };
  });

  app.post("/forums/:id/review", { preHandler: [...counselor, limit("forums:review", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = reviewBody.parse(request.body);
    const me = request.auth.userId;
    // The caller's own RLS read is the check: it returns the post only to the author's assigned, approved counselor.
    const { data, error } = await request.db.from("forum_posts").select(FORUM_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw forumErr(error);
    if (!data) throw notFound("That post isn't there any more");
    const row = data as unknown as ForumRow;
    if (row.status === "rejected") throw new HttpError(409, "This post was already rejected.", "forum_post_rejected");
    const now = new Date().toISOString();
    let next;
    try {
      next = reviewPost(rowToPost(row), b.decision, b.note ?? "", now);
    } catch (e) {
      if (e instanceof RangeError) throw new HttpError(400, "A rejection needs a note.", "forum_review_note");
      throw e;
    }
    // Conditional on the updated_at the counselor was shown: a post edited (or reported) since is never decided unseen.
    const up = await svcOrUnavailable()
      .from("forum_posts")
      .update({ status: next.status, review_note: next.reviewNote, reported_at: null, reviewed_by: me, reviewed_at: now })
      .eq("id", id)
      .eq("updated_at", b.updatedAt)
      .select(FORUM_COLUMNS)
      .maybeSingle();
    if (up.error) throw forumErr(up.error);
    if (!up.data) throw new HttpError(409, "This post changed. Reload to see the latest.", "forum_post_changed");
    return toDto(up.data as unknown as ForumRow, me, { seesPrivate: true });
  });
}

/** A report goes to the AUTHOR's assigned counselor (profiles.counselor_id only), read with the service role. */
async function reportNotice(request: FastifyRequest, row: ForumRow) {
  const svc = serviceClient();
  if (!svc) return;
  const { data } = await svc.from("profiles").select("counselor_id").eq("id", row.student_id).maybeSingle();
  await noticeForumPost(request, row, (data?.counselor_id as string | null) ?? null, "reported");
}
