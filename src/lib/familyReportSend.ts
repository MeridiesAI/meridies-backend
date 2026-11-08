/**
 * Sending an approved family report: who would receive it, and the exact text they would read.
 *
 * Nothing here sends. `POST /reports/family/:id/approve-send` (routes/reports.ts) turns the plan into scheduled
 * `student_messages` rows (audience parent), and `dispatchDueMessages` re-checks the roster, the counselor's
 * approval, copy_parents, each guardian's alerts and address, quiet hours and the daily cap before anything goes.
 *
 * Who: the student's `copy_parents` switch (`loadAlertPrefs`, the read `resolveAlertRecipients` uses: an absent row
 * is the default, parents on; an errored read throws), then every guardian with alerts on AND reports on, on their
 * preferred channel (email, sms, or both) where an address or number is on file. Everyone else is counted with a
 * reason, so the counselor sees who won't get it and why.
 */

import { brandedText } from "./email.js";
import { composerEmailTemplate, normEmail, normPhone, parentTextBody } from "./parentCopy.js";
import { DIGEST_SMS_MAX } from "./weeklyDigestContent.js";

export type GuardianRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  preferred_channel: string | null;
  alerts_enabled: boolean | null;
  receives_reports: boolean | null;
};

export type ReportChannel = "email" | "sms";
export type SkipReason = "opted-out" | "no-contact" | "parents-off";

export type ReportRecipient = {
  guardianId: string;
  name: string;
  relationship: string | null;
  email: string | null;
  phone: string | null;
  channels: ReportChannel[];
};

export type RecipientPlan = {
  recipients: ReportRecipient[];
  skipped: { optedOut: number; noContact: number; parentsOff: number };
  skippedGuardians: { guardianId: string; name: string; reason: SkipReason }[];
};

const CHANNELS_FOR: Record<string, ReportChannel[]> = { email: ["email"], sms: ["sms"], both: ["email", "sms"] };

export function planReportRecipients(guardians: GuardianRow[], prefs: { copy_parents: boolean }): RecipientPlan {
  const plan: RecipientPlan = { recipients: [], skipped: { optedOut: 0, noContact: 0, parentsOff: 0 }, skippedGuardians: [] };
  const skip = (g: GuardianRow, reason: SkipReason) => {
    plan.skippedGuardians.push({ guardianId: g.id, name: g.full_name, reason });
    if (reason === "opted-out") plan.skipped.optedOut += 1;
    else if (reason === "no-contact") plan.skipped.noContact += 1;
    else plan.skipped.parentsOff += 1;
  };
  for (const g of guardians) {
    if (!prefs.copy_parents) {
      skip(g, "parents-off");
      continue;
    }
    if (g.alerts_enabled === false || g.receives_reports === false) {
      skip(g, "opted-out");
      continue;
    }
    const wanted = CHANNELS_FOR[g.preferred_channel ?? "email"] ?? ["email"];
    const channels = wanted.filter((c) => (c === "email" ? normEmail(g.email) : normPhone(g.phone)));
    if (channels.length === 0) {
      skip(g, "no-contact");
      continue;
    }
    plan.recipients.push({ guardianId: g.id, name: g.full_name, relationship: g.relationship, email: g.email, phone: g.phone, channels });
  }
  return plan;
}

export type ReportText = { title: string; summary: string | null; body: string | null };

/** What a text carries: the summary (the body when there is none, the title as a last resort), one text long. */
export function smsTextOf(r: ReportText): string {
  const text = (r.summary ?? "").trim() || (r.body ?? "").trim() || r.title.trim();
  return text.length > DIGEST_SMS_MAX ? `${text.slice(0, DIGEST_SMS_MAX - 1).trimEnd()}…` : text;
}

/** The email body: the report's body, or its summary when the body is empty. */
export function emailBodyOf(r: ReportText): string {
  return (r.body ?? "").trim() || (r.summary ?? "").trim() || r.title.trim();
}

export type PreviewMessage = { guardianId: string; name: string; channel: ReportChannel; to: string; subject: string | null; text: string };

/**
 * Exactly what each recipient would read, built with the functions `deliverMessage` uses
 * (`composerEmailTemplate` + `brandedText` for email, `parentTextBody` for a text).
 */
export function reportMessages(
  report: ReportText,
  recipients: ReportRecipient[],
  ctx: { counselorName: string | null; studentName: string }
): PreviewMessage[] {
  const out: PreviewMessage[] = [];
  const copy = { counselorName: ctx.counselorName, studentName: ctx.studentName };
  for (const r of recipients) {
    for (const channel of r.channels) {
      if (channel === "email") {
        const template = composerEmailTemplate({ subject: report.title, body: emailBodyOf(report) }, { kind: "guardian", name: r.name }, copy);
        out.push({ guardianId: r.guardianId, name: r.name, channel, to: String(r.email), subject: template.heading, text: brandedText(template) });
      } else {
        out.push({ guardianId: r.guardianId, name: r.name, channel, to: String(r.phone), subject: null, text: parentTextBody(smsTextOf(report), { name: r.name }, copy) });
      }
    }
  }
  return out;
}
