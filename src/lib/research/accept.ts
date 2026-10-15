/**
 * Accepting or dismissing a recommendation. The status change is claimed first with a conditional update
 * (`status = 'suggested'`), so two clicks can't create two things: the loser gets 409 before anything is created.
 * If creating the college-list row or the task then fails, the claim is released.
 *
 * One suggestion can be stored more than once across runs (`repeats.ts`). Accepting is refused (409
 * `already_accepted`) when the same suggestion was accepted before and its college-list row or task still exists, and
 * a decision on one copy dismisses the student's other `suggested` copies (`alsoDismissed`), so the list the
 * counselor sees, one card per suggestion, stays in step with the rows.
 */
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addToList } from "../../routes/application.js";
import { fromPostgrest, HttpError, notFound, unavailable } from "../errors.js";
import { assertCanEditStudent } from "../guards.js";
import { serviceClient } from "../supabase.js";
import { taskTextFor } from "./prompt.js";
import { acceptedCopyOf, copiesOf, loadRepeatPool, readCandidates, toCandidate, type RepeatCandidate } from "./repeats.js";
import type { RecommendationDto } from "./run.js";

type Row = Record<string, unknown>;

const ALREADY = "That recommendation was already accepted or dismissed.";
/** This row was decided already (another click, another tab). */
const decided = () => new HttpError(409, ALREADY, "recommendation_decided");

/** Read on the caller's own client, so a recommendation they can't see is a 404; then check they may edit the student. */
async function loadForEdit(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db
    .from("recommendations")
    .select("id, student_id, feature, title, why, details, sources, status, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That recommendation isn't available");
  await assertCanEditStudent(request, data.student_id as string);
  return data as Row;
}

/**
 * Dismiss the student's other `suggested` copies of this suggestion. Best effort: the decision on `rec` already
 * stands, so a failure here is logged and the copies stay (the list still shows only the newest). The ids come from a
 * read on the caller's client, scoped to this student, and the update repeats both conditions.
 */
async function dismissCopies(request: FastifyRequest, svc: SupabaseClient, rec: RepeatCandidate, studentId: string, ids: string[]): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await svc
      .from("recommendations")
      .update({ status: "dismissed" })
      .in("id", ids.slice(i, i + 100))
      .eq("student_id", studentId)
      .eq("status", "suggested")
      .select("id");
    if (error) {
      request.log.error({ recommendationId: rec.id, code: error.code }, "dismissing repeated recommendations failed");
      break;
    }
    for (const r of data ?? []) done.push(r.id as string);
  }
  return done;
}

export type AcceptResult = { acceptedAs: NonNullable<RecommendationDto["acceptedAs"]>; alsoDismissed: string[] };

export async function acceptRecommendation(request: FastifyRequest, id: string): Promise<AcceptResult> {
  const rec = await loadForEdit(request, id);
  if (rec.status !== "suggested") throw decided();
  const studentId = rec.student_id as string;
  const self = toCandidate(rec);

  // The same suggestion accepted before, and still on the list or still a task: a second one would be a duplicate.
  // A read error fails closed (nothing is created). Two copies accepted at the same instant can both pass this check.
  const { pool, live } = await loadRepeatPool(request, studentId, [self.feature]);
  if (acceptedCopyOf(self, pool, live)) {
    throw new HttpError(
      409,
      self.feature === "college_list" ? "That school is already on the list." : "That activity is already a task for this student.",
      "already_accepted"
    );
  }

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
  if (!claimed || claimed.length !== 1) throw decided();

  let acceptedAs: NonNullable<RecommendationDto["acceptedAs"]>;
  try {
    if (rec.feature === "college_list") {
      const details = (rec.details ?? {}) as { collegeId?: string };
      const row = await addToList(request, studentId, { name: rec.title as string, collegeId: details.collegeId ?? undefined }).catch((err: unknown) => {
        // On the list already (added by hand, or by another copy): a code the app can branch on.
        if (err instanceof HttpError && err.statusCode === 409) throw new HttpError(409, err.message, "already_on_list");
        throw err;
      });
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
  const alsoDismissed = await dismissCopies(request, svc, self, studentId, copiesOf(self, pool));
  return { acceptedAs, alsoDismissed };
}

export async function dismissRecommendation(
  request: FastifyRequest,
  id: string
): Promise<{ id: string; status: "dismissed"; alsoDismissed: string[] }> {
  const rec = await loadForEdit(request, id);
  const svc = serviceClient();
  if (!svc) throw unavailable("Dismissing is unavailable right now. Try again shortly.");
  const { data, error } = await svc
    .from("recommendations")
    .update({ status: "dismissed" })
    .eq("id", id)
    .eq("status", "suggested")
    .select("id");
  if (error) throw fromPostgrest(error);
  if (!data || data.length !== 1) throw decided();
  const self = toCandidate(rec);
  const studentId = rec.student_id as string;
  let copies: string[] = [];
  try {
    copies = copiesOf(self, (await readCandidates(request, studentId, [self.feature], "suggested")).rows);
  } catch (err) {
    request.log.error({ recommendationId: id, code: err instanceof HttpError ? err.statusCode : undefined }, "reading repeated recommendations failed");
  }
  return { id, status: "dismissed", alsoDismissed: await dismissCopies(request, svc, self, studentId, copies) };
}
