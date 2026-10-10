/**
 * Accepting or dismissing a recommendation. The status change is claimed first with a conditional update
 * (`status = 'suggested'`), so two clicks can't create two things: the loser gets 409 before anything is created.
 * If creating the college-list row or the task then fails, the claim is released.
 */
import type { FastifyRequest } from "fastify";
import { addToList } from "../../routes/application.js";
import { conflict, fromPostgrest, notFound, unavailable } from "../errors.js";
import { assertCanEditStudent } from "../guards.js";
import { serviceClient } from "../supabase.js";
import { taskTextFor } from "./prompt.js";
import type { RecommendationDto } from "./run.js";

type Row = Record<string, unknown>;

const ALREADY = "That recommendation was already accepted or dismissed.";

/** Read on the caller's own client, so a recommendation they can't see is a 404; then check they may edit the student. */
async function loadForEdit(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db
    .from("recommendations")
    .select("id, student_id, feature, title, why, details, sources, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That recommendation isn't available");
  await assertCanEditStudent(request, data.student_id as string);
  return data as Row;
}

export async function acceptRecommendation(request: FastifyRequest, id: string): Promise<{ acceptedAs: NonNullable<RecommendationDto["acceptedAs"]> }> {
  const rec = await loadForEdit(request, id);
  if (rec.status !== "suggested") throw conflict(ALREADY);
  const svc = serviceClient();
  if (!svc) throw unavailable("Accepting is unavailable right now. Try again shortly.");
  const me = request.auth.userId;

  // Claim: exactly one caller changes the row.
  const { data: claimed, error: claimError } = await svc
    .from("recommendations")
    .update({ status: "accepted", accepted_by: me, accepted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "suggested")
    .select("id");
  if (claimError) throw fromPostgrest(claimError);
  if (!claimed || claimed.length !== 1) throw conflict(ALREADY);

  const studentId = rec.student_id as string;
  let acceptedAs: NonNullable<RecommendationDto["acceptedAs"]>;
  try {
    if (rec.feature === "college_list") {
      const details = (rec.details ?? {}) as { collegeId?: string };
      const row = await addToList(request, studentId, { name: rec.title as string, collegeId: details.collegeId ?? undefined });
      acceptedAs = { type: "student_college", id: row.id as string };
    } else {
      // A counselor-only task, the way a counselor makes one by hand: hidden, no deadline mirroring, no notification.
      const { title, instructions } = taskTextFor({
        title: rec.title as string,
        why: rec.why as string,
        sources: (rec.sources ?? []) as { url: string }[],
      });
      const { data: task, error } = await request.db
        .from("deliverables")
        .insert({
          student_id: studentId,
          kind: "custom",
          title,
          instructions,
          status: "not-started",
          source: "counselor",
          created_by: me,
          assigned_by: me,
          assigned_at: new Date().toISOString(),
          notify_email: false,
          notify_sms: false,
          visible_to_student: false,
        })
        .select("id")
        .single();
      if (error) throw fromPostgrest(error);
      const taskId = task.id as string;
      await request.db.from("progress_events").insert({
        student_id: studentId,
        deliverable_id: taskId,
        entity_type: "deliverable",
        entity_id: taskId,
        event: "created",
        actor_id: me,
        metadata: { source: "recommendation" },
      });
      acceptedAs = { type: "task", id: taskId };
    }
  } catch (err) {
    const { error } = await svc
      .from("recommendations")
      .update({ status: "suggested", accepted_by: null, accepted_at: null, accepted_as: null })
      .eq("id", id)
      .eq("accepted_by", me);
    if (error) request.log.error({ recommendationId: id, code: error.code }, "releasing a recommendation claim failed");
    throw err;
  }

  const { error: linkError } = await svc.from("recommendations").update({ accepted_as: acceptedAs }).eq("id", id);
  // The thing exists and the row says accepted; a missing link is logged rather than undone.
  if (linkError) request.log.error({ recommendationId: id, code: linkError.code }, "storing the acceptance link failed");
  return { acceptedAs };
}

export async function dismissRecommendation(request: FastifyRequest, id: string): Promise<{ id: string; status: "dismissed" }> {
  await loadForEdit(request, id);
  const svc = serviceClient();
  if (!svc) throw unavailable("Dismissing is unavailable right now. Try again shortly.");
  const { data, error } = await svc
    .from("recommendations")
    .update({ status: "dismissed" })
    .eq("id", id)
    .eq("status", "suggested")
    .select("id");
  if (error) throw fromPostgrest(error);
  if (!data || data.length !== 1) throw conflict(ALREADY);
  return { id, status: "dismissed" };
}
