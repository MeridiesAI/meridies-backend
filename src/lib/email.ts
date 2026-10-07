/**
 * Outbound email (Resend) and SMS (Twilio) — the API's outbound edge.
 *
 * Sends are best-effort: a failure logs and returns `{ sent: false }` rather
 * than throwing, so a Resend outage never blocks a counselor from creating the
 * invitation, the task, or the blast. Every attempt is written to
 * `message_deliveries` (provider='resend') for an audit trail, exactly as that
 * table anticipates, using the service role because the table is deliberately
 * not client-writable.
 *
 * SMS goes through Twilio's REST API (`sendSms`, plain fetch, no SDK). Without
 * Twilio configured it writes a `queued` delivery row rather than pretending to
 * have sent anything — a task that claims it texted a student and didn't is
 * worse than one that says it's queued. A text is only ever `sent` after a 2xx
 * from Twilio carrying a message SID.
 *
 * Without `RESEND_API_KEY` the send is skipped (and logged). In local dev,
 * `DEV_MAIL_URL` sends everything to a Mailpit catcher instead (never in
 * production), so an invite can be opened and accepted without mailing anyone. Until a domain is verified in Resend, `INVITE_FROM_EMAIL` must stay on
 * the shared `onboarding@resend.dev`, which only delivers to the account owner.
 */

import { devMailUrl, env, hasResend, hasTwilio } from "../env.js";
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

/** Mailpit's send API (local development only, see `DEV_MAIL_URL`). */
async function sendToDevMail(
  base: string,
  m: { to: string; subject: string; html: string; text: string }
): Promise<{ providerId: string | null; sent: boolean; errorText: string | null }> {
  const from = /^(.*?)\s*<([^>]+)>$/.exec(env.INVITE_FROM_EMAIL);
  try {
    const res = await fetch(new URL("/api/v1/send", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: from ? { Name: from[1], Email: from[2] } : { Email: env.INVITE_FROM_EMAIL },
        To: [{ Email: m.to }],
        Subject: m.subject,
        HTML: m.html,
        Text: m.text,
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as { ID?: string };
    if (res.ok && payload.ID) return { providerId: `dev-mail:${payload.ID}`, sent: true, errorText: null };
    return { providerId: null, sent: false, errorText: `Dev mail returned ${res.status}` };
  } catch (err) {
    return { providerId: null, sent: false, errorText: err instanceof Error ? err.message : String(err) };
  }
}

/** The one place an email actually leaves this process. */
export async function sendEmail(args: SendEmailArgs): Promise<OutboundResult> {
  const { to, subject, html, text, template, logger } = args;

  let providerId: string | null = null;
  let sent = false;
  let errorText: string | null = null;

  if (devMailUrl) {
    ({ providerId, sent, errorText } = await sendToDevMail(devMailUrl, { to, subject, html, text }));
    if (!sent) logger?.error({ template, err: errorText }, "dev mail send failed");
  } else if (!hasResend) {
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

// ---- SMS (Twilio REST) -----------------------------------------------------

const TWILIO_TIMEOUT_MS = 10_000;
const SMS_MAX_CHARS = 1600;

export type SmsStatus = "queued" | "sent" | "failed";

export type SmsResult = OutboundResult & {
  /**
   * The truth about this text, and the only thing a caller may report:
   * `sent` means Twilio answered 2xx with a message SID; `queued` means no
   * provider is configured and the row waits; `failed` carries `error`.
   */
  status: SmsStatus;
};

/**
 * Normalise a phone number to E.164, or null when it isn't one.
 *
 * Formatting characters (spaces, dashes, dots, parentheses) are stripped. A
 * bare 10-digit number, or 11 digits with a leading 1, is read as a North
 * American number only when its area code and exchange are valid NANP (first
 * digit 2-9) — the product is sold to US counselors and that is how a parent's
 * number is typed. Anything else must already carry its `+country` prefix;
 * we never guess a country.
 */
export function toE164(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(stripped)) return stripped;
  const nanp = /^1?([2-9]\d{2}[2-9]\d{6})$/.exec(stripped);
  if (nanp) return `+1${nanp[1]}`;
  return null;
}

type TwilioReply = { sid?: string; code?: number; message?: string };

/**
 * One POST to Twilio. Returns the message SID only on a 2xx that carries one;
 * every other outcome is an error string that is safe to store and show (no
 * credentials, no raw exception text from the network stack).
 */
async function postToTwilio(
  to: string,
  body: string
): Promise<{ sid: string; error: null } | { sid: null; error: string }> {
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const token = env.TWILIO_AUTH_TOKEN as string;
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", env.TWILIO_FROM_NUMBER as string);
  // Delivered / undelivered come back to routes/webhooks.ts.
  if (env.PUBLIC_API_URL) form.set("StatusCallback", `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/webhooks/twilio/status`);

  let res: Response;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      }
    );
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { sid: null, error: timedOut ? "SMS provider timed out" : "SMS provider unreachable" };
  }

  const payload = (await res.json().catch(() => ({}))) as TwilioReply;
  if (res.ok && typeof payload.sid === "string" && payload.sid) {
    return { sid: payload.sid, error: null };
  }
  if (res.status === 401 || res.status === 403) {
    return { sid: null, error: "SMS provider rejected the configured credentials" };
  }
  const detail = typeof payload.message === "string" ? payload.message : `HTTP ${res.status}`;
  const code = typeof payload.code === "number" ? ` ${payload.code}` : "";
  return { sid: null, error: `SMS provider error${code}: ${detail}`.slice(0, 300) };
}

/**
 * Send an SMS through Twilio, and record the attempt in `message_deliveries`.
 *
 * - No provider configured: the row is written `queued` and left for a later
 *   worker. `status: 'queued'`, `sent: false` — never reported as a send.
 * - Invalid number: the row is written `failed`; nothing is sent.
 * - Otherwise the row is written `queued` first (the intent survives a crash
 *   mid-request), then updated to `sent` with Twilio's SID on a 2xx, or to
 *   `failed` with a safe error.
 *
 * Best-effort like `sendEmail`: never throws for a delivery failure.
 */
export async function sendSms(
  args: DeliveryColumns & { to: string; body: string; template: string; logger?: Logger }
): Promise<SmsResult> {
  const { logger, template } = args;
  const body = args.body.slice(0, SMS_MAX_CHARS);
  const to = toE164(args.to);

  const base = {
    student_id: args.student_id ?? null,
    deliverable_id: args.deliverable_id ?? null,
    blast_id: args.blast_id ?? null,
    parent_alert_id: args.parent_alert_id ?? null,
    family_report_id: args.family_report_id ?? null,
    recipient_kind: args.recipient_kind ?? "student",
    recipient_id: args.recipient_id ?? null,
    to_phone: to ?? args.to.slice(0, 40),
    channel: "sms",
    template,
    body,
  };

  if (!to) {
    const error = "Phone number on file is not a valid number (use +country format, e.g. +15551234567)";
    const deliveryId = await recordDelivery(
      { ...base, provider: hasTwilio ? "twilio" : null, status: "failed", error },
      logger
    );
    return { id: null, sent: false, deliveryId, error, status: "failed" };
  }

  if (!hasTwilio) {
    const deliveryId = await recordDelivery({ ...base, provider: null, status: "queued" }, logger);
    return { id: null, sent: false, deliveryId, error: null, status: "queued" };
  }

  const deliveryId = await recordDelivery({ ...base, provider: "twilio", status: "queued" }, logger);
  const result = await postToTwilio(to, body);

  const update = result.sid
    ? { status: "sent", provider_message_id: result.sid, sent_at: new Date().toISOString(), error: null }
    : { status: "failed", error: result.error };
  if (!result.sid) logger?.error({ template, err: result.error }, "sms send failed");

  if (deliveryId) {
    const svc = serviceClient();
    const { error } = svc
      ? await svc.from("message_deliveries").update(update).eq("id", deliveryId)
      : { error: null };
    if (error) logger?.warn({ err: error.message }, "message_deliveries sms status update failed");
  }

  return result.sid
    ? { id: result.sid, sent: true, deliveryId, error: null, status: "sent" }
    : { id: null, sent: false, deliveryId, error: result.error, status: "failed" };
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
  /** v10 sync (overview): the counselor's personal note, e.g. what to send. */
  note?: string | null;
  /** v10 sync (overview): a referred family is invited, not a student. */
  audience?: "student" | "family";
};

export async function sendInviteEmail(
  args: SendInviteArgs
): Promise<{ id: string | null; sent: boolean }> {
  const { to, counselorName, acceptUrl, studentId = null, logger, note = null, audience = "student" } = args;
  const who = counselorName ?? "Your counselor";

  const template: BrandedEmail = {
    heading: "You've been invited",
    paragraphs: [
      audience === "family"
        ? `${who} has invited your family to Meridies. Share this link with your student: it is where they and their counselor track college applications, deadlines, and their profile together in one place.`
        : `${who} has invited you to join Meridies — where you and your counselor track your college applications, deadlines, and profile together in one place.`,
      ...(note?.trim() ? [note.trim()] : []),
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
