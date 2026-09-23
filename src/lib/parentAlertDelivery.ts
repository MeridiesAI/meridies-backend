/**
 * Deliver a parent alert that has already cleared the gates.
 *
 * This does not decide *whether* an alert may go — quiet hours, the anti-spam
 * throttle and `student_alert_prefs` are all decided before the row is written
 * `queued` (see `alertBlockedReason` / `resolveAlertRecipients`). It only
 * carries a `queued` row to the recipients the row already names, over the
 * channel the counselor chose, and then records what actually happened.
 *
 * The alert's own status is the truth, never an optimistic one:
 * - `sent` when at least one message was accepted by a provider (that is what
 *   the throttle has to count, or a partial send would let a second alert out);
 * - `queued` when nothing was accepted but at least one text is waiting on an
 *   SMS provider that isn't configured yet;
 * - `failed` when every attempt failed or nobody on the row had a usable
 *   address for the channel.
 *
 * Works with the caller's RLS-bound client or the service client, so a
 * scheduled sender can reuse it. The recipient ids come from the alert row, not
 * from a client, so there is no id here to verify.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  brandedEmail,
  brandedText,
  sendEmail,
  sendSms,
  type SmsStatus,
} from "./email.js";

type Logger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type ParentAlertRow = {
  id: string;
  student_id: string;
  guardian_id: string | null;
  copy_student: boolean;
  subject: string;
  body: string;
  action_items: string[] | null;
  channel: "email" | "sms" | "both";
};

export type AlertDeliveryAttempt = {
  recipient: "guardian" | "student";
  channel: "email" | "sms";
  /** `unavailable`: no address of that kind on file, so nothing was attempted. */
  status: SmsStatus | "unavailable";
  error: string | null;
};

export type AlertDeliveryResult = {
  status: "sent" | "queued" | "failed";
  attempts: AlertDeliveryAttempt[];
};

type Recipient = {
  kind: "guardian" | "student";
  id: string;
  email: string | null;
  phone: string | null;
};

function smsBody(alert: ParentAlertRow): string {
  return `Meridies: ${alert.body.trim()}`;
}

export async function deliverParentAlert(
  ctx: { db: SupabaseClient },
  alert: ParentAlertRow,
  logger?: Logger
): Promise<AlertDeliveryResult> {
  const recipients: Recipient[] = [];

  if (alert.guardian_id) {
    const { data, error } = await ctx.db
      .from("guardians")
      .select("id, email, phone")
      .eq("id", alert.guardian_id)
      .eq("student_id", alert.student_id)
      .maybeSingle();
    if (error) logger?.error({ err: error.message }, "parent alert: guardian lookup failed");
    if (data) {
      recipients.push({
        kind: "guardian",
        id: data.id as string,
        email: (data.email as string | null) ?? null,
        phone: (data.phone as string | null) ?? null,
      });
    }
  }

  let studentName: string | null = null;
  {
    const { data, error } = await ctx.db
      .from("profiles")
      .select("id, full_name, email, phone")
      .eq("id", alert.student_id)
      .maybeSingle();
    if (error) logger?.error({ err: error.message }, "parent alert: student lookup failed");
    studentName = (data?.full_name as string | null) ?? null;
    if (alert.copy_student && data) {
      recipients.push({
        kind: "student",
        id: data.id as string,
        email: (data.email as string | null) ?? null,
        phone: (data.phone as string | null) ?? null,
      });
    }
  }

  const wantEmail = alert.channel === "email" || alert.channel === "both";
  const wantSms = alert.channel === "sms" || alert.channel === "both";

  const template = {
    heading: alert.subject,
    paragraphs: alert.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    bullets: alert.action_items?.length ? alert.action_items : undefined,
    footnote: studentName
      ? `Sent by ${studentName}'s counselor through Meridies. Contact your counselor directly with any questions.`
      : "Sent by your counselor through Meridies. Contact your counselor directly with any questions.",
  };

  const attempts: AlertDeliveryAttempt[] = [];

  for (const r of recipients) {
    const columns = {
      student_id: alert.student_id,
      parent_alert_id: alert.id,
      recipient_kind: r.kind,
      recipient_id: r.id,
      template: "parent-alert",
      logger,
    } as const;

    if (wantEmail) {
      if (!r.email) {
        attempts.push({ recipient: r.kind, channel: "email", status: "unavailable", error: "no email address on file" });
      } else {
        const res = await sendEmail({
          ...columns,
          to: r.email,
          subject: alert.subject,
          html: brandedEmail(template),
          text: brandedText(template),
        });
        attempts.push({
          recipient: r.kind,
          channel: "email",
          status: res.sent ? "sent" : "failed",
          error: res.sent ? null : res.error ?? "the email did not go out",
        });
      }
    }

    if (wantSms) {
      if (!r.phone) {
        attempts.push({ recipient: r.kind, channel: "sms", status: "unavailable", error: "no phone number on file" });
      } else {
        const res = await sendSms({ ...columns, to: r.phone, body: smsBody(alert) });
        attempts.push({ recipient: r.kind, channel: "sms", status: res.status, error: res.error });
      }
    }
  }

  if (recipients.length === 0) {
    attempts.push({
      recipient: alert.guardian_id ? "guardian" : "student",
      channel: wantSms && !wantEmail ? "sms" : "email",
      status: "unavailable",
      error: "the recipient on this alert could not be found",
    });
  }

  const status: AlertDeliveryResult["status"] = attempts.some((a) => a.status === "sent")
    ? "sent"
    : attempts.some((a) => a.status === "queued")
      ? "queued"
      : "failed";

  if (status !== "queued") {
    const update: Record<string, unknown> = { status };
    if (status === "sent") update.sent_at = new Date().toISOString();
    const { error } = await ctx.db
      .from("parent_alerts")
      .update(update)
      .eq("id", alert.id)
      .eq("status", "queued");
    if (error) logger?.error({ err: error.message }, "parent alert: status update failed");
  }

  return { status, attempts };
}
