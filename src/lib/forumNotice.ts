/**
 * Tell a student's assigned counselor a Forums post needs them (routes/forums.ts): "sent" after the author posts or
 * edits, "reported" after another student reports it. The counselor is the AUTHOR's `profiles.counselor_id` (the
 * caller passes it: the author's own loaded row, or a service-role read of the author's profile for a report), never
 * a collaborator, and only while approved (fail closed). Written on the service client: RLS
 * `notifications_insert_counselor` forbids a student's insert.
 *
 * At most one "sent" notice per author per hour and twenty per day, one "reported" notice per post per day
 * (`consumeRateLimit`). The post's text never goes into a notice or a log line. Never throws.
 */

import type { FastifyRequest } from "fastify";
import { isCounselorApproved } from "./access.js";
import type { ForumRow } from "./forums.js";
import { consumeRateLimit } from "./limits.js";
import { serviceClient } from "./supabase.js";

export async function noticeForumPost(
  request: FastifyRequest,
  post: Pick<ForumRow, "id" | "student_id" | "author_first">,
  counselorId: string | null,
  what: "sent" | "reported"
): Promise<void> {
  try {
    if (!counselorId) return;
    const svc = serviceClient();
    if (!svc) return;
    if (!(await isCounselorApproved(svc, counselorId))) return;

    const authorId = post.student_id;
    const allowed =
      what === "sent"
        ? (await consumeRateLimit(`forum-notice:sent:${authorId}`, 1, 3600, request.log)) &&
          (await consumeRateLimit(`forum-notice:sent:day:${authorId}`, 20, 86_400, request.log))
        : await consumeRateLimit(`forum-notice:reported:${post.id}`, 1, 86_400, request.log);
    if (!allowed) return;

    const { error } = await svc.from("notifications").insert({
      recipient_id: counselorId,
      student_id: authorId,
      kind: "system",
      urgency: what === "reported" ? "normal" : "low",
      title: what === "reported" ? `A post by ${post.author_first} was reported` : `${post.author_first} sent a Forums post for review`,
      body: null,
      href: "/dashboard/counselor/forums",
      action_items: [],
      created_by: authorId,
    });
    if (error) request.log.error({ code: error.code }, "forum notice: notification insert failed");
  } catch (err) {
    request.log.error({ msg: err instanceof Error ? err.message : "unknown" }, "forum notice failed");
  }
}
