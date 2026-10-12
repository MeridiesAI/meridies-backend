/**
 * Talking to families and keeping the record of it: a student's
 * Communication composer (routes/communication.ts), Email blasts
 * (routes/blasts.ts), the counselor's Email templates
 * (routes/emailTemplates.ts), the in-app Notifications bell
 * (routes/notifications.ts), and Family reports with the Coherence review
 * queue's narrative flags (routes/reports.ts).
 *
 * Everything that sends or schedules asks first, and its card shows who it
 * goes to (as the route will resolve them), the subject and the whole body:
 * a composer message, a blast, a report recorded as sent. The routes decide
 * recipients, quiet hours and throttles; these operations pass the request
 * through and never pick an address. Filing a draft, editing a draft or a
 * template, the composer's defaults and marking notifications read run at
 * once. Sharing a flag with the student, archiving and deleting ask.
 *
 * Replies name messages, reports, templates and notifications; they never
 * carry an address, a phone number, a message body or a report body. AxIS
 * drafting (the composer's and the templates') and anything that calls a
 * model stay out: those are the counselor's clicks in the app.
 */
import { z } from "zod";
import { wrapUntrusted } from "../../../context/pack.js";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, dayLabel, defined, idOf, isoDateTime, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = Pick<OpHelpers, "get">;
type Row = Record<string, unknown>;

/** "Nov 1, 2026 at 09:00 UTC-05:00" from an ISO time, as written. Cards only. */
function whenLabel(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return plainText(s, 40);
  const zone = !m[3] ? "" : m[3] === "Z" || m[3] === "+00:00" ? " UTC" : ` UTC${m[3]}`;
  return `${dayLabel(m[1])} at ${m[2]}${zone}`;
}

async function findIn(h: Get, url: string, id: string): Promise<Row | null> {
  return asArray(await h.get<unknown[]>(url)).find((r) => r.id === id) ?? null;
}

// ---- The composer ------------------------------------------------------------------

const AUDIENCE = ["parent", "student"] as const;
const CHANNEL = ["email", "sms"] as const;
const MESSAGE_KINDS = ["message", "referral", "alert"] as const;
/** routes/communication.ts TEXT_LIMIT: texts are kept to two segments. */
const TEXT_LIMIT = 320;

const composerUrl = (studentId: string) => `/communication/${seg(studentId)}/composer`;
const messagesUrl = (studentId: string) => `/communication/${seg(studentId)}/messages`;

/** Who the route will write to, from the composer's own family list. Names only, for the card. */
function recipientsLine(audience: (typeof AUDIENCE)[number], channel: (typeof CHANNEL)[number], composer: Row | null, studentName: string): string {
  if (audience === "parent") {
    if (!composer) return "To: Parents — every guardian on file who receives messages and has an email address";
    const reachable = asArray(composer.family).filter((g) => g.receivesMessages === true && str(g.email));
    return reachable.length
      ? `To: Parents — ${reachable.map((g) => plainText(g.name, 60)).join(", ")} (by email)`
      : "To: Parents — nobody on file can receive it yet, so Meridies will refuse it (add a parent with an email address first)";
  }
  const s = asRecord(composer?.student);
  const missing = composer ? (channel === "sms" ? !str(s.phone) : !str(s.email)) : false;
  return `To: Student — ${plainText(str(s.name) ?? studentName, 80)} (${channel === "sms" ? "by text" : "by email"})${
    missing ? `; no ${channel === "sms" ? "phone number" : "email address"} on file, so Meridies will refuse it` : ""
  }`;
}

const messageLabel = (m: Row | null, studentName: string) => {
  if (!m) return "a scheduled message";
  const what = m.channel === "sms" ? "text" : "email";
  const to = m.audience === "parent" ? `${studentName}'s parents` : studentName;
  return `${what} to ${to}${m.subject ? ` "${plainText(m.subject, 80)}"` : ""}${m.scheduledFor ? ` (${whenLabel(m.scheduledFor)})` : ""}`;
};

export const messages: OpGroup = {
  heading: "Communication",
  ops: [
    op({
      name: "messages.list",
      kind: "read",
      title: "What the composer sent or scheduled for a student, with message ids and status (newest first).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: messagesUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (m) => {
            const when = m.status === "scheduled" && m.scheduledFor ? `scheduled for ${str(m.scheduledFor)}` : m.sentAt ? `sent ${str(m.sentAt)}` : `written ${str(m.createdAt)}`;
            return `id ${str(m.id)}: [${str(m.status)}] ${m.channel === "sms" ? "text" : "email"} to ${m.audience === "parent" ? "the parents" : "the student"}${
              m.kind && m.kind !== "message" ? ` (${str(m.kind)})` : ""
            } · ${when}${m.subject ? ` · subject ${untrusted(m.subject)}` : ""}`;
          },
          "The composer hasn't sent anything for this student."
        ),
    }),
    op({
      name: "messages.set_defaults",
      kind: "write",
      risk: "auto",
      title: "Set who a student's composer writes to by default (parents or the student) and how (email or text).",
      doc: "{ student_id, audience?: parent|student, channel?: email|sms }",
      input: z.object({ student_id: uuid, audience: z.enum(AUDIENCE).optional(), channel: z.enum(CHANNEL).optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: `/communication/${seg(i.student_id)}/prefs`, body: defined({ audience: i.audience, channel: i.channel }) }),
      describe: (i, h) => {
        const parts = [i.audience ? `to ${i.audience === "parent" ? "the parents" : "the student"}` : null, i.channel ? `by ${i.channel === "sms" ? "text" : "email"}` : null].filter(Boolean);
        return `Set ${h.studentName(i.student_id)}'s composer to write ${parts.length ? parts.join(" ") : "as before"}`;
      },
      snapshot: async (i, h) => {
        const c = await h.get<Row>(composerUrl(i.student_id));
        const p = asRecord(asRecord(c).prefs);
        return p.audience && p.channel ? { audience: p.audience, channel: p.channel } : null;
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.audience) return null;
        return { op: "messages.set_defaults", input: { student_id: i.student_id, ...("audience" in i ? { audience: b.audience } : {}), ...("channel" in i ? { channel: b.channel } : {}) } };
      },
    }),
    op({
      name: "messages.send",
      kind: "write",
      risk: "confirm",
      title: "Send or schedule a message from a student's composer to the parents (email) or the student (email or text).",
      doc: "{ student_id, audience: parent|student, channel: email|sms (parents: email), subject? ≤300 (email: required), body ≤20000 (text ≤320), kind?: message|referral|alert (parents only), schedule_for? ISO datetime, override_quiet_hours? bool }",
      input: z
        .object({
          student_id: uuid,
          audience: z.enum(AUDIENCE),
          channel: z.enum(CHANNEL),
          kind: z.enum(MESSAGE_KINDS).optional(),
          subject: z.string().trim().max(300).optional(),
          body: z.string().trim().min(1).max(20_000),
          schedule_for: isoDateTime.nullable().optional(),
          override_quiet_hours: z.boolean().optional(),
        })
        .strict()
        // The route refuses these too; checking here keeps a card that can only fail from being filed.
        .superRefine((i, ctx) => {
          if (i.audience === "parent" && i.channel !== "email") ctx.addIssue({ code: "custom", path: ["channel"], message: "Messages to the parents go by email" });
          if (i.channel === "email" && !i.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "An email needs a subject" });
          if (i.channel === "sms" && i.body.length > TEXT_LIMIT) ctx.addIssue({ code: "custom", path: ["body"], message: `Texts are kept under ${TEXT_LIMIT} characters` });
          if ((i.kind ?? "message") !== "message" && i.audience !== "parent") ctx.addIssue({ code: "custom", path: ["kind"], message: "That kind of message goes to the parents" });
        }),
      takesStudent: true,
      // Written by AxIS, so the row says so (ai_drafted), whatever the counselor dictated.
      request: (i) => ({
        method: "POST",
        url: messagesUrl(i.student_id),
        body: defined({
          audience: i.audience,
          channel: i.channel,
          kind: i.kind,
          subject: i.subject,
          body: i.body,
          scheduleFor: i.schedule_for,
          overrideQuietHours: i.override_quiet_hours,
          aiDrafted: true,
        }),
      }),
      describe: (i, h) => {
        const name = h.studentName(i.student_id);
        const what = i.kind === "alert" ? "an accountability alert" : i.kind === "referral" ? "the referral ask" : i.channel === "sms" ? "a text" : "an email";
        const to = i.audience === "parent" ? `${name}'s parents` : name;
        const subject = i.channel === "email" && i.subject ? `: "${plainText(i.subject, 80)}"` : "";
        return `${i.schedule_for ? "Schedule" : "Send"} ${what} to ${to}${i.schedule_for ? ` for ${whenLabel(i.schedule_for)}` : ""}${subject}`;
      },
      details: async (i, h) => {
        const raw = await h.get<Row>(composerUrl(i.student_id));
        const composer = raw ? asRecord(raw) : null;
        const quiet = asRecord(composer?.quietHours);
        const lines = [recipientsLine(i.audience, i.channel, composer, h.studentName(i.student_id)), `Channel: ${i.channel === "sms" ? "Text message" : "Email"}`];
        if (i.kind === "referral") lines.push("Kind: the post-application referral ask (tracked under Referrals)");
        if (i.kind === "alert") lines.push("Kind: accountability alert (counts toward the parent-alert throttle)");
        if (i.channel === "email") lines.push(`Subject: ${plainText(i.subject, 300)}`);
        if (i.schedule_for) lines.push(`When: ${whenLabel(i.schedule_for)}`);
        else if (quiet.now === true && !i.override_quiet_hours) lines.push(`When: inside quiet hours, so it waits until they end${quiet.resumesAt ? ` (${whenLabel(quiet.resumesAt)})` : ""}`);
        else lines.push(`When: now${i.override_quiet_hours ? " (even inside quiet hours)" : ""}`);
        lines.push(`Body: ${plainText(i.body, 1500)}`);
        return lines;
      },
      warning: "It goes to the family as written. A scheduled message can be cancelled until it goes out; a sent one can't be recalled.",
      reply: (body) => {
        const b = asRecord(body);
        const status = str(b.status);
        const said = status === "scheduled" ? `Scheduled for ${str(b.scheduledFor) ?? "later"}` : status === "sent" ? "Sent" : status === "failed" ? "It failed to send" : `Status ${status ?? "unknown"}`;
        return `${said} (message id ${str(b.id) ?? "unknown"}).`;
      },
      undo: (i, body) => {
        const b = asRecord(body);
        const id = str(b.id);
        return b.status === "scheduled" && id ? { op: "messages.cancel", input: { student_id: i.student_id, message_id: id } } : null;
      },
    }),
    op({
      name: "messages.cancel",
      kind: "write",
      risk: "confirm",
      title: "Cancel a scheduled composer message before it goes out.",
      doc: "{ student_id, message_id (messages.list, status scheduled) }",
      input: z.object({ student_id: uuid, message_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/communication/messages/${seg(i.message_id)}/cancel` }),
      describe: async (i, h) => `Cancel the scheduled ${messageLabel(await findIn(h, messagesUrl(i.student_id), i.message_id), h.studentName(i.student_id))}`,
      details: async (i, h) => {
        const m = await findIn(h, messagesUrl(i.student_id), i.message_id);
        return m?.body ? [`Body: ${plainText(m.body, 1500)}`] : [];
      },
      warning: "The message won't go out. Sending it later means writing it again.",
    }),
  ],
};

// ---- Family reports ------------------------------------------------------------------

const REPORT_STATUS = ["draft", "sent", "archived"] as const;
const REPORT_LABELS = { title: "Title", summary: "Summary", highlights: "Highlights", status: "Status" };

const findReport = (h: Get, id: string) => findIn(h, "/reports/family?limit=500", id);
const reportLabel = (r: Row | null) => (r ? `"${plainText(r.title, 80)}"` : "a family report");

/** The card lines for a report going to the family: recipients, subject, the whole body. */
function reportSendLines(report: Row | null, studentName: string, body?: string | null): string[] {
  const text = body ?? str(report?.body) ?? str(report?.summary) ?? "";
  return [
    `To: the family of ${studentName} (recorded only: Meridies doesn't deliver family reports)`,
    `Subject: ${report ? plainText(report.title, 300) : "this report"}`,
    `Body: ${text ? plainText(text, 1500) : "(empty)"}`,
  ];
}

export const familyReports: OpGroup = {
  heading: "Family reports",
  ops: [
    op({
      name: "reports.list",
      kind: "read",
      title: "Family reports with ids and status, for one student or the whole roster.",
      doc: "{ student_id?, status?: draft|sent|archived }",
      input: z.object({ student_id: uuid.optional(), status: z.enum(REPORT_STATUS).optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/reports/family${qs({ studentId: i.student_id, status: i.status })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (r) => `id ${str(r.id)}: ${str(r.date) ?? ""} [${str(r.status)}${r.kind ? `, ${str(r.kind)}` : ""}] ${untrusted(r.title)} · student ${str(r.studentId)}`,
          "No family reports."
        ),
    }),
    op({
      name: "reports.create",
      kind: "write",
      risk: "auto",
      title: "File a family report draft for approval (in Family reports, with an item on My Work Queue); nothing is sent.",
      doc: "{ student_id, subject? ≤200, body ≤20000 }",
      input: z
        .object({
          student_id: uuid,
          subject: z.string().trim().max(200).optional(),
          body: z.string().trim().min(1).max(20_000),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/communication/${seg(i.student_id)}/file-as-report`, body: defined({ subject: i.subject, body: i.body }) }),
      describe: (i, h) => `File a family report draft "${plainText(i.subject || "Family update", 80)}" for ${h.studentName(i.student_id)}'s family`,
      details: (i) => [`Body: ${plainText(i.body, 1500)}`, "Nothing is sent: it waits in Family reports for approval."],
      reply: (body) => {
        const b = asRecord(body);
        return `Filed as a draft (report id ${str(b.familyReportId) ?? "unknown"})${b.onWorkQueue ? ", with an approval item on My Work Queue" : ""}.`;
      },
      undo: (_i, body) => {
        const id = str(asRecord(body).familyReportId);
        return id ? { op: "reports.delete", input: { report_id: id } } : null;
      },
    }),
    op({
      name: "reports.update",
      kind: "write",
      risk: (i) => (i.status === "sent" || i.status === "archived" ? "confirm" : "auto"),
      title: "Edit a family report's title, summary, body or highlights (status sent or archived asks first).",
      doc: "{ report_id, title? ≤200, summary? ≤4000|null, body? ≤20000|null, highlights? [≤240, max 12], status?: draft|sent|archived }",
      input: z
        .object({
          report_id: uuid,
          title: z.string().trim().min(1).max(200).optional(),
          summary: z.string().trim().max(4000).nullable().optional(),
          body: z.string().trim().max(20_000).nullable().optional(),
          highlights: z.array(z.string().trim().max(240)).max(12).optional(),
          status: z.enum(REPORT_STATUS).optional(),
        })
        .strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/reports/family/${seg(i.report_id)}`,
        body: defined({ title: i.title, summary: i.summary, body: i.body, highlights: i.highlights, status: i.status }),
      }),
      describe: async (i, h) => {
        const r = await findReport(h, i.report_id);
        const who = r?.studentId ? ` for ${h.studentName(str(r.studentId))}'s family` : "";
        const only = Object.keys(i).filter((k) => k !== "report_id");
        if (only.length === 1 && i.status === "sent") return `Mark family report ${reportLabel(r)} as sent${who}`;
        if (only.length === 1 && i.status === "archived") return `Archive family report ${reportLabel(r)}${who}`;
        return `Update family report ${reportLabel(r)}${who}`;
      },
      details: async (i, h) => {
        const lines = changeLines(i, REPORT_LABELS);
        if (i.status === "sent") {
          const r = await findReport(h, i.report_id);
          return [...lines, ...reportSendLines(i.title && r ? { ...r, title: i.title } : r, h.studentName(str(r?.studentId)), i.body)];
        }
        if ("body" in i) lines.push(`Body: ${i.body ? plainText(i.body, 1500) : "cleared"}`);
        return lines;
      },
      warning: "Marking a report sent records that the family has it; archiving takes it out of the queue.",
      snapshot: (i, h) => findReport(h, i.report_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Row = { report_id: i.report_id };
        for (const k of ["title", "summary", "body", "highlights", "status"] as const) if (k in i) prev[k] = b[k] ?? null;
        if ("title" in prev && !prev.title) return null;
        if ("status" in prev && !prev.status) return null;
        if ("highlights" in prev && !Array.isArray(prev.highlights)) prev.highlights = [];
        return { op: "reports.update", input: prev };
      },
    }),
    op({
      name: "reports.mark_sent",
      kind: "write",
      risk: "confirm",
      title: "Record that a family report was sent to the family (Meridies doesn't deliver it).",
      doc: "{ report_id }",
      input: z.object({ report_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/reports/family/${seg(i.report_id)}/sent` }),
      describe: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return `Mark family report ${reportLabel(r)} as sent${r?.studentId ? ` to ${h.studentName(str(r.studentId))}'s family` : ""}`;
      },
      details: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return reportSendLines(r, h.studentName(str(r?.studentId)));
      },
      warning: "This records that the family has the report. Meridies doesn't send it; send it yourself first.",
      snapshot: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return r ? { status: r.status } : null;
      },
      undo: (i, _body, before) => {
        const prev = str(asRecord(before).status);
        return prev && prev !== "sent" && (REPORT_STATUS as readonly string[]).includes(prev) ? { op: "reports.update", input: { report_id: i.report_id, status: prev } } : null;
      },
    }),
    op({
      name: "reports.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a family report.",
      doc: "{ report_id }",
      input: z.object({ report_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/reports/family/${seg(i.report_id)}` }),
      describe: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return `Delete family report ${reportLabel(r)}${r?.studentId ? ` for ${h.studentName(str(r.studentId))}` : ""}`;
      },
      warning: "The report is deleted, with its approval item on My Work Queue.",
    }),
  ],
};

// ---- Narrative flags (the Coherence review queue) --------------------------------------

const FLAG_STATUS = ["open", "resolved", "dismissed"] as const;
const findFlag = (h: Get, id: string) => findIn(h, "/reports/flags?limit=500", id);
const flagLabel = (f: Row | null) => (f ? `"${plainText(f.title, 80)}"` : "a narrative flag");

export const narrativeFlags: OpGroup = {
  heading: "Narrative flags",
  ops: [
    op({
      name: "reports.list_flags",
      kind: "read",
      title: "Narrative flags from Coherence with ids, severity and status, for one student or the whole roster.",
      doc: "{ student_id?, status?: open|resolved|dismissed }",
      input: z.object({ student_id: uuid.optional(), status: z.enum(FLAG_STATUS).optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/reports/flags${qs({ studentId: i.student_id, status: i.status })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (f) => `id ${str(f.id)}: [${str(f.severity)}, ${str(f.status)}${f.sharedWithStudent ? ", shared with the student" : ""}] ${untrusted(f.title)} · student ${str(f.studentId)}`,
          "No narrative flags."
        ),
    }),
    op({
      name: "reports.update_flag",
      kind: "write",
      risk: (i) => (i.shared_with_student === true ? "confirm" : "auto"),
      title: "Resolve, dismiss or reopen a narrative flag, or share it with the student (sharing asks first).",
      doc: "{ flag_id, status?: open|resolved|dismissed, shared_with_student? bool }",
      input: z
        .object({ flag_id: uuid, status: z.enum(FLAG_STATUS).optional(), shared_with_student: z.boolean().optional() })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/reports/flags/${seg(i.flag_id)}`, body: defined({ status: i.status, sharedWithStudent: i.shared_with_student }) }),
      describe: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        const who = f?.studentId ? ` for ${h.studentName(str(f.studentId))}` : "";
        if (i.shared_with_student === true) return `Share narrative flag ${flagLabel(f)} with ${f?.studentId ? h.studentName(str(f.studentId)) : "the student"}`;
        const verb = i.status === "resolved" ? "Resolve" : i.status === "dismissed" ? "Dismiss" : i.status === "open" ? "Reopen" : "Update";
        return `${verb} narrative flag ${flagLabel(f)}${who}`;
      },
      details: (i) => {
        const lines = changeLines(i, { status: "Status" });
        if (i.shared_with_student !== undefined) lines.push(i.shared_with_student ? "The student: sees this flag" : "The student: no longer sees this flag");
        return lines;
      },
      warning: "A shared flag shows on the student's side.",
      snapshot: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        return f ? { status: f.status, sharedWithStudent: f.sharedWithStudent === true } : null;
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.status) return null;
        const prev: Row = { flag_id: i.flag_id };
        if ("status" in i) prev.status = b.status;
        if ("shared_with_student" in i) prev.shared_with_student = b.sharedWithStudent === true;
        return { op: "reports.update_flag", input: prev };
      },
    }),
    op({
      name: "reports.delete_flag",
      kind: "write",
      risk: "confirm",
      title: "Delete a narrative flag.",
      doc: "{ flag_id }",
      input: z.object({ flag_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/reports/flags/${seg(i.flag_id)}` }),
      describe: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        return `Delete narrative flag ${flagLabel(f)}${f?.studentId ? ` for ${h.studentName(str(f.studentId))}` : ""}`;
      },
      warning: "The flag is deleted rather than resolved; nothing records it was ever raised.",
    }),
  ],
};

// ---- Email blasts ----------------------------------------------------------------------

const BLAST_AUDIENCES = ["roster", "class-year", "school", "status", "selection"] as const;
type BlastInput = { audience_kind: (typeof BLAST_AUDIENCES)[number]; audience_value?: string; student_ids?: string[] };

/** "the Class of 2027 (14 students)", from the same counts the popup shows. */
async function audienceLabel(i: BlastInput, h: Get): Promise<string> {
  const a = asRecord(await h.get("/blasts/audiences"));
  const v = i.audience_value ?? "";
  const count = (list: unknown, match: (value: string) => boolean) => {
    const hit = asArray(list).find((r) => match(String(r.value ?? "")));
    return hit ? ` (${Number(hit.count)} students)` : Object.keys(a).length ? " (no students found)" : "";
  };
  switch (i.audience_kind) {
    case "roster":
      return `the entire roster${typeof a.rosterCount === "number" ? ` (${a.rosterCount} students)` : ""}`;
    case "class-year":
      return `the Class of ${plainText(v, 20)}${count(a.classYears, (x) => x === v)}`;
    case "school":
      return `students applying to ${plainText(v, 100)}${count(a.schools, (x) => x.toLowerCase() === v.toLowerCase())}`;
    case "status":
      return `students with a school at "${plainText(v, 60)}"${count(a.statuses, (x) => x === v)}`;
    case "selection":
      return `${(i.student_ids ?? []).length} selected students`;
  }
}

export const blasts: OpGroup = {
  heading: "Email blasts",
  ops: [
    op({
      name: "blasts.audiences",
      kind: "read",
      title: "Who a blast can go to right now: the roster, class years, schools applied to and application statuses, with counts.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/blasts/audiences" }),
      reply: (body) => {
        const a = asRecord(body);
        const list = (rows: unknown, safe: boolean) =>
          asArray(rows)
            .slice(0, 60)
            .map((r) => `${safe ? str(r.value) : untrusted(r.value)} (${str(r.count) ?? "0"})`)
            .join(", ") || "none";
        return [
          `roster: the entire roster (${str(a.rosterCount) ?? "0"} students)`,
          `class-year (audience_value): ${list(a.classYears, true)}`,
          `school (audience_value, the school's name): ${list(a.schools, false)}`,
          `status (audience_value): ${list(a.statuses, true)}`,
          "selection: pass student_ids instead.",
        ].join("\n");
      },
    }),
    op({
      name: "blasts.send",
      kind: "write",
      risk: "confirm",
      title: "Email a blast to students now: the roster, a class year, a school's applicants, a status, or picked students.",
      doc: "{ audience_kind: roster|class-year|school|status|selection, audience_value? ≤200 (class-year, school, status), student_ids? [≤500] (selection), subject ≤300, body ≤20000 }",
      input: z
        .object({
          audience_kind: z.enum(BLAST_AUDIENCES),
          audience_value: z.string().trim().max(200).optional(),
          student_ids: z.array(uuid).max(500).optional(),
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
        })
        .strict()
        // The route refuses these too; checking here keeps a card that can only fail from being filed.
        .superRefine((i, ctx) => {
          if ((i.audience_kind === "class-year" || i.audience_kind === "school" || i.audience_kind === "status") && !i.audience_value) {
            ctx.addIssue({ code: "custom", path: ["audience_value"], message: `Pick a ${i.audience_kind === "class-year" ? "class year" : i.audience_kind === "school" ? "school" : "status"} (blasts.audiences)` });
          }
          if (i.audience_kind === "selection" && !(i.student_ids ?? []).length) ctx.addIssue({ code: "custom", path: ["student_ids"], message: "Pick at least one student" });
        }),
      request: (i) => ({
        method: "POST",
        url: "/blasts",
        body: defined({ audienceKind: i.audience_kind, audienceValue: i.audience_value, studentIds: i.student_ids, subject: i.subject, body: i.body }),
      }),
      describe: async (i, h) => `Email blast to ${await audienceLabel(i, h)}: "${plainText(i.subject, 80)}"`,
      details: async (i, h) => {
        const lines = [`To: students — ${await audienceLabel(i, h)}; anyone without an email address on file is skipped, and parents aren't copied`];
        if (i.audience_kind === "selection" && i.student_ids?.length) {
          const names = i.student_ids.slice(0, 15).map((id) => h.studentName(id));
          lines.push(`Students: ${names.join(", ")}${i.student_ids.length > 15 ? `, and ${i.student_ids.length - 15} more` : ""}`);
        }
        lines.push(`Subject: ${plainText(i.subject, 300)}`, `Body: ${plainText(i.body, 1500)}`, 'Each email opens with "Hi <first name>," and is signed as sent by you through Meridies.');
        return lines;
      },
      warning: "Every student in the audience with an email address gets it now; a blast can't be recalled.",
      reply: (body) => {
        const b = asRecord(body);
        return `Blast ${str(b.status) ?? "sent"}: ${str(b.deliveredCount) ?? "0"} delivered to the provider, ${str(b.failedCount) ?? "0"} failed, ${str(b.skipped) ?? "0"} skipped (blast id ${str(b.id) ?? "unknown"}).`;
      },
    }),
  ],
};

// ---- Email templates -----------------------------------------------------------------

const TEMPLATE_SETS = ["families", "staff"] as const;
type Template = { id?: string; set?: string; slug?: string | null; name?: string; subject?: string; body?: string };

async function findTemplate(h: Get, id: string): Promise<Template | null> {
  for (const set of TEMPLATE_SETS) {
    const hit = await findIn(h, `/email-templates?set=${set}`, id);
    if (hit) return hit as Template;
  }
  return null;
}

/** "Save template" with a subject that already exists rewrites that template in place (routes/emailTemplates.ts). */
async function sameSubject(h: Get, set: string, subject: string): Promise<Template | null | undefined> {
  if (!subject.trim()) return null;
  const rows = await h.get<unknown[]>(`/email-templates?set=${set}`);
  if (!rows) return undefined;
  return (asArray(rows).find((t) => String(t.subject ?? "").trim() === subject.trim()) as Template | undefined) ?? null;
}

const templateLabel = (t: Template | null) => (t ? `"${plainText(t.name, 80)}"` : "an email template");

export const emailTemplates: OpGroup = {
  heading: "Email templates",
  ops: [
    op({
      name: "templates.list",
      kind: "read",
      title: "The counselor's email templates with ids (families or staff set); with template_id, that template's full text too.",
      doc: "{ set?: families|staff (default families), template_id? }",
      input: z.object({ set: z.enum(TEMPLATE_SETS).optional(), template_id: uuid.optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/email-templates${qs({ set: i.set ?? "families" })}` }),
      reply: (body, i) => {
        const rows = asArray(body);
        const line = (t: Row) => `id ${str(t.id)}: ${untrusted(t.name, "template")} · subject ${untrusted(t.subject, "template")}${t.slug ? ` · used by the Contact Pipeline (${str(t.slug)})` : ""}`;
        if (i.template_id) {
          const t = rows.find((r) => r.id === i.template_id);
          if (!t) return `That template isn't in the ${i.set ?? "families"} set; try the other set.`;
          return `${line(t)}\nbody: ${wrapUntrusted("template", String(t.body ?? "").slice(0, 4000))}\n({first} is the recipient's first name and {me} the counselor's.)`;
        }
        return listReply(rows, line, "No templates in this set.");
      },
    }),
    op({
      name: "templates.create",
      kind: "write",
      risk: "auto",
      title: "Save an email template; one with the same subject in that set is rewritten. Placeholders {first} and {me}.",
      doc: "{ set: families|staff, subject ≤300, body ≤20000, name? ≤200 }",
      input: z
        .object({
          set: z.enum(TEMPLATE_SETS),
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().max(300),
          body: z.string().max(20_000),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/email-templates", body: defined({ set: i.set, name: i.name, subject: i.subject, body: i.body }) }),
      describe: async (i, h) => {
        const existing = await sameSubject(h, i.set, i.subject);
        return existing
          ? `Rewrite email template ${templateLabel(existing)} (same subject)`
          : `Save a new ${i.set === "staff" ? "staff" : "families"} email template "${plainText(i.name || i.subject || "Untitled template", 80)}"`;
      },
      details: (i) => [...changeLines(i, { name: "Name", subject: "Subject" }), `Body: ${plainText(i.body, 1500)}`],
      snapshot: async (i, h) => {
        const existing = await sameSubject(h, i.set, i.subject);
        return existing === undefined ? null : { existing: existing ? { id: existing.id, name: existing.name, body: existing.body } : null };
      },
      undo: (i, body, before) => {
        if (!before) return null;
        const existing = asRecord(asRecord(before).existing);
        if (existing.id) {
          return {
            op: "templates.update",
            input: { template_id: existing.id, body: String(existing.body ?? ""), ...(i.name && existing.name ? { name: existing.name } : {}) },
          };
        }
        const id = idOf(body);
        return id ? { op: "templates.delete", input: { template_id: id } } : null;
      },
    }),
    op({
      name: "templates.update",
      kind: "write",
      risk: "auto",
      title: "Rename an email template, or rewrite its subject or body.",
      doc: "{ template_id, name? ≤200, subject? ≤300, body? ≤20000 }",
      input: z
        .object({
          template_id: uuid,
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().max(300).optional(),
          body: z.string().max(20_000).optional(),
        })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/email-templates/${seg(i.template_id)}`, body: defined({ name: i.name, subject: i.subject, body: i.body }) }),
      describe: async (i, h) => {
        const t = await findTemplate(h, i.template_id);
        const only = Object.keys(i).filter((k) => k !== "template_id");
        return only.length === 1 && i.name ? `Rename email template ${templateLabel(t)} to "${plainText(i.name, 80)}"` : `Update email template ${templateLabel(t)}`;
      },
      details: (i) => [...changeLines(i, { name: "Name", subject: "Subject" }), ...("body" in i ? [`Body: ${plainText(i.body, 1500)}`] : [])],
      snapshot: (i, h) => findTemplate(h, i.template_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Row = { template_id: i.template_id };
        if ("name" in i) prev.name = str(b.name);
        if ("subject" in i) prev.subject = String(b.subject ?? "");
        if ("body" in i) prev.body = String(b.body ?? "");
        if ("name" in prev && !prev.name) return null;
        return { op: "templates.update", input: prev };
      },
    }),
    op({
      name: "templates.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete an email template (the Contact Pipeline's Follow-up and Contract proposal can only be rewritten).",
      doc: "{ template_id }",
      input: z.object({ template_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/email-templates/${seg(i.template_id)}` }),
      describe: async (i, h) => `Delete email template ${templateLabel(await findTemplate(h, i.template_id))}`,
      warning: "The template is deleted.",
      snapshot: (i, h) => findTemplate(h, i.template_id),
      undo: (_i, _body, before) => {
        const b = asRecord(before) as Template;
        if (!b.id || (b.set !== "families" && b.set !== "staff")) return null;
        return { op: "templates.create", input: { set: b.set, ...(b.name ? { name: b.name.slice(0, 200) } : {}), subject: String(b.subject ?? ""), body: String(b.body ?? "") } };
      },
    }),
  ],
};

// ---- Notifications ---------------------------------------------------------------------

const NOTIFICATION_KINDS = ["deadline", "red-flag", "report", "invite", "ai", "policy", "scholarship", "aid", "opportunity", "system"] as const;

/** A red flag's text is not for the model; the rest are labels Meridies wrote. */
const notificationTitle = (n: Row) => (n.kind === "red-flag" ? "(a red flag; open it in Meridies)" : untrusted(n.title, "notification"));

export const notifications: OpGroup = {
  heading: "Notifications",
  ops: [
    op({
      name: "notifications.list",
      kind: "read",
      title: "The counselor's notifications (the bell) with ids, newest first; optionally unread only, one kind or one student.",
      doc: "{ unread? bool, kind?: deadline|red-flag|report|invite|ai|policy|scholarship|aid|opportunity|system, student_id?, limit? 1-200 }",
      input: z
        .object({
          unread: z.boolean().optional(),
          kind: z.enum(NOTIFICATION_KINDS).optional(),
          student_id: uuid.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
      // The route coerces any `unread` value to true, so only send it when it is.
      request: (i) => ({ method: "GET", url: `/notifications${qs({ unread: i.unread ? "true" : undefined, kind: i.kind, studentId: i.student_id, limit: i.limit })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (n) =>
            `id ${str(n.id)}: ${str(n.createdAt)?.slice(0, 10) ?? ""} [${str(n.kind)}, ${str(n.urgency)}${n.readAt ? "" : ", unread"}] ${notificationTitle(n)}${n.studentId ? ` · student ${str(n.studentId)}` : ""}`,
          "No notifications."
        ),
    }),
    op({
      name: "notifications.mark_read",
      kind: "write",
      risk: "auto",
      title: "Mark one notification read.",
      doc: "{ notification_id }",
      input: z.object({ notification_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/notifications/${seg(i.notification_id)}/read` }),
      describe: async (i, h) => {
        const n = await findIn(h, "/notifications?limit=200", i.notification_id);
        return n && n.kind !== "red-flag" ? `Mark notification "${plainText(n.title, 80)}" read` : "Mark a notification read";
      },
      reply: () => "Marked read.",
    }),
    op({
      name: "notifications.mark_all_read",
      kind: "write",
      risk: "auto",
      title: "Mark every unread notification read.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "POST", url: "/notifications/read-all", body: {} }),
      describe: async (_i, h) => {
        const c = asRecord(await h.get("/notifications/unread-count"));
        return typeof c.unread === "number" ? `Mark all ${c.unread} unread notifications read` : "Mark all notifications read";
      },
      reply: (body) => `Marked ${str(asRecord(body).read) ?? "0"} notifications read.`,
    }),
  ],
};
