/**
 * Outbound email and SMS via Resend — the API's outbound edge.
 *
 * Sends are best-effort: a failure logs and returns `{ sent: false }` rather
 * than throwing, so a Resend outage never blocks a counselor from creating the
 * invitation, the task, or the blast. Every attempt is written to
 * `message_deliveries` (provider='resend') for an audit trail, exactly as that
 * table anticipates, using the service role because the table is deliberately
 * not client-writable.
 *
 * SMS has no provider wired yet. `queueSms` therefore writes a `queued`
 * delivery row for the outbound worker rather than pretending to have sent
 * anything — a task that claims it texted a student and didn't is worse than
 * one that says it's queued.
 *
 * Without `RESEND_API_KEY` the send is skipped (and logged) — useful in local
 * dev. Until a domain is verified in Resend, `INVITE_FROM_EMAIL` must stay on
 * the shared `onboarding@resend.dev`, which only delivers to the account owner.
 */

import { env, hasResend } from "../env.js";
import { serviceClient } from "./supabase.js";

type Logger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type OutboundResult = {
  /** Provider message id, when the provider accepted it. */
  id: string | null;
  sent: boolean;
  /** The `message_deliveries` row, so a caller can reference the attempt. */
  deliveryId: string | null;
  error: string | null;
};

type DeliveryColumns = {
  student_id?: string | null;
  deliverable_id?: string | null;
  blast_id?: string | null;
  parent_alert_id?: string | null;
  family_report_id?: string | null;
  recipient_kind?: "guardian" | "student" | "counselor";
  recipient_id?: string | null;
};

type SendEmailArgs = DeliveryColumns & {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Short identifier for the message shape: 'invite', 'task-assigned', 'blast'. */
  template: string;
  logger?: Logger;
};

/**
 * Write the audit row. Never fatal: a logging failure must not fail the send it
 * describes, and a send failure must still leave a row saying so.
 */
async function recordDelivery(
  row: Record<string, unknown>,
  logger?: Logger
): Promise<string | null> {
  const svc = serviceClient();
  if (!svc) {
    logger?.warn({}, "SUPABASE_SERVICE_ROLE_KEY unset — outbound message not logged.");
    return null;
  }
  const { data, error } = await svc
    .from("message_deliveries")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) logger?.warn({ err: error.message }, "message_deliveries log insert failed");
  return (data?.id as string | undefined) ?? null;
}

/** The one place an email actually leaves this process. */
export async function sendEmail(args: SendEmailArgs): Promise<OutboundResult> {
  const { to, subject, html, text, template, logger } = args;

  let providerId: string | null = null;
  let sent = false;
  let errorText: string | null = null;

  if (!hasResend) {
    errorText = "RESEND_API_KEY unset";
    logger?.warn({ template }, "RESEND_API_KEY unset — email skipped (logged only).");
  } else {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: env.INVITE_FROM_EMAIL, to: [to], subject, html, text }),
      });
      const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && payload.id) {
        providerId = payload.id;
        sent = true;
      } else {
        errorText = payload.message ?? `Resend returned ${res.status}`;
        logger?.error({ status: res.status, template, err: errorText }, "email send failed");
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err);
      logger?.error({ template, err: errorText }, "email send threw");
    }
  }

  const deliveryId = await recordDelivery(
    {
      student_id: args.student_id ?? null,
      deliverable_id: args.deliverable_id ?? null,
      blast_id: args.blast_id ?? null,
      parent_alert_id: args.parent_alert_id ?? null,
      family_report_id: args.family_report_id ?? null,
      recipient_kind: args.recipient_kind ?? "student",
      recipient_id: args.recipient_id ?? null,
      to_email: to,
      channel: "email",
      provider: "resend",
      provider_message_id: providerId,
      template,
      subject,
      body: text.slice(0, 8000),
      status: sent ? "sent" : "failed",
      error: errorText,
      sent_at: sent ? new Date().toISOString() : null,
    },
    logger
  );

  return { id: providerId, sent, deliveryId, error: errorText };
}

/**
 * Queue an SMS. There is no SMS provider configured yet, so this records the
 * intent and leaves the row `queued` for the outbound worker. It returns
 * `sent: false` deliberately — callers must not report a text as delivered.
 */
export async function queueSms(
  args: DeliveryColumns & { to: string; body: string; template: string; logger?: Logger }
): Promise<OutboundResult> {
  const deliveryId = await recordDelivery(
    {
      student_id: args.student_id ?? null,
      deliverable_id: args.deliverable_id ?? null,
      blast_id: args.blast_id ?? null,
      recipient_kind: args.recipient_kind ?? "student",
      recipient_id: args.recipient_id ?? null,
      to_phone: args.to,
      channel: "sms",
      provider: null,
      template: args.template,
      body: args.body.slice(0, 1600),
      status: "queued",
    },
    args.logger
  );
  return { id: null, sent: false, deliveryId, error: null };
}

// ---- Templates -------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

type BrandedEmail = {
  heading: string;
  /** Paragraphs. Already plain text; escaped here. */
  paragraphs: string[];
  bullets?: string[];
  cta?: { label: string; url: string };
  footnote?: string;
};

/**
 * Brand tokens mirror the app's design system (green-forward). Inlined because
 * email clients strip <style>. Kept intentionally simple and robust.
 */
export function brandedEmail(t: BrandedEmail): string {
  const paragraphs = t.paragraphs
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#334b3f;">${escapeHtml(
          p
        )}</p>`
    )
    .join("");

  const bullets = t.bullets?.length
    ? `<ul style="margin:16px 0 0;padding-left:20px;font-size:15px;line-height:1.6;color:#334b3f;">${t.bullets
        .map((b) => `<li style="margin:6px 0;">${escapeHtml(b)}</li>`)
        .join("")}</ul>`
    : "";

  const cta = t.cta
    ? `<tr><td style="padding:28px 32px 8px;">
            <a href="${escapeAttr(
              t.cta.url
            )}" style="display:inline-block;background:#176b45;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 22px;border-radius:9999px;">${escapeHtml(
        t.cta.label
      )}</a>
          </td></tr>`
    : "";

  const footnote = t.footnote
    ? `<tr><td style="padding:16px 32px 32px;">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#64736a;">${escapeHtml(
              t.footnote
            )}</p>
          </td></tr>`
    : `<tr><td style="padding:16px 32px 32px;"></td></tr>`;

  return `<!doctype html>
<html>
  <body style="margin:0;background:#fbfdf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#10291f;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfdf9;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #dce8df;border-radius:16px;overflow:hidden;">
          <tr><td style="padding:32px 32px 8px;">
            <div style="font-size:14px;font-weight:600;letter-spacing:0.02em;color:#176b45;text-transform:uppercase;">Meridies</div>
          </td></tr>
          <tr><td style="padding:8px 32px 0;">
            <h1 style="margin:0;font-size:22px;line-height:1.25;color:#10291f;">${escapeHtml(
              t.heading
            )}</h1>
            ${paragraphs}
            ${bullets}
          </td></tr>
          ${cta}
          ${footnote}
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Plain-text twin of `brandedEmail`, for clients that refuse HTML. */
export function brandedText(t: BrandedEmail): string {
  return [
    t.heading,
    "",
    ...t.paragraphs,
    ...(t.bullets?.length ? ["", ...t.bullets.map((b) => `- ${b}`)] : []),
    ...(t.cta ? ["", t.cta.label + ":", t.cta.url] : []),
    ...(t.footnote ? ["", t.footnote] : []),
  ].join("\n");
}

// ---- Invitations -----------------------------------------------------------

type SendInviteArgs = {
  to: string;
  counselorName: string | null;
  acceptUrl: string;
  /** Null while the invited student has no account yet. */
  studentId?: string | null;
  logger?: Logger;
};

export async function sendInviteEmail(
  args: SendInviteArgs
): Promise<{ id: string | null; sent: boolean }> {
  const { to, counselorName, acceptUrl, studentId = null, logger } = args;
  const who = counselorName ?? "Your counselor";

  const template: BrandedEmail = {
    heading: "You've been invited",
    paragraphs: [
      `${who} has invited you to join Meridies — where you and your counselor track your college applications, deadlines, and profile together in one place.`,
    ],
    cta: { label: "Accept invitation", url: acceptUrl },
    footnote:
      "This link expires in 14 days. If you weren't expecting this, you can safely ignore this email.",
  };

  const result = await sendEmail({
    to,
    subject: counselorName
      ? `${counselorName} invited you to Meridies`
      : "You're invited to Meridies",
    html: brandedEmail(template),
    text: brandedText(template),
    template: "invite",
    student_id: studentId,
    recipient_kind: "student",
    logger,
  });

  return { id: result.id, sent: result.sent };
}

// ---- Task assignment -------------------------------------------------------

export type TaskNotification = {
  studentName: string | null;
  counselorName: string | null;
  title: string;
  instructions: string | null;
  stages: { name: string; dueDate: string | null }[];
  documentNames: string[];
  dueDate: string | null;
  url: string;
};

export function taskAssignmentEmail(t: TaskNotification): BrandedEmail {
  const who = t.counselorName ?? "Your counselor";
  const stageLines = t.stages.map((s) =>
    s.dueDate ? `${s.name} — due ${s.dueDate}` : `${s.name} — no date set`
  );

  return {
    heading: `New task: ${t.title}`,
    paragraphs: [
      `${who} assigned you a task on Meridies.`,
      ...(t.instructions ? [t.instructions] : []),
      ...(t.documentNames.length
        ? [`Documents to work from: ${t.documentNames.join(", ")}`]
        : []),
    ],
    bullets: stageLines.length
      ? stageLines
      : t.dueDate
        ? [`Due ${t.dueDate}`]
        : undefined,
    cta: { label: "Open the task", url: t.url },
    footnote: "You're receiving this because your counselor assigned you work in Meridies.",
  };
}

/** SMS twin: one short message, no markup, well inside a single segment budget. */
export function taskAssignmentSms(t: TaskNotification): string {
  const first = t.stages[0];
  const when = first?.dueDate ?? t.dueDate;
  return [
    `Meridies: ${t.counselorName ?? "Your counselor"} assigned you "${t.title}"`,
    when ? ` (first due ${when})` : "",
    `. ${t.url}`,
  ].join("");
}
