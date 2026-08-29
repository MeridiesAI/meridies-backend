/**
 * Outbound email via Resend — the first real outbound integration in this API.
 *
 * Sends are best-effort: a failure logs and returns `{ sent: false }` rather
 * than throwing, so a Resend outage never blocks a counselor from creating the
 * invitation row. Every attempt is written to `message_deliveries`
 * (provider='resend') for an audit trail, exactly as that table anticipates.
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

type SendInviteArgs = {
  to: string;
  counselorName: string | null;
  acceptUrl: string;
  /** Null while the invited student has no account yet. */
  studentId?: string | null;
  logger?: Logger;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function inviteSubject(counselorName: string | null): string {
  return counselorName
    ? `${counselorName} invited you to MeridiesAI`
    : "You're invited to MeridiesAI";
}

function inviteText(counselorName: string | null, acceptUrl: string): string {
  const who = counselorName ? `${counselorName} has` : "Your counselor has";
  return [
    `${who} invited you to join MeridiesAI.`,
    "",
    "MeridiesAI is where you and your counselor track your college applications, deadlines, and profile in one place.",
    "",
    "Accept your invitation and set up your account:",
    acceptUrl,
    "",
    "This link expires in 14 days. If you weren't expecting this, you can ignore this email.",
  ].join("\n");
}

// Brand tokens mirror the app's design system (green-forward). Inlined because
// email clients strip <style>. Kept intentionally simple and robust.
function inviteHtml(counselorName: string | null, acceptUrl: string): string {
  const who = counselorName
    ? `<strong>${escapeHtml(counselorName)}</strong> has`
    : "Your counselor has";
  return `<!doctype html>
<html>
  <body style="margin:0;background:#fbfdf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#10291f;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfdf9;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #dce8df;border-radius:16px;overflow:hidden;">
          <tr><td style="padding:32px 32px 8px;">
            <div style="font-size:14px;font-weight:600;letter-spacing:0.02em;color:#176b45;text-transform:uppercase;">MeridiesAI</div>
          </td></tr>
          <tr><td style="padding:8px 32px 0;">
            <h1 style="margin:0;font-size:22px;line-height:1.25;color:#10291f;">You've been invited</h1>
            <p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#334b3f;">
              ${who} invited you to join MeridiesAI — where you and your counselor track your
              college applications, deadlines, and profile together in one place.
            </p>
          </td></tr>
          <tr><td style="padding:28px 32px 8px;">
            <a href="${escapeAttr(acceptUrl)}" style="display:inline-block;background:#176b45;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 22px;border-radius:9999px;">Accept invitation</a>
          </td></tr>
          <tr><td style="padding:16px 32px 32px;">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#64736a;">
              This link expires in 14 days. If you weren't expecting this, you can safely ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export async function sendInviteEmail(
  args: SendInviteArgs
): Promise<{ id: string | null; sent: boolean }> {
  const { to, counselorName, acceptUrl, studentId = null, logger } = args;
  const subject = inviteSubject(counselorName);

  let providerId: string | null = null;
  let sent = false;
  let errorText: string | null = null;

  if (!hasResend) {
    logger?.warn({}, "RESEND_API_KEY unset — invite email skipped (logged only).");
  } else {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.INVITE_FROM_EMAIL,
          to: [to],
          subject,
          html: inviteHtml(counselorName, acceptUrl),
          text: inviteText(counselorName, acceptUrl),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
      };
      if (res.ok && payload.id) {
        providerId = payload.id;
        sent = true;
      } else {
        errorText = payload.message ?? `Resend returned ${res.status}`;
        logger?.error({ status: res.status, err: errorText }, "invite email send failed");
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err);
      logger?.error({ err: errorText }, "invite email send threw");
    }
  }

  // Audit trail via the service role (this table is not client-writable).
  // Never fatal — a logging failure must not fail the invite.
  const svc = serviceClient();
  if (svc) {
    const { error: logErr } = await svc.from("message_deliveries").insert({
      student_id: studentId,
      recipient_kind: "student",
      to_email: to,
      channel: "email",
      provider: "resend",
      provider_message_id: providerId,
      template: "invite",
      subject,
      status: sent ? "sent" : "failed",
      error: errorText,
      sent_at: sent ? new Date().toISOString() : null,
    });
    if (logErr) logger?.warn({ err: logErr.message }, "message_deliveries log insert failed");
  }

  return { id: providerId, sent };
}
