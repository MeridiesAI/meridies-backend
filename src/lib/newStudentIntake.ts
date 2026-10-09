/**
 * New-student onboarding: the round trip between the New student page and
 * the student (20261013000001).
 *
 * The counselor's requests (Transcript, Resume, "GPA"…) are counselor tasks
 * on the student's To-Do, one per request (20261012000001). The student
 * answers each with a file (attached, not handed in) or a typed answer, then
 * presses Submit: every outstanding item goes to `review` at once, AxIS reads
 * the files as advice, and the counselor hears once. The counselor ticks each
 * item received (the request's `provided`, which completes the task) or sends
 * it back with a note, and then confirms. Confirmed is what makes the
 * "Building profile" card a student.
 */

import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { badRequest, conflict, fromPostgrest, notFound } from "./errors.js";
import { serviceClient } from "./supabase.js";
import { startSubmissionReview } from "./submissionReview.js";

type Row = Record<string, unknown>;

export type IntakeItemStatus = "requested" | "submitted" | "received" | "sent-back";

/** Where one request stands, read off its task. */
export function itemStatus(task: { status: string; sentBackNote?: string | null } | null, provided: boolean): IntakeItemStatus {
  if (provided || task?.status === "complete") return "received";
  if (task?.status === "review") return "submitted";
  if (task?.sentBackNote) return "sent-back";
  return "requested";
}

/** Every request received; with nothing requested, joining is enough. */
export function canConfirm(inv: { status: string; requests: { provided: boolean }[] }): boolean {
  return inv.status === "accepted" && inv.requests.every((r) => r.provided);
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** A file the student sent: enough for the counselor to open it. */
export type IntakeFile = {
  documentId: string;
  filename: string;
  bucket: string | null;
  storagePath: string | null;
  externalWebUrl: string | null;
};

/** A request item, as the counselor's Overview card reads it. */
export type IntakeItem = {
  requestId: string;
  taskId: string | null;
  status: IntakeItemStatus;
  answer: string | null;
  sentBackNote: string | null;
  files: IntakeFile[];
  /** AxIS's latest read of a handed-in file: advice, never a decision. */
  axis: { verdict: "accepted" | "needs-fix"; note: string; findings: string[] } | null;
};

/**
 * The task side of each invitation's requests, keyed invitation → request id.
 * Runs on the caller's client: a counselor sees their own students' tasks.
 */
export async function intakeItemsByInvitation(
  request: FastifyRequest,
  invitationIds: string[]
): Promise<Map<string, Map<string, Omit<IntakeItem, "status"> & { taskStatus: string }>>> {
  const out = new Map<string, Map<string, Omit<IntakeItem, "status"> & { taskStatus: string }>>();
  if (invitationIds.length === 0) return out;

  const { data: tasks, error } = await request.db
    .from("deliverables")
    .select("id, status, intake_invitation_id, intake_request_id, intake_answer, sent_back_note")
    .in("intake_invitation_id", invitationIds);
  if (error) throw fromPostgrest(error);
  const rows = (tasks ?? []) as Row[];
  const ids = rows.map((t) => String(t.id));

  const files = new Map<string, IntakeFile[]>();
  const verdicts = new Map<string, IntakeItem["axis"]>();
  if (ids.length) {
    const [docs, checks] = await Promise.all([
      request.db
        .from("deliverable_documents")
        .select("deliverable_id, document_id, document:documents(filename, title, bucket, storage_path, external_web_url)")
        .in("deliverable_id", ids)
        .eq("role", "submission"),
      request.db
        .from("deliverable_tracker_latest")
        .select("deliverable_id, verdict, note, findings, source")
        .in("deliverable_id", ids),
    ]);
    if (docs.error) throw fromPostgrest(docs.error);
    if (checks.error) throw fromPostgrest(checks.error);
    for (const d of (docs.data ?? []) as unknown as Row[]) {
      const doc = (d.document ?? {}) as Row;
      const key = String(d.deliverable_id);
      if (!files.has(key)) files.set(key, []);
      files.get(key)!.push({
        documentId: String(d.document_id),
        filename: String(doc.title ?? doc.filename ?? "File"),
        bucket: (doc.bucket as string | null) ?? null,
        storagePath: (doc.storage_path as string | null) ?? null,
        externalWebUrl: (doc.external_web_url as string | null) ?? null,
      });
    }
    for (const c of (checks.data ?? []) as Row[]) {
      if (c.source !== "ai") continue;
      verdicts.set(String(c.deliverable_id), {
        verdict: c.verdict === "on-track" ? "accepted" : "needs-fix",
        note: String(c.note ?? ""),
        findings: Array.isArray(c.findings) ? (c.findings as string[]) : [],
      });
    }
  }

  for (const t of rows) {
    const inv = String(t.intake_invitation_id);
    if (!out.has(inv)) out.set(inv, new Map());
    out.get(inv)!.set(String(t.intake_request_id), {
      requestId: String(t.intake_request_id),
      taskId: String(t.id),
      taskStatus: String(t.status),
      answer: (t.intake_answer as string | null) ?? null,
      sentBackNote: (t.sent_back_note as string | null) ?? null,
      files: files.get(String(t.id)) ?? [],
      axis: verdicts.get(String(t.id)) ?? null,
    });
  }
  return out;
}

/** The student's own request card: what the invitation says, without reading it. */
export async function loadMyIntake(request: FastifyRequest) {
  const { data, error } = await request.db.rpc("my_intake");
  if (error) throw fromPostgrest(error);
  const row = ((data ?? []) as Row[])[0];
  if (!row) return null;
  return {
    invitationId: String(row.invitation_id),
    submittedAt: (row.submitted_at as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    counselorName: (row.counselor_name as string | null) ?? null,
  };
}

/** The student types an answer instead of a file. Locked once it is with the counselor. */
export async function saveMyAnswer(request: FastifyRequest, taskId: string, answer: string | null) {
  const { data: task, error } = await request.db
    .from("deliverables")
    .select("id, status, intake_request_id")
    .eq("id", taskId)
    .eq("student_id", request.auth.userId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!task || !task.intake_request_id) throw notFound("That request isn't yours");
  if (task.status === "review" || task.status === "complete") throw conflict("This is with your counselor now.");

  const { error: updateError } = await request.db
    .from("deliverables")
    .update({ intake_answer: answer?.trim() ? answer.trim() : null, last_activity_at: new Date().toISOString() })
    .eq("id", taskId);
  if (updateError) throw fromPostgrest(updateError);
}

/**
 * Submit: everything outstanding goes to the counselor at once. The database
 * decides it is complete (submit_intake); AxIS then reads each file as advice,
 * and the counselor gets one notification and one email.
 */
export async function submitMyIntake(request: FastifyRequest): Promise<string[]> {
  const { data, error } = await request.db.rpc("submit_intake");
  if (error) {
    if (error.code === "23514" || error.code === "P0002") throw badRequest(error.message);
    throw fromPostgrest(error);
  }
  const taskIds = ((data ?? []) as string[]).map(String);

  if (taskIds.length) {
    const { data: docs } = await request.db
      .from("deliverable_documents")
      .select("deliverable_id, document_id")
      .in("deliverable_id", taskIds)
      .eq("role", "submission");
    for (const d of (docs ?? []) as Row[]) {
      await startSubmissionReview(request, { taskId: String(d.deliverable_id), documentId: String(d.document_id) });
    }
  }

  await tellCounselor(request, taskIds).catch((err) => request.log.error({ err }, "intake submit notify failed"));
  return taskIds;
}

async function tellCounselor(request: FastifyRequest, taskIds: string[]) {
  const svc = serviceClient();
  const counselorId = request.profile.counselor_id;
  if (!svc || !counselorId) return;
  const name = String(request.profile.full_name ?? "").trim() || "Your new student";
  const { data: tasks } = await request.db.from("deliverables").select("title").in("id", taskIds);
  const items = ((tasks ?? []) as Row[]).map((t) => String(t.title));
  const heading = oneLine(`${name} sent what you asked for`, 200);
  const href = "/dashboard/counselor#student-profiles";

  const { error } = await svc.from("notifications").insert({
    recipient_id: counselorId,
    student_id: request.auth.userId,
    kind: "invite",
    urgency: "normal",
    title: heading,
    body: items.length ? `Check each one off on Overview: ${items.join(", ")}.` : "Check it off on Overview.",
    href,
    action_items: items.slice(0, 5),
    created_by: request.auth.userId,
  });
  if (error) request.log.error({ err: error }, "intake submit notification insert failed");

  const { data: counselor } = await svc.from("profiles").select("email").eq("id", counselorId).maybeSingle();
  const to = (counselor?.email as string | null) ?? null;
  if (!to) return;
  const template = {
    heading,
    paragraphs: ["Open Overview to look through each item, check off what you received, and confirm the student."],
    bullets: items.slice(0, 8),
    cta: { label: "Open Overview", url: `${env.APP_URL}${href}` },
  };
  await sendEmail({
    to,
    subject: heading.slice(0, 150),
    html: brandedEmail(template),
    text: brandedText(template),
    template: "intake-submitted-counselor",
    student_id: request.auth.userId,
    recipient_id: counselorId,
    recipient_kind: "counselor",
    logger: request.log,
  });
}

/**
 * The counselor sends one item back: the task returns to the student with the
 * note, the files they attached come off it (they stay in My documents), and
 * Submit opens again. The student hears by notification and email.
 */
export async function sendItemBack(
  request: FastifyRequest,
  inv: { id: string; acceptedBy: string },
  taskId: string,
  title: string,
  note: string
) {
  const { error } = await request.db
    .from("deliverables")
    .update({ status: "in-progress", sent_back_note: note, progress_pct: 0 })
    .eq("id", taskId);
  if (error) throw fromPostgrest(error);
  const { error: detachError } = await request.db
    .from("deliverable_documents")
    .delete()
    .eq("deliverable_id", taskId)
    .eq("role", "submission");
  if (detachError) throw fromPostgrest(detachError);
  const { error: invError } = await request.db.from("invitations").update({ submitted_at: null }).eq("id", inv.id);
  if (invError) throw fromPostgrest(invError);

  const svc = serviceClient();
  if (!svc) return;
  const heading = oneLine(`Your counselor needs your ${title} again`, 200);
  await svc.from("notifications").insert({
    recipient_id: inv.acceptedBy,
    student_id: inv.acceptedBy,
    kind: "invite",
    urgency: "high",
    title: heading,
    body: note,
    href: "/dashboard/student",
    action_items: [],
    created_by: request.auth.userId,
  });
  const { data: student } = await svc.from("profiles").select("email").eq("id", inv.acceptedBy).maybeSingle();
  const to = (student?.email as string | null) ?? null;
  if (!to) return;
  const template = {
    heading,
    paragraphs: [note],
    cta: { label: "Open your dashboard", url: `${env.APP_URL}/dashboard/student` },
  };
  await sendEmail({
    to,
    subject: heading.slice(0, 150),
    html: brandedEmail(template),
    text: brandedText(template),
    template: "intake-sent-back-student",
    student_id: inv.acceptedBy,
    deliverable_id: taskId,
    recipient_id: inv.acceptedBy,
    recipient_kind: "student",
    logger: request.log,
  }).catch((err) => request.log.error({ err }, "send-back email failed"));
}
