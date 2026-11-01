/**
 * Talking to families and keeping the record of it: a student's
 * Communication composer (routes/communication.ts), Email blasts
 * (routes/blasts.ts), the counselor's Email templates
 * (routes/emailTemplates.ts), the in-app Notifications bell
 * (routes/notifications.ts), and Family reports with the Coherence review
 * queue's narrative flags (routes/reports.ts).
 *
 * Everything that sends or schedules asks first, and its card shows who it
 * goes to (as the route will resolve them), the subject and the whole body,
 * line breaks kept: a composer message, a blast, a program send, a report
 * recorded as sent. The routes decide recipients, quiet hours and throttles;
 * these operations pass the request through and never pick an address. A body
 * is capped below the route's limit so the whole of it fits on the card.
 * Filing a draft report, editing a template and the composer's defaults run at
 * once. Anything a student or family may already see (a family report once
 * sent, a flag's sharing) asks, as do archiving, deleting, cancelling and
 * marking notifications read (there is no way to mark them unread again).
 *
 * Replies name messages, reports, templates and notifications; they never
 * carry an address, a phone number, a message body or a report body, and a
 * narrative flag is named by its severity, never its Coherence text (not on
 * the AI allowlist), in replies and card lines alike. AxIS drafting (the
 * composer's and the templates') and anything that calls a model stay out:
 * those are the counselor's clicks in the app.
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

/** A body that fits the card whole: run.ts keeps 12 lines of 1600 characters, so each piece stays under that. */
const CARD_PIECE = 1500;

/** The whole text for the card, line breaks kept (the card shows them), in pieces the card holds. */
function bodyLines(text: unknown, label = "Body", maxLines = 8): string[] {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [`${label}: (empty)`];
  const out: string[] = [];
  let rest = clean;
  while (rest && out.length < maxLines) {
    let cut = rest.length;
    if (cut > CARD_PIECE) {
      cut = rest.lastIndexOf("\n", CARD_PIECE);
      if (cut < CARD_PIECE / 2) cut = rest.lastIndexOf(" ", CARD_PIECE);
      if (cut < CARD_PIECE / 2) cut = CARD_PIECE;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  const lines = out.map((t, k) => `${k === 0 ? label : `${label} (continued)`}: ${t}`);
  if (rest) lines.push(`${label} (not shown): ${rest.length} more characters; read it in Meridies before confirming`);
  return lines;
}

/** Templates fill these; a message or a blast goes out exactly as written, so a placeholder would reach the family as is. */
const PLACEHOLDER = /\{(first|me)\}/i;

// ---- The composer ------------------------------------------------------------------

const AUDIENCE = ["parent", "student"] as const;
const CHANNEL = ["email", "sms"] as const;
const MESSAGE_KINDS = ["message", "referral", "alert"] as const;
/** routes/communication.ts TEXT_LIMIT: texts are kept to two segments. */
const TEXT_LIMIT = 320;
/** Below the route's 20,000 so the card can show the whole body (and its stored row stays under the 32 KB cap). */
const MESSAGE_MAX = 5000;

const composerUrl = (studentId: string) => `/communication/${seg(studentId)}/composer`;
const messagesUrl = (studentId: string) => `/communication/${seg(studentId)}/messages`;

/**
 * Who the route will write to, from the composer's own family list and the
 * student's alert preferences: names and addresses, for the counselor's card
 * only (lib/studentMessages.ts resolveRecipients makes the same choice).
 */
function recipientsLine(
  audience: (typeof AUDIENCE)[number],
  channel: (typeof CHANNEL)[number],
  composer: Row | null,
  alertPrefs: Row | null,
  studentName: string
): string {
  if (audience === "parent") {
    if (alertPrefs && alertPrefs.copyParents === false) {
      return "To: Parents — messages to the parents are switched off for this student, so Meridies will refuse it";
    }
    if (!composer) return "To: Parents — every guardian on file who receives messages and has an email address";
    const family = asArray(composer.family);
    const reachable = family.filter((g) => g.receivesMessages === true && str(g.email));
    const left = family.filter((g) => !(g.receivesMessages === true && str(g.email)));
    if (!reachable.length) {
      return "To: Parents — nobody on file can receive it, so Meridies will refuse it (add a parent with an email address first)";
    }
    return `To: Parents — ${reachable.map((g) => `${plainText(g.name, 60)} <${plainText(g.email, 120)}>`).join(", ")}${
      left.length ? `; not ${left.map((g) => plainText(g.name, 60)).join(", ")} (opted out or no email address)` : ""
    }`;
  }
  const s = asRecord(composer?.student);
  const address = channel === "sms" ? str(s.phone) : str(s.email);
  const who = plainText(str(s.name) ?? studentName, 80);
  if (composer && !address) {
    return `To: Student — ${who}; no ${channel === "sms" ? "phone number" : "email address"} on file, so Meridies will refuse it`;
  }
  return `To: Student — ${who}${address ? ` <${plainText(address, 120)}>` : ""} (${channel === "sms" ? "by text" : "by email"})`;
}

const messageLabel = (m: Row | null, studentName: string) => {
  if (!m) return `scheduled message that isn't on ${studentName}'s Communication page`;
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
      outside: false,
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
      doc: "{ student_id, audience: parent|student, channel: email|sms (parents: email), subject? ≤300 (email: required), body ≤5000 (text ≤320), kind?: message|referral|alert (parents only), schedule_for? ISO datetime, override_quiet_hours? bool }",
      input: z
        .object({
          student_id: uuid,
          audience: z.enum(AUDIENCE),
          channel: z.enum(CHANNEL),
          kind: z.enum(MESSAGE_KINDS).optional(),
          subject: z.string().trim().max(300).optional(),
          body: z.string().trim().min(1).max(MESSAGE_MAX),
          schedule_for: isoDateTime.nullable().optional(),
          override_quiet_hours: z.boolean().optional(),
        })
        .strict()
        // Exact copies of the route's own refusals (POST /communication/:id/messages), so a card that can only fail is never filed.
        .superRefine((i, ctx) => {
          if (i.audience === "parent" && i.channel !== "email") ctx.addIssue({ code: "custom", path: ["channel"], message: "Messages to the parents go by email" });
          if (i.channel === "email" && !i.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Add a subject first" });
          if (i.channel === "sms" && i.body.length > TEXT_LIMIT) ctx.addIssue({ code: "custom", path: ["body"], message: `Texts are kept under ${TEXT_LIMIT} characters` });
          if ((i.kind ?? "message") !== "message" && i.audience !== "parent") ctx.addIssue({ code: "custom", path: ["kind"], message: "That kind of message goes to the parents" });
        })
        // Ours, not the route's: nothing fills a template's placeholders here.
        .superRefine((i, ctx) => {
          for (const k of ["subject", "body"] as const) {
            if (PLACEHOLDER.test(i[k] ?? "")) ctx.addIssue({ code: "custom", path: [k], message: "Replace {first} and {me} with the real names: the message goes out exactly as written" });
          }
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
        const [raw, prefs] = await Promise.all([
          h.get<Row>(composerUrl(i.student_id)),
          i.audience === "parent" ? h.get<Row>(`/accountability/alert-prefs${qs({ studentId: i.student_id })}`) : Promise.resolve(null),
        ]);
        const composer = raw ? asRecord(raw) : null;
        const quiet = asRecord(composer?.quietHours);
        const lines = [
          recipientsLine(i.audience, i.channel, composer, prefs ? asRecord(prefs) : null, h.studentName(i.student_id)),
          `Channel: ${i.channel === "sms" ? "Text message" : "Email"}`,
        ];
        if (i.kind === "referral") lines.push("Kind: the post-application referral ask (tracked under Referrals)");
        if (i.kind === "alert") lines.push("Kind: accountability alert (counts toward the parent-alert throttle)");
        if (i.channel === "email") lines.push(`Subject: ${plainText(i.subject, 300)}`);
        if (i.schedule_for) lines.push(`When: ${whenLabel(i.schedule_for)} (if that time has passed when you confirm, it goes out at once, or when quiet hours end)`);
        else if (quiet.now === true && !i.override_quiet_hours) lines.push(`When: inside quiet hours, so it waits until they end${quiet.resumesAt ? ` (${whenLabel(quiet.resumesAt)})` : ""}`);
        else lines.push(`When: now${i.override_quiet_hours ? " (even inside quiet hours)" : ""}`);
        return [...lines, ...bodyLines(i.body)];
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
      describe: async (i, h) => `Cancel the ${messageLabel(await findIn(h, messagesUrl(i.student_id), i.message_id), h.studentName(i.student_id))}`,
      details: async (i, h) => {
        const m = await findIn(h, messagesUrl(i.student_id), i.message_id);
        if (!m) return [];
        const to = asArray(m.recipients).map((r) => plainText(r.name, 60)).filter(Boolean);
        return [...(to.length ? [`To: ${to.join(", ")}`] : []), ...(m.status !== "scheduled" ? [`Status: ${str(m.status)} (only a scheduled message can be cancelled)`] : []), ...bodyLines(m.body, "Body", 4)];
      },
      warning: "The message won't go out. Sending it later means writing it again.",
    }),
  ],
};

// ---- Family reports ------------------------------------------------------------------

const REPORT_STATUS = ["draft", "sent", "archived"] as const;
/** Below the route's 20,000 so the card can show the whole body. */
const REPORT_MAX = 6000;

const findReport = (h: Get, id: string) => findIn(h, "/reports/family?limit=500", id);
const reportLabel = (r: Row | null) => (r ? `"${plainText(r.title, 80)}"` : "(not found among your roster's family reports)");

/** The family's side of a report recorded as sent: who reads it, and how. */
const reportAudience = (studentName: string) =>
  `To: the family of ${studentName}. Meridies doesn't deliver family reports; once it is marked sent, ${studentName} can read it in Meridies`;

export const familyReports: OpGroup = {
  heading: "Family reports",
  ops: [
    op({
      name: "reports.list",
      kind: "read",
      outside: true,
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
      doc: "{ student_id, subject? ≤200, body ≤8000 }",
      input: z
        .object({
          student_id: uuid,
          subject: z.string().trim().max(200).optional(),
          body: z.string().trim().min(1).max(8000),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/communication/${seg(i.student_id)}/file-as-report`, body: defined({ subject: i.subject, body: i.body }) }),
      describe: (i, h) => `File a family report draft "${plainText(i.subject || "Family update", 80)}" for ${h.studentName(i.student_id)}'s family`,
      details: (i) => [...bodyLines(i.body, "Body", 6), "Nothing is sent: it waits in Family reports for approval."],
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
      // A sent report is on the student's side and an input can't tell whether this one is: every edit asks.
      risk: "confirm",
      title: "Edit a family report's title, summary, body or highlights, or archive it (record a send with reports.mark_sent).",
      doc: "{ report_id, title? ≤200, summary? ≤4000|null, body? ≤6000|null, highlights? [≤240, max 12], status?: draft|archived }",
      input: z
        .object({
          report_id: uuid,
          title: z.string().trim().min(1).max(200).optional(),
          summary: z.string().trim().max(4000).nullable().optional(),
          body: z.string().trim().max(REPORT_MAX).nullable().optional(),
          highlights: z.array(z.string().trim().max(240)).max(12).optional(),
          // "sent" stays valid so an Undo can put a sent report back; the doc steers a send to reports.mark_sent.
          status: z.enum(REPORT_STATUS).optional(),
        })
        .strict()
        .refine((i) => Object.keys(i).some((k) => k !== "report_id"), { message: "Nothing to update" }),
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
        const r = await findReport(h, i.report_id);
        const name = h.studentName(str(r?.studentId));
        const lines: string[] = [];
        if (r) lines.push(`Now: ${str(r.status)}`);
        if (i.status === "sent") lines.push(reportAudience(name));
        else if (r?.status === "sent" && i.status === "archived") lines.push(`The student: ${name} no longer sees it`);
        else if (r?.status === "sent") lines.push(`The student: ${name} already sees this report, and sees the change`);
        lines.push(...changeLines(i, { title: "Title", status: "Status" }));
        if (i.highlights) lines.push(`Highlights: ${i.highlights.map((x) => plainText(x, 240)).join(" · ")}`);
        if ("summary" in i) lines.push(...(i.summary ? bodyLines(i.summary, "Summary", 3) : ["Summary: cleared"]));
        if ("body" in i) lines.push(...(i.body ? bodyLines(i.body, "Body", 4) : ["Body: cleared"]));
        else if (i.status === "sent") lines.push(...bodyLines(r?.body || r?.summary, "Body", 5));
        return lines;
      },
      warning: "The family sees a report once it is sent: this may change what they read, or take it away.",
      snapshot: (i, h) => findReport(h, i.report_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Row = { report_id: i.report_id };
        for (const k of ["title", "summary", "body", "highlights", "status"] as const) if (k in i) prev[k] = b[k] ?? null;
        // The list serializes a missing summary or body as "": put back the null it was.
        for (const k of ["summary", "body"] as const) if (prev[k] === "") prev[k] = null;
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
      title: "Record that a family report was sent to the family (Meridies doesn't deliver it; the student can then read it).",
      doc: "{ report_id }",
      input: z.object({ report_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/reports/family/${seg(i.report_id)}/sent` }),
      describe: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return `Mark family report ${reportLabel(r)} as sent${r?.studentId ? ` to ${h.studentName(str(r.studentId))}'s family` : ""}`;
      },
      details: async (i, h) => {
        const r = await findReport(h, i.report_id);
        if (!r) return ["Report: not found among your roster's family reports"];
        return [
          reportAudience(h.studentName(str(r.studentId))),
          `Subject: ${plainText(r.title, 300)}`,
          ...(r.summary ? bodyLines(r.summary, "Summary", 3) : []),
          ...bodyLines(r.body, "Body", 6),
        ];
      },
      warning: "This records that the family has the report, and the student can read it in Meridies. Meridies doesn't send it; send it yourself first.",
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
      details: async (i, h) => {
        const r = await findReport(h, i.report_id);
        return r ? [`Status: ${str(r.status)}${r.status === "sent" ? " (the student can read it now; it goes from their side too)" : ""}`] : [];
      },
      warning: "The report is deleted, with its approval item on My Work Queue.",
    }),
  ],
};

// ---- Narrative flags (the Coherence review queue) --------------------------------------

const FLAG_STATUS = ["open", "resolved", "dismissed"] as const;
const findFlag = (h: Get, id: string) => findIn(h, "/reports/flags?limit=500", id);
/** A flag's Coherence text is a reading of the student's application, off the AI allowlist: card lines name its severity only. */
const flagLabel = (f: Row | null) => (f ? `a ${str(f.severity) ?? "narrative"}-severity narrative flag` : "a narrative flag that isn't on your roster");
/** The flag's own words, for the counselor's card details only. */
const flagDetails = (f: Row | null) => (f ? [`Flag: ${plainText(f.title, 200)}`, ...(f.detail ? [`Detail: ${plainText(f.detail, 600)}`] : [])] : []);

export const narrativeFlags: OpGroup = {
  heading: "Narrative flags",
  ops: [
    op({
      name: "reports.list_flags",
      kind: "read",
      outside: true,
      title: "Narrative flags from Coherence with ids, severity, status and sharing (not their text), for one student or the roster.",
      doc: "{ student_id?, status?: open|resolved|dismissed }",
      input: z.object({ student_id: uuid.optional(), status: z.enum(FLAG_STATUS).optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/reports/flags${qs({ studentId: i.student_id, status: i.status })}` }),
      // Ids, severity and status are what acting on a flag needs; its text stays in the app (the counselor reads it on the card).
      reply: (body) =>
        listReply(
          asArray(body),
          (f) => `id ${str(f.id)}: [${str(f.severity)}, ${str(f.status)}${f.sharedWithStudent ? ", shared with the student" : ""}] · student ${str(f.studentId)}`,
          "No narrative flags."
        ),
    }),
    op({
      name: "reports.update_flag",
      kind: "write",
      // Sharing shows it to the student; unsharing takes it away from them.
      risk: (i) => (i.shared_with_student !== undefined ? "confirm" : "auto"),
      title: "Resolve, dismiss or reopen a narrative flag, or share it with the student or stop (sharing either way asks first).",
      doc: "{ flag_id, status?: open|resolved|dismissed, shared_with_student? bool }",
      input: z
        .object({ flag_id: uuid, status: z.enum(FLAG_STATUS).optional(), shared_with_student: z.boolean().optional() })
        .strict()
        .refine((i) => i.status !== undefined || i.shared_with_student !== undefined, { message: "Nothing to update" }),
      request: (i) => ({ method: "PATCH", url: `/reports/flags/${seg(i.flag_id)}`, body: defined({ status: i.status, sharedWithStudent: i.shared_with_student }) }),
      describe: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        const student = f?.studentId ? h.studentName(str(f.studentId)) : "the student";
        if (i.shared_with_student === true) return `Share ${flagLabel(f)} with ${student}`;
        if (i.shared_with_student === false) return `Stop sharing ${flagLabel(f)} with ${student}`;
        const verb = i.status === "resolved" ? "Resolve" : i.status === "dismissed" ? "Dismiss" : "Reopen";
        return `${verb} ${flagLabel(f)} for ${student}`;
      },
      details: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        const lines = [...flagDetails(f), ...changeLines(i, { status: "Status" })];
        if (i.shared_with_student !== undefined) lines.push(i.shared_with_student ? "The student: sees this flag" : "The student: no longer sees this flag");
        return lines;
      },
      warning: "Sharing shows the flag on the student's side; unsharing takes it away.",
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
        return `Delete ${flagLabel(f)}${f?.studentId ? ` for ${h.studentName(str(f.studentId))}` : ""}`;
      },
      details: async (i, h) => flagDetails(await findFlag(h, i.flag_id)),
      warning: "The flag is deleted rather than resolved; nothing records it was ever raised.",
    }),
  ],
};

// ---- Email blasts ----------------------------------------------------------------------

const BLAST_AUDIENCES = ["roster", "class-year", "school", "status", "selection"] as const;
type BlastInput = { audience_kind: (typeof BLAST_AUDIENCES)[number]; audience_value?: string; student_ids?: string[] };
/** Kept under the route's 500 so the card and the stored row hold the whole selection. */
const BLAST_SELECTION_MAX = 200;

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

/**
 * The people a roster, class-year or selection blast reaches, by name, from
 * the counselor's roster (GET /students, the rows routes/blasts.ts reads).
 * A school or status audience is counted only: which students those are is
 * the route's query over every college list.
 */
async function blastPeople(i: BlastInput, h: OpHelpers): Promise<string[]> {
  if (i.audience_kind === "school" || i.audience_kind === "status") return [];
  const roster = await h.get<unknown[]>("/students");
  if (!Array.isArray(roster)) return [];
  const rows = asArray(roster);
  const picked =
    i.audience_kind === "class-year"
      ? rows.filter((r) => String(asRecord(r.profile).gradYear ?? "").trim() === (i.audience_value ?? ""))
      : i.audience_kind === "selection"
        ? (i.student_ids ?? []).map((id) => rows.find((r) => r.id === id) ?? { id, missing: true })
        : rows;
  const names = (list: Row[]) => {
    const shown = list.slice(0, 40).map((r) => (r.missing ? `${h.studentName(str(r.id))} (not on your roster)` : plainText(r.fullName, 60)));
    return `${shown.join(", ")}${list.length > 40 ? `, and ${list.length - 40} more` : ""}`;
  };
  const missing = picked.filter((r) => r.missing);
  const reach = picked.filter((r) => !r.missing && str(r.email));
  const skip = picked.filter((r) => !r.missing && !str(r.email));
  return [
    ...(reach.length ? [`Students: ${names(reach)}`] : []),
    ...(skip.length ? [`Skipped (no email address on file): ${names(skip)}`] : []),
    ...(missing.length ? [`Not on your roster, so Meridies will refuse the blast: ${names(missing)}`] : []),
  ];
}

export const blasts: OpGroup = {
  heading: "Email blasts",
  ops: [
    op({
      name: "blasts.audiences",
      kind: "read",
      // Class years and school names on the list are the students' own text (student_colleges.name,
      // profiles.grad_year): reading them is outside content, whenever there are any.
      outside: (body) => asArray(asRecord(body).schools).length > 0 || asArray(asRecord(body).classYears).length > 0,
      title: "Who a blast can go to right now: the roster, class years, schools applied to and application statuses, with counts.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/blasts/audiences" }),
      reply: (body) => {
        const a = asRecord(body);
        // Class years and school names are typed text; statuses are the college list's fixed set.
        const list = (rows: unknown, safe: boolean) =>
          asArray(rows)
            .slice(0, 60)
            .map((r) => `${safe ? str(r.value) : untrusted(r.value)} (${str(r.count) ?? "0"})`)
            .join(", ") || "none";
        return [
          `roster: the entire roster (${str(a.rosterCount) ?? "0"} students)`,
          `class-year (audience_value): ${list(a.classYears, false)}`,
          `school (audience_value, the school's name exactly): ${list(a.schools, false)}`,
          `status (audience_value): ${list(a.statuses, true)}`,
          `selection: pass student_ids (at most ${BLAST_SELECTION_MAX}) instead.`,
        ].join("\n");
      },
    }),
    op({
      name: "blasts.send",
      kind: "write",
      risk: "confirm",
      title: "Email a blast to students now: the roster, a class year, a school's applicants, a status, or picked students.",
      doc: "{ audience_kind: roster|class-year|school|status|selection, audience_value? ≤200 (class-year, school, status only), student_ids? [≤200] (selection only), subject ≤300, body ≤5000 }",
      input: z
        .object({
          audience_kind: z.enum(BLAST_AUDIENCES),
          audience_value: z.string().trim().max(200).optional(),
          student_ids: z.array(uuid).max(BLAST_SELECTION_MAX).optional(),
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(MESSAGE_MAX),
        })
        .strict()
        // The route's own refusals (resolveAudience), so a card that can only fail is never filed.
        .superRefine((i, ctx) => {
          if ((i.audience_kind === "class-year" || i.audience_kind === "school" || i.audience_kind === "status") && !i.audience_value) {
            ctx.addIssue({ code: "custom", path: ["audience_value"], message: `Pick a ${i.audience_kind === "class-year" ? "class year" : i.audience_kind === "school" ? "school" : "application status"} (blasts.audiences)` });
          }
          if (i.audience_kind === "selection" && !(i.student_ids ?? []).length) ctx.addIssue({ code: "custom", path: ["student_ids"], message: "Pick at least one student" });
        })
        // Ours: the route ignores these, so they would only make the card disagree with what is sent.
        .superRefine((i, ctx) => {
          if (i.audience_kind !== "selection" && i.student_ids !== undefined) {
            ctx.addIssue({ code: "custom", path: ["student_ids"], message: "student_ids is only for audience_kind selection" });
          }
          if ((i.audience_kind === "roster" || i.audience_kind === "selection") && i.audience_value !== undefined) {
            ctx.addIssue({ code: "custom", path: ["audience_value"], message: "audience_value is only for class-year, school and status" });
          }
          // The route matches a school with ILIKE: % and _ would widen it to schools nobody picked.
          if (i.audience_kind === "school" && /[%_\\]/.test(i.audience_value ?? "")) {
            ctx.addIssue({ code: "custom", path: ["audience_value"], message: "Use the school's name exactly as blasts.audiences lists it" });
          }
          for (const k of ["subject", "body"] as const) {
            if (PLACEHOLDER.test(i[k])) ctx.addIssue({ code: "custom", path: [k], message: 'Replace {first} and {me}: a blast goes out as written (each email opens with "Hi <first name>," on its own)' });
          }
        }),
      request: (i) => ({
        method: "POST",
        url: "/blasts",
        // One audience becomes one filter: the route combines filters, AxIS names a single audience.
        body: defined({
          classYears: i.audience_kind === "class-year" ? [i.audience_value] : undefined,
          colleges: i.audience_kind === "school" ? [i.audience_value] : undefined,
          statuses: i.audience_kind === "status" ? [i.audience_value] : undefined,
          studentIds: i.student_ids,
          subject: i.subject,
          body: i.body,
        }),
      }),
      describe: async (i, h) => `Email blast to ${await audienceLabel(i, h)}: "${plainText(i.subject, 80)}"`,
      details: async (i, h) => {
        const [label, people] = await Promise.all([audienceLabel(i, h), blastPeople(i, h)]);
        return [
          `To: students — ${label}; anyone without an email address on file is skipped, and parents aren't copied`,
          ...people,
          `Subject: ${plainText(i.subject, 300)}`,
          ...bodyLines(`Hi <first name>,\n\n${i.body}`),
          "Each email is signed as sent by you through Meridies.",
        ];
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
/** Below the route's 20,000 so a saved row (and its card) stays under the 32 KB cap. */
const TEMPLATE_MAX = 8000;
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

const templateLabel = (t: Template | null) => (t ? `"${plainText(t.name, 80)}"` : "an email template that isn't yours");

export const emailTemplates: OpGroup = {
  heading: "Email templates",
  ops: [
    op({
      name: "templates.list",
      kind: "read",
      outside: false,
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
          return `${line(t)}\nbody: ${wrapUntrusted("template", String(t.body ?? "").slice(0, 4000))}\n({first} is the recipient's first name and {me} the counselor's; fill them in before sending a message or a blast from it.)`;
        }
        return listReply(rows, line, "No templates in this set.");
      },
    }),
    op({
      name: "templates.create",
      kind: "write",
      risk: "auto",
      title: "Save an email template; one with the same subject in that set is rewritten. Placeholders {first} and {me}.",
      doc: "{ set: families|staff, subject ≤300, body ≤8000, name? ≤200 }",
      input: z
        .object({
          set: z.enum(TEMPLATE_SETS),
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().max(300),
          body: z.string().max(TEMPLATE_MAX),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/email-templates", body: defined({ set: i.set, name: i.name, subject: i.subject, body: i.body }) }),
      describe: async (i, h) => {
        const existing = await sameSubject(h, i.set, i.subject);
        return existing
          ? `Rewrite email template ${templateLabel(existing)} (same subject)`
          : `Save a new ${i.set === "staff" ? "staff" : "families"} email template "${plainText(i.name || i.subject || "Untitled template", 80)}"`;
      },
      details: (i) => [...changeLines(i, { name: "Name", subject: "Subject" }), ...bodyLines(i.body, "Body", 6)],
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
      doc: "{ template_id, name? ≤200, subject? ≤300, body? ≤8000 }",
      input: z
        .object({
          template_id: uuid,
          name: z.string().trim().min(1).max(200).optional(),
          subject: z.string().trim().max(300).optional(),
          body: z.string().max(TEMPLATE_MAX).optional(),
        })
        .strict()
        .refine((i) => i.name !== undefined || i.subject !== undefined || i.body !== undefined, { message: "Nothing to change" }),
      request: (i) => ({ method: "PATCH", url: `/email-templates/${seg(i.template_id)}`, body: defined({ name: i.name, subject: i.subject, body: i.body }) }),
      describe: async (i, h) => {
        const t = await findTemplate(h, i.template_id);
        const only = Object.keys(i).filter((k) => k !== "template_id");
        return only.length === 1 && i.name ? `Rename email template ${templateLabel(t)} to "${plainText(i.name, 80)}"` : `Update email template ${templateLabel(t)}`;
      },
      details: (i) => [...changeLines(i, { name: "Name", subject: "Subject" }), ...("body" in i ? bodyLines(i.body, "Body", 6) : [])],
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
      snapshot: async (i, h) => {
        const t = await findTemplate(h, i.template_id);
        if (!t || (t.set !== "families" && t.set !== "staff")) return null;
        const rows = await h.get<unknown[]>(`/email-templates?set=${t.set}`);
        if (!Array.isArray(rows)) return null;
        const subject = String(t.subject ?? "").trim();
        // Another template with the same subject: saving this one back would rewrite that one instead.
        const twin = subject && asArray(rows).some((r) => r.id !== t.id && String(r.subject ?? "").trim() === subject);
        return twin ? null : t;
      },
      // Put back as a new template with the same set, name, subject and text.
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
      outside: true,
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
      // No route marks one unread again, so this can't be undone.
      risk: "confirm",
      title: "Mark one notification read.",
      doc: "{ notification_id }",
      input: z.object({ notification_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/notifications/${seg(i.notification_id)}/read` }),
      describe: async (i, h) => {
        const n = await findIn(h, "/notifications?limit=200", i.notification_id);
        return n && n.kind !== "red-flag" ? `Mark notification "${plainText(n.title, 80)}" read` : "Mark a notification read";
      },
      details: async (i, h) => {
        const n = await findIn(h, "/notifications?limit=200", i.notification_id);
        return n ? [`Notification: ${plainText(n.title, 200)}`, ...(n.readAt ? ["Already read"] : [])] : [];
      },
      warning: "It can't be marked unread again.",
      reply: () => "Marked read.",
    }),
    op({
      name: "notifications.mark_all_read",
      kind: "write",
      // Every unread row at once, and none can be marked unread again.
      risk: "confirm",
      title: "Mark every unread notification read.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "POST", url: "/notifications/read-all", body: {} }),
      describe: async (_i, h) => {
        const c = asRecord(await h.get("/notifications/unread-count"));
        return typeof c.unread === "number" ? `Mark all ${c.unread} unread notifications read` : "Mark all notifications read";
      },
      details: async (_i, h) => {
        const rows = asArray(await h.get<unknown[]>("/notifications?unread=true&limit=200"));
        const shown = rows.slice(0, 15).map((n) => plainText(n.title, 100));
        return shown.length ? [`Unread: ${shown.join("; ")}${rows.length > 15 ? `; and ${rows.length - 15} more` : ""}`] : [];
      },
      warning: "Every unread notification is marked read at once; none can be marked unread again.",
      reply: (body) => `Marked ${str(asRecord(body).read) ?? "0"} notifications read.`,
    }),
  ],
};
