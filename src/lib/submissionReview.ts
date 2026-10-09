/**
 * AxIS checks a file a student handed in against the task it was handed in
 * for ("Transcript", "Resume", an essay draft), then moves the task.
 *
 * What it decides is narrow on purpose: is this the thing that was asked for,
 * and is it usable (complete, legible, the right student, current)? It does
 * not grade the student's work and never rewrites it: findings are short
 * bullets through `enforceNoProse`, the same filter the essay routes use. Facts
 * it reads off the document (a GPA, a test score) are shown to the counselor
 * as findings; nothing is written into the student's profile from a model's
 * reading of a scan.
 *
 * Outcome:
 *   accepted   -> a tracker check "on-track", the task complete (which also
 *                 ticks the counselor's intake request; see 20261012000001)
 *   needs-fix  -> a check "below-the-brief", the task back to in-progress,
 *                 and the student is told what to fix
 * When the student handed it in, the counselor gets one notification either
 * way (a counselor re-running the check is already looking). When AxIS can't
 * or may not read the file (AI off for the practice, kept out of AI, a format
 * it can't open, no API key) the task stays "review" for the counselor and
 * the notification says the file arrived, without a verdict.
 *
 * Writes go through the service role: the student triggers this, but the
 * verdict, the task's completion and the counselor's notification are not
 * the student's to write (the tracker table refuses them since
 * 20261012000001). Every id here was checked by the route first.
 */

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { env, hasAnthropic } from "../env.js";
import { enforceNoProse, runStructured, type AiAttachment } from "./anthropic.js";
import { readDocumentText } from "./documentText.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { serviceClient } from "./supabase.js";
import { toPrivacySettings } from "./practiceSettings.js";

type Row = Record<string, unknown>;
type Svc = NonNullable<ReturnType<typeof serviceClient>>;

/** Largest file sent to the model. A transcript or resume is well under this. */
export const MAX_REVIEW_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;

const IMAGE_TYPES: Record<string, AiAttachment["mediaType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * How AxIS reads a file: as a PDF or an image the model opens itself, as
 * extracted text (.docx, .txt, .md), or not at all. The extension decides
 * first because browsers send inconsistent MIME types for the same file.
 */
export function readMode(
  filename: string,
  mimeType: string | null
): { kind: "attachment"; mediaType: AiAttachment["mediaType"] } | { kind: "text" } | { kind: "unreadable" } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = (mimeType ?? "").toLowerCase();
  if (ext === "pdf" || mime === "application/pdf") return { kind: "attachment", mediaType: "application/pdf" };
  if (IMAGE_TYPES[ext]) return { kind: "attachment", mediaType: IMAGE_TYPES[ext]! };
  const fromMime = Object.values(IMAGE_TYPES).find((t) => t === mime);
  if (fromMime) return { kind: "attachment", mediaType: fromMime };
  if (["docx", "txt", "md", "markdown"].includes(ext) || mime === "text/plain" || mime === "text/markdown") {
    return { kind: "text" };
  }
  return { kind: "unreadable" };
}

export type ReviewVerdict = "accepted" | "needs-fix";

export type ReviewResult = {
  verdict: ReviewVerdict;
  note: string;
  findings: string[];
  facts: { label: string; value: string }[];
  studentFix: string | null;
};

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The model sometimes sends a list as its JSON text ("[\"a\", \"b\"]") rather
 * than as a list. Read that back into the list; anything else that is a string
 * is one item.
 */
function listFrom(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      // Not JSON after all: fall through to a single item.
    }
  }
  return [t];
}

/** One bullet per item, whatever markup the model wrapped them in. */
function splitItems(items: string[]): string[] {
  return items
    .flatMap((item) => (/<\/?item>/i.test(item) ? item.split(/<\/?item>/i) : [item]))
    .map((item) => item.replace(/<[^>]{1,20}>/g, " ").trim())
    .filter(Boolean);
}

/** A figure as printed, or null. Markup the model leaked into a value is not a figure. */
const printed = z
  .preprocess((v) => (typeof v === "string" && v.trim() && !/[<>]/.test(v) ? v : null), z.string().nullable())
  .optional()
  .catch(null);

/** Model output is untrusted: re-validated, trimmed and filtered here. */
export function cleanReview(value: unknown): ReviewResult {
  const parsed = z
    .object({
      verdict: z.enum(["accepted", "needs-fix"]),
      note: z.string(),
      findings: z.preprocess(listFrom, z.array(z.string())).catch([]).default([]),
      // Flat on purpose: the model garbles nested objects in a tool call
      // often enough to lose them, and a lost figure must not lose the verdict.
      weightedGpa: printed,
      unweightedGpa: printed,
      classRank: printed,
      testScores: z.preprocess(listFrom, z.array(z.string())).catch([]).default([]),
      studentFix: z.string().nullable().optional().catch(null),
    })
    .parse(value);
  const facts = [
    { label: "Weighted GPA", value: parsed.weightedGpa ?? "" },
    { label: "Unweighted GPA", value: parsed.unweightedGpa ?? "" },
    { label: "Class rank", value: parsed.classRank ?? "" },
    ...parsed.testScores.filter((t) => !/[<>]/.test(t)).map((t) => ({ label: "Test score", value: t })),
  ]
    .map((f) => ({ label: f.label, value: oneLine(f.value, 80) }))
    .filter((f) => f.value)
    .slice(0, 8);
  const fix = parsed.studentFix ? oneLine(parsed.studentFix, 240) : "";
  return {
    verdict: parsed.verdict,
    note: oneLine(parsed.note, 200) || (parsed.verdict === "accepted" ? "Looks like what was asked for." : "Needs another look."),
    findings: enforceNoProse(splitItems(parsed.findings).map((f) => oneLine(f, 240))).slice(0, 6),
    facts,
    // A fix is only meaningful when something needs fixing.
    studentFix: parsed.verdict === "needs-fix" && fix ? fix : null,
  };
}

/** The findings the counselor reads: what AxIS read off the file first, then what it noticed. */
export function checkFindings(r: ReviewResult): string[] {
  return [...r.facts.map((f) => `${f.label}: ${f.value}`), ...r.findings].slice(0, 14);
}

/**
 * The task status a verdict moves to. Never downgrades a task the counselor
 * already closed, and only reopens one that is waiting on a check.
 */
export function nextTaskStatus(current: string, verdict: ReviewVerdict, advisory = false): string | null {
  // A request from New student: the counselor receives it or sends it back.
  // AxIS's verdict is advice on the card, never a move.
  if (advisory) return null;
  if (verdict === "accepted") return current === "complete" ? null : "complete";
  return current === "review" ? "in-progress" : null;
}

/** A request from the New student page: the student's Submit sends it, the counselor receives it. */
export function isIntakeRequest(task: Row): boolean {
  return typeof task.intake_request_id === "string" && task.intake_request_id.length > 0;
}

/** Whether the student's practice lets AI read uploaded documents (Settings › Data & privacy). */
async function documentReadingAllowed(svc: Svc, studentId: string): Promise<boolean> {
  const { data: student } = await svc.from("profiles").select("counselor_id").eq("id", studentId).maybeSingle();
  const counselorId = (student?.counselor_id as string | null) ?? null;
  if (!counselorId) return false;
  const { data: counselor } = await svc.from("profiles").select("firm_id").eq("id", counselorId).maybeSingle();
  const firmId = (counselor?.firm_id as string | null) ?? null;
  let builder = svc.from("practice_settings").select("*");
  builder = firmId ? builder.eq("firm_id", firmId) : builder.eq("counselor_id", counselorId);
  const { data, error } = await builder.maybeSingle();
  // Fail closed: an unreadable setting is not permission.
  if (error) return false;
  return toPrivacySettings(data as Row | null).autoParseDocuments;
}

type Outcome =
  | { status: "reviewed"; result: ReviewResult }
  | { status: "skipped"; reason: string };

type Prepared =
  | { status: "ready"; judge: () => Promise<ReviewResult> }
  | { status: "skipped"; reason: string };

/** What the caller can tell the client straight away. */
export type ReviewStart = { status: "checking" } | { status: "skipped"; reason: string };

/**
 * Check one handed-in file and move its task. The quick refusals (AI off, a
 * format AxIS can't open, too large) answer now; the model's read, which
 * takes seconds, runs after the response and the client polls the task for
 * the verdict. Never throws: the submission is already recorded when this
 * runs, and a failed check must not undo it.
 */
export async function startSubmissionReview(
  request: FastifyRequest,
  args: { taskId: string; documentId: string }
): Promise<ReviewStart> {
  const svc = serviceClient();
  if (!svc) return { status: "skipped", reason: "AxIS can't check files on this server yet." };

  let task: Row | null = null;
  let prepared: Prepared;
  try {
    const [{ data: t }, { data: doc }] = await Promise.all([
      svc.from("deliverables").select("*").eq("id", args.taskId).maybeSingle(),
      svc.from("documents").select("*").eq("id", args.documentId).maybeSingle(),
    ]);
    task = (t as Row | null) ?? null;
    if (!task || !doc || doc.student_id !== task.student_id) {
      return { status: "skipped", reason: "That file isn't on this task." };
    }
    prepared = await decide(request, svc, task, doc as Row, String(task.student_id));
  } catch (err) {
    request.log.error({ err, taskId: args.taskId }, "submission review failed to start");
    prepared = { status: "skipped", reason: "AxIS couldn't check this file just now." };
  }

  if (prepared.status === "skipped") {
    if (task) await notify(request, svc, task, prepared).catch((err) => request.log.error({ err }, "submission notify failed"));
    return prepared;
  }

  const reviewed = task!;
  const judge = prepared.judge;
  void (async () => {
    let outcome: Outcome;
    try {
      const result = await judge();
      // The student may have taken the file back while AxIS read it: a verdict
      // on a file no longer handed in must not complete (or reopen) the task.
      const { data: still, error: stillError } = await svc
        .from("deliverable_documents")
        .select("document_id")
        .eq("deliverable_id", String(reviewed.id))
        .eq("document_id", args.documentId)
        .eq("role", "submission")
        .maybeSingle();
      if (stillError) throw new Error(`submission re-read: ${stillError.message}`);
      if (!still) return;
      await record(svc, reviewed, args.documentId, result);
      outcome = { status: "reviewed", result };
    } catch (err) {
      request.log.error({ err, taskId: args.taskId }, "submission review failed");
      outcome = { status: "skipped", reason: "AxIS couldn't check this file just now." };
    }
    await notify(request, svc, reviewed, outcome).catch((err) => request.log.error({ err }, "submission notify failed"));
  })();
  return { status: "checking" };
}

async function decide(request: FastifyRequest, svc: Svc, task: Row, doc: Row, studentId: string): Promise<Prepared> {
  // The practice's and the file's own switches first: they are the reason a
  // counselor can act on.
  if (doc.available_to_llm === false) return { status: "skipped", reason: "This file is kept out of AI, so AxIS didn't read it." };
  if (!(await documentReadingAllowed(svc, studentId))) {
    return { status: "skipped", reason: "Automatic document reading is off for this practice." };
  }
  if (!hasAnthropic) return { status: "skipped", reason: "AxIS isn't set up on this server yet." };
  if (!doc.storage_path) return { status: "skipped", reason: "AxIS reads uploaded files; this one is a link." };

  const filename = String(doc.filename ?? "file");
  const mode = readMode(filename, (doc.mime_type as string | null) ?? null);
  if (mode.kind === "unreadable") return { status: "skipped", reason: `AxIS can't open .${filename.split(".").pop()} files.` };
  if (typeof doc.size_bytes === "number" && doc.size_bytes > MAX_REVIEW_BYTES) {
    return { status: "skipped", reason: "This file is too large for AxIS to read." };
  }

  const dl = await svc.storage.from(String(doc.bucket ?? "student-documents")).download(String(doc.storage_path));
  if (dl.error || !dl.data) return { status: "skipped", reason: "AxIS couldn't open the uploaded file." };
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  if (bytes.length === 0) return { status: "skipped", reason: "The uploaded file is empty." };
  if (bytes.length > MAX_REVIEW_BYTES) return { status: "skipped", reason: "This file is too large for AxIS to read." };

  let attachments: AiAttachment[] | undefined;
  let text = "";
  if (mode.kind === "attachment") {
    attachments = [{ mediaType: mode.mediaType, data: bytes.toString("base64"), title: filename }];
  } else {
    text = readDocumentText(bytes, filename, (doc.mime_type as string | null) ?? null) ?? "";
    if (!text.trim()) return { status: "skipped", reason: "AxIS couldn't read any text in this file." };
  }

  const { data: student } = await svc.from("profiles").select("full_name").eq("id", studentId).maybeSingle();
  const studentName = String(student?.full_name ?? "").trim();
  const instructions = String(task.instructions ?? "").trim();

  const judge = () => runStructured<ReviewResult>({
    request,
    module: "submission-review",
    studentId,
    system: [
      "You check a file a high-school student handed in to their college counselor.",
      "Decide one thing: is this the document that was asked for, and is it usable?",
      "Usable means: the right kind of document, readable, not cut off, and about this student when a name appears.",
      "Judge completeness against what can exist today. A current student's transcript covers only the years finished so far, an unofficial transcript or a printout from the school portal is acceptable unless the counselor asked for an official one, and a resume may be short.",
      "Only say needs-fix for a real problem the student can act on: the wrong document, unreadable, plainly cut off, another person's, or missing something the counselor explicitly asked for.",
      "Do not grade the student's achievements, writing quality or effort. A weak but genuine transcript is accepted.",
      "Never rewrite, draft, continue or quote the student's work at length. Never produce prose they could paste anywhere.",
      "note: ONE plain line, at most 200 characters, that both the student and the counselor read. Describe the file, not the person: \"This is a beach packing list, not a resume.\" or \"Official transcript through grade 10, complete and readable.\" Never write \"the student\".",
      "findings: up to 6 short bullets on what you checked or what is wrong, each a separate list item with no markup.",
      "weightedGpa, unweightedGpa, classRank, testScores: copied exactly as printed on the document (classRank like \"24 of 410\", each test score like \"SAT 1450\"); null or empty when not printed. Never infer or compute a value.",
      "studentFix: when the verdict is needs-fix, one plain sentence telling the student what to upload instead. Otherwise null.",
    ].join("\n"),
    prompt: [
      `Requested: ${String(task.title)}`,
      instructions ? `What the counselor wrote: ${instructions}` : "",
      studentName ? `Student's name on file: ${studentName}` : "",
      `File name: ${filename}`,
      text ? `\nThe file's text:\n${text.slice(0, MAX_TEXT_CHARS)}` : "The file is attached.",
    ]
      .filter(Boolean)
      .join("\n"),
    attachments,
    toolName: "submission_check",
    maxTokens: 1200,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["accepted", "needs-fix"] },
        note: { type: "string", maxLength: 200 },
        findings: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
        weightedGpa: { type: ["string", "null"], maxLength: 40 },
        unweightedGpa: { type: ["string", "null"], maxLength: 40 },
        classRank: { type: ["string", "null"], maxLength: 60 },
        testScores: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
        studentFix: { type: ["string", "null"], maxLength: 240 },
      },
      required: ["verdict", "note", "findings", "weightedGpa", "unweightedGpa", "classRank", "testScores", "studentFix"],
    },
    validate: cleanReview,
  });
  return { status: "ready", judge };
}

async function record(svc: Svc, task: Row, documentId: string, result: ReviewResult): Promise<void> {
  // The task moves first and the verdict is written last: a client polling for
  // the verdict then never sees "accepted" on a task still waiting on a check.
  // Re-read the status: the counselor may have moved the task while AxIS read.
  const { data: fresh } = await svc.from("deliverables").select("status").eq("id", String(task.id)).maybeSingle();
  const next = nextTaskStatus(String(fresh?.status ?? task.status), result.verdict, isIntakeRequest(task));
  if (next) {
    const update: Row = { status: next, last_activity_at: new Date().toISOString() };
    if (next === "complete") update.progress_pct = 100;
    const { error: taskError } = await svc.from("deliverables").update(update).eq("id", String(task.id));
    if (taskError) throw new Error(`task update: ${taskError.message}`);
    task.status = next;
  }

  const { error } = await svc.from("deliverable_tracker_checks").insert({
    student_id: task.student_id,
    deliverable_id: task.id,
    document_id: documentId,
    verdict: result.verdict === "accepted" ? "on-track" : "below-the-brief",
    note: result.note,
    findings: checkFindings(result),
    documents_checked: 1,
    source: "ai",
    checked_by: null,
  });
  if (error) throw new Error(`tracker check insert: ${error.message}`);
}

/**
 * One bell notification and one email per person who needs to act. The
 * counselor hears about every hand-in the student makes (never about their
 * own "Check again"); the student hears only when AxIS hands it back, with
 * what to upload instead. Email goes to the address on the profile, the way
 * task assignments do, and every send is a `message_deliveries` row; a failed
 * email never undoes the notification or the verdict.
 */
async function notify(request: FastifyRequest, svc: Svc, task: Row, outcome: Outcome): Promise<void> {
  const studentId = String(task.student_id);
  const { data: student } = await svc
    .from("profiles")
    .select("full_name, email, counselor_id")
    .eq("id", studentId)
    .maybeSingle();
  const name = String(student?.full_name ?? "").trim() || "Your student";
  const counselorId = (student?.counselor_id as string | null) ?? null;
  const title = String(task.title);
  const reviewed = outcome.status === "reviewed" ? outcome.result : null;
  const rows: Row[] = [];
  const emails: Parameters<typeof sendEmail>[0][] = [];
  // A Submit from New student tells the counselor once, for every item
  // (lib/newStudentIntake.ts); AxIS's verdict waits on the card, and only the
  // counselor sends an item back.
  const advisory = isIntakeRequest(task);

  if (counselorId && request.profile.role === "student" && !advisory) {
    const heading = reviewed
      ? reviewed.verdict === "accepted"
        ? `${name} handed in ${title}: AxIS accepted it`
        : `${name} handed in ${title}: AxIS flagged it`
      : `${name} handed in ${title}`;
    const body = reviewed ? `AxIS: ${reviewed.note}` : outcome.status === "skipped" ? outcome.reason : null;
    const href = `/dashboard/counselor/students/${studentId}`;
    rows.push({
      recipient_id: counselorId,
      student_id: studentId,
      kind: "ai",
      urgency: reviewed?.verdict === "needs-fix" ? "high" : "normal",
      title: oneLine(heading, 200),
      body,
      href,
      action_items: reviewed ? reviewed.findings.slice(0, 3) : [],
      created_by: request.auth.userId,
    });
    const { data: counselor } = await svc.from("profiles").select("email").eq("id", counselorId).maybeSingle();
    const to = (counselor?.email as string | null) ?? null;
    if (to) {
      const template = {
        heading: oneLine(heading, 200),
        paragraphs: [body ?? "Open the student's page to see the file."],
        bullets: reviewed ? checkFindings(reviewed).slice(0, 5) : [],
        cta: { label: `Open ${name}'s page`, url: `${env.APP_URL}${href}` },
      };
      emails.push({
        to,
        subject: oneLine(heading, 150),
        html: brandedEmail(template),
        text: brandedText(template),
        template: "submission-review-counselor",
        student_id: studentId,
        deliverable_id: String(task.id),
        recipient_id: counselorId,
        recipient_kind: "counselor",
        logger: request.log,
      });
    }
  }

  if (reviewed?.verdict === "needs-fix" && !advisory) {
    const fix = reviewed.studentFix ?? reviewed.note;
    rows.push({
      recipient_id: studentId,
      student_id: studentId,
      kind: "ai",
      urgency: "high",
      title: oneLine(`Check your ${title}`, 200),
      body: fix,
      href: "/dashboard/student",
      action_items: [],
      created_by: request.auth.userId,
    });
    const to = (student?.email as string | null) ?? null;
    if (to) {
      const template = {
        heading: oneLine(`Check your ${title}`, 200),
        paragraphs: [reviewed.note, fix === reviewed.note ? "" : fix],
        cta: { label: "Upload it again", url: `${env.APP_URL}/dashboard/student` },
        footnote: "AxIS checks what you hand in against what your counselor asked for. Your counselor sees this too.",
      };
      emails.push({
        to,
        subject: oneLine(`Check your ${title}`, 150),
        html: brandedEmail(template),
        text: brandedText(template),
        template: "submission-review-student",
        student_id: studentId,
        deliverable_id: String(task.id),
        recipient_id: studentId,
        recipient_kind: "student",
        logger: request.log,
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await svc.from("notifications").insert(rows);
    if (error) request.log.error({ err: error }, "submission notification insert failed");
  }
  for (const email of emails) {
    await sendEmail(email).catch((err) => request.log.error({ err }, "submission email failed"));
  }
}
