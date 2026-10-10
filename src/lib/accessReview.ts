/**
 * Counselor access review: the emailed link Meridies uses to approve a
 * pending counselor.
 *
 * The link's token is 32 random bytes; only its sha256 is stored
 * (counselor_access_requests.token_hash). Opening the link shows who is being
 * approved and changes nothing, because mail scanners open links. Only the
 * page's button (a POST) approves, through approve_counselor_by_token, which
 * consumes the token in one statement so it works once.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";

const REVIEW_INBOX = env.ACCESS_REVIEW_EMAIL ?? "team@meridiesai.com";
/** At most one review email per account in this window. */
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export type Applicant = {
  id: string;
  fullName: string | null;
  email: string;
  practice: string | null;
  firmSize: string | null;
  signedUpAt: string | null;
  revokedAt: string | null;
};

export type ReviewView =
  | { kind: "confirm"; applicant: Applicant }
  | { kind: "approved"; applicant: Applicant }
  | { kind: "invalid" };

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newReviewToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashReviewToken(token) };
}

/** User text on one line: no control characters (a subject must never carry a line break). */
export function oneLine(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const day = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "Unknown";

function practiceLine(a: Applicant): string {
  const practice = oneLine(a.practice ?? "") || "Not given";
  const size = oneLine(a.firmSize ?? "", 40);
  return size ? `${practice} (${size})` : practice;
}

/** The email to the review inbox. `brandedEmail` escapes every paragraph. */
export function reviewEmail(
  a: Applicant,
  url: string
): { subject: string; content: Parameters<typeof brandedEmail>[0] } {
  return {
    subject: `Counselor access request: ${oneLine(a.email, 120)}`,
    content: {
      heading: "A counselor is asking for access",
      paragraphs: [
        `Name: ${oneLine(a.fullName ?? "") || "Not given"}`,
        `Email: ${oneLine(a.email)}`,
        `Practice: ${practiceLine(a)}`,
        `Signed up: ${day(a.signedUpAt)}`,
        a.revokedAt ? `This account's access was revoked on ${day(a.revokedAt)}.` : "",
        "Open the review page to check who this is, then approve. The link works once and expires in 7 days.",
      ],
      cta: { label: "Review this account", url },
    },
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;background:#f6f7f5;color:#17231c;margin:0;padding:40px 16px}" +
  "main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #dfe5df;border-radius:14px;padding:28px}" +
  "h1{font-size:22px;margin:0 0 16px}dl{margin:0 0 20px}dt{font-size:12px;color:#5c6b62;margin-top:12px}" +
  "dd{margin:2px 0 0;font-size:15px;word-break:break-word}p{font-size:14px;color:#5c6b62}" +
  "button{font:inherit;font-weight:600;background:#1f5c3d;color:#fff;border:0;border-radius:10px;padding:12px 20px;cursor:pointer}" +
  ".warn{color:#8a3b12}";

function who(a: Applicant): string {
  return (
    "<dl>" +
    `<dt>Name</dt><dd>${esc(oneLine(a.fullName ?? "") || "Not given")}</dd>` +
    `<dt>Email</dt><dd>${esc(oneLine(a.email))}</dd>` +
    `<dt>Practice</dt><dd>${esc(practiceLine(a))}</dd>` +
    `<dt>Signed up</dt><dd>${esc(day(a.signedUpAt))}</dd>` +
    "</dl>"
  );
}

/** The whole review page. Every user-supplied value goes through `esc`. */
export function reviewPage(v: ReviewView): string {
  let body: string;
  if (v.kind === "invalid") {
    body =
      "<h1>This link is no longer valid</h1>" +
      "<p>It was already used, it expired, or a newer one was sent. If the account still needs review, " +
      "the counselor's next visit sends a fresh link.</p>";
  } else if (v.kind === "approved") {
    body = `<h1>Approved</h1>${who(v.applicant)}<p>They have been emailed and can use Meridies now.</p>`;
  } else {
    body =
      `<h1>Approve this counselor?</h1>${who(v.applicant)}` +
      (v.applicant.revokedAt
        ? `<p class="warn">This account's access was revoked on ${esc(day(v.applicant.revokedAt))}.</p>`
        : "") +
      "<p>Approving lets this account invite and message students.</p>" +
      '<form method="post" action=""><button type="submit">Approve</button></form>';
  }
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>Meridies account review</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`
  );
}

export function reviewUrl(token: string): string {
  const base = (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");
  return `${base}/access-review/${token}`;
}

export async function loadApplicant(svc: SupabaseClient, profileId: string): Promise<Applicant | null> {
  const { data, error } = await svc
    .from("profiles")
    .select("id, full_name, email, role, profile, created_at, counselor_revoked_at")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new Error(`applicant read failed (${error.code ?? "unknown"})`);
  if (!data || data.role !== "counselor") return null;
  const blob = (data.profile ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return {
    id: String(data.id),
    fullName: text(data.full_name),
    email: String(data.email),
    practice: text(blob.firmName),
    firmSize: text(blob.firmSize),
    signedUpAt: text(data.created_at),
    revokedAt: text(data.counselor_revoked_at),
  };
}

/**
 * Ask Meridies to review this pending counselor. Idempotent: inside the
 * 24-hour window it does nothing. A new request retires any older live token
 * first (the table allows one unused request per account), so only the newest
 * link works. If the email cannot be sent the request is removed, so the next
 * visit tries again instead of waiting out the window.
 */
export async function requestAccess(
  svc: SupabaseClient,
  profileId: string,
  log: Log
): Promise<"sent" | "recent" | "email-failed"> {
  const { data: last, error: lastErr } = await svc
    .from("counselor_access_requests")
    .select("requested_at")
    .eq("profile_id", profileId)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(`access request read failed (${lastErr.code ?? "unknown"})`);
  if (last && Date.now() - new Date(String(last.requested_at)).getTime() < RESEND_AFTER_MS) return "recent";

  const applicant = await loadApplicant(svc, profileId);
  if (!applicant) throw new Error("access request for a profile that is not a counselor");

  const retired = await svc
    .from("counselor_access_requests")
    .update({ used_at: new Date().toISOString() })
    .eq("profile_id", profileId)
    .is("used_at", null);
  if (retired.error) throw new Error(`access request retire failed (${retired.error.code ?? "unknown"})`);

  const { token, hash } = newReviewToken();
  const inserted = await svc
    .from("counselor_access_requests")
    .insert({ profile_id: profileId, token_hash: hash })
    .select("id")
    .single();
  if (inserted.error) {
    // 23505: another request for this account landed first; it will send the email.
    if (inserted.error.code === "23505") return "recent";
    throw new Error(`access request insert failed (${inserted.error.code ?? "unknown"})`);
  }

  const mail = reviewEmail(applicant, reviewUrl(token));
  const result = await sendEmail({
    to: REVIEW_INBOX,
    subject: mail.subject,
    html: brandedEmail(mail.content),
    text: brandedText(mail.content),
    template: "access-review",
    logger: log,
  });
  if (!result.sent) {
    const removed = await svc.from("counselor_access_requests").delete().eq("id", inserted.data.id);
    if (removed.error) log.error({ code: removed.error.code }, "access request: could not remove an unsent request");
    return "email-failed";
  }
  return "sent";
}

/** Tell the counselor they are in. Never throws: the approval already happened. */
export async function sendApprovedEmail(a: Applicant, log: Log): Promise<void> {
  const content = {
    heading: "Your Meridies account is approved",
    paragraphs: ["You can now invite students and use the rest of Meridies."],
    cta: { label: "Open Meridies", url: `${env.APP_URL}/dashboard/counselor` },
  };
  await sendEmail({
    to: a.email,
    subject: "Your Meridies account is approved",
    html: brandedEmail(content),
    text: brandedText(content),
    template: "access-approved",
    recipient_kind: "counselor",
    recipient_id: a.id,
    logger: log,
  }).catch((err: unknown) => log.error({ err }, "access approved: email failed"));
}
