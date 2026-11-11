/**
 * Agreements: a counselor attaches a plain-text agreement to a Contact Pipeline
 * contact, emails the family a private link, and the family accepts on a public
 * page by typing their name and ticking a consent box (routes/agreements.ts,
 * migration 20261111000010).
 *
 * THIS IS TYPED-NAME ACCEPTANCE, NOT A CERTIFIED ELECTRONIC SIGNATURE. Every
 * certificate says so. Whether it is enough for a given practice (ESIGN/UETA
 * disclosures, retention) is a decision outside this code; the whole feature is
 * off unless AGREEMENTS_ENABLED=true, and the consent wording it shows lives in
 * lib/agreementConsent.ts, marked for legal review.
 *
 * Pure helpers plus the two token functions, which take the client to use:
 * `mintAgreementLink` runs on the CALLER's client (the database function checks
 * `crm_can_bill` for auth.uid()), `agreementForToken` on the service client
 * (the public page, where nobody is signed in).
 */

import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { env } from "../env.js";
import { AGREEMENT_CONSENT_SENTENCE } from "./agreementConsent.js";
import { crmError } from "./crm.js";
import { brandedEmail, brandedText, escapeHtml } from "./email.js";
import { HttpError } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;

/** Off unless AGREEMENTS_ENABLED=true (read on every request, so tests can flip it). */
export const agreementsEnabled = () => env.AGREEMENTS_ENABLED === "true";

/** The link's capability: 32 random bytes, base64url. */
export const AGREEMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const AGREEMENT_LINK_DAYS = 30;
export const TITLE_MAX = 160;
export const BODY_MAX = 60_000;
export const USER_AGENT_MAX = 512;

/** A draft's title and text, as `POST /agreements` (and an invoice's inline agreement) takes them. */
export const agreementTitle = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "The title can't contain control characters");
export const agreementBodyText = z
  .string()
  .min(1)
  .max(BODY_MAX)
  .refine((s) => s.trim().length > 0, "Write the agreement first")
  .refine((s) => !s.includes("\u0000"), "The text can't contain a null character");

/** The OFF switch's answer (every agreements route, and an invoice asked to carry one). */
export const agreementsOff = () => new HttpError(404, "Agreements aren't switched on", "agreements_off");
/** Switched on, but the database update isn't in. */
export const agreementsUnavailable = () => new HttpError(503, "Agreements aren't switched on yet", "agreements_unavailable");

/** A missing table or function is the migration not being in; anything else is the CRM's usual mapping. */
export function agreementsError(error: { code?: string; message?: string } | null): HttpError {
  if (isResultsNotApplied(error)) return agreementsUnavailable();
  if (error?.code === "42501") return new HttpError(403, "Only the contact's consultant or a firm admin can do that", "agreement_forbidden");
  return crmError(error);
}

export const NOT_CERTIFIED_LINE = "Typed-name acceptance; not a certified electronic signature.";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The agreement text's fingerprint: sha256 of its exact UTF-8 bytes (the database computes the same). */
export const bodySha256 = (text: string) => sha256Hex(text);

/** Links are stored as their sha256 only. */
export const hashAgreementToken = (token: string) => sha256Hex(token);

export function agreementUrl(publicApiUrl: string, token: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}/agree/${token}`;
}

/** A database error that keeps its code, so a route can tell "migration missing" from a refusal. */
function dbError(what: string, error: { code?: string; message?: string }): Error & { code?: string; message: string } {
  return Object.assign(new Error(error.message ?? what), { code: error.code });
}

// ---- Tokens ---------------------------------------------------------------------

/**
 * Mint a fresh link and mark the agreement sent, on the caller's own client.
 * `issue_agreement_link` refuses anyone who may not bill the contact
 * (`private.crm_can_bill(contact, auth.uid())`) and an agreement already
 * accepted or voided, and expires the agreement's earlier links (a resend supersedes the
 * old email). The consent version is the server's, recorded at acceptance. The plaintext
 * token exists only in the returned url.
 */
export async function mintAgreementLink(
  db: SupabaseClient,
  agreementId: string,
  opts: { publicApiUrl: string; now?: Date; days?: number }
): Promise<{ url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.days ?? AGREEMENT_LINK_DAYS) * 86_400_000);
  const { error } = await db.rpc("issue_agreement_link", {
    p_agreement: agreementId,
    p_token_hash: hashAgreementToken(token),
    p_expires_at: expiresAt.toISOString(),
  });
  if (error) throw dbError("issue agreement link", error);
  return { url: agreementUrl(opts.publicApiUrl, token), expiresAt };
}

/**
 * The statuses an agreement can still change from: a `draft` can be sent or voided, a `sent` one sent again (a
 * new link) or voided. `accepted` and `void` are ends; the database's guard refuses any change to them.
 */
export const OPEN_AGREEMENT_STATUSES = ["draft", "sent"] as const;
export const isOpenAgreement = (status: unknown): boolean =>
  (OPEN_AGREEMENT_STATUSES as readonly unknown[]).includes(status);

export const AGREEMENT_COLUMNS =
  "id, counselor_id, firm_id, contact_id, title, body_text, body_sha256, consent_version, status, created_at, sent_at, accepted_at, voided_at";

export type TokenLookup =
  | { state: "invalid" }
  | { state: "open" | "expired" | "void" | "accepted"; agreement: Row; expiresAt: string };

/**
 * What a link opens (service client). Only `open` may be accepted. An accepted
 * agreement is still shown, read-only, even after its link expired; a void one
 * and an expired one are refused.
 */
export async function agreementForToken(svc: SupabaseClient, token: string, now = new Date()): Promise<TokenLookup> {
  if (!AGREEMENT_TOKEN.test(token)) return { state: "invalid" };
  const tok = await svc.from("agreement_tokens").select("agreement_id, expires_at").eq("token_hash", hashAgreementToken(token)).maybeSingle();
  if (tok.error) throw dbError("read agreement token", tok.error);
  const t = tok.data as Row | null;
  if (!t) return { state: "invalid" };
  const ag = await svc.from("agreements").select(AGREEMENT_COLUMNS).eq("id", String(t.agreement_id)).maybeSingle();
  if (ag.error) throw dbError("read agreement", ag.error);
  const agreement = ag.data as Row | null;
  if (!agreement) return { state: "invalid" };
  const expiresAt = String(t.expires_at);
  switch (agreement.status) {
    case "accepted":
      return { state: "accepted", agreement, expiresAt };
    case "void":
      return { state: "void", agreement, expiresAt };
    case "sent":
      return { state: new Date(expiresAt).getTime() <= now.getTime() ? "expired" : "open", agreement, expiresAt };
    default:
      return { state: "invalid" };
  }
}

// ---- Signed agreements are kept ---------------------------------------------------------

type PgErr = { code?: string; message?: string } | null;
const NOT_APPLIED = new Set(["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]);

export const SIGNED_AGREEMENT_CONTACT_MESSAGE =
  "This family has a signed agreement on file, which has to be kept. Void or archive the contact instead.";
export const SIGNED_AGREEMENT_ACCOUNT_MESSAGE = "Signed agreements have to be kept: ask Meridies to close the account.";

/** The database refusing a delete because an acceptance (ON DELETE RESTRICT) still points at it. */
export const isSignedAgreementRestrict = (error: PgErr) =>
  error?.code === "23503" && /agreement_acceptances/.test(error.message ?? "");

/** Whether the contact has an accepted agreement, as the caller's client sees it. False without the migration. */
export async function contactHasSignedAgreement(db: SupabaseClient, contactId: string): Promise<boolean> {
  const { data, error } = await db.from("agreements").select("id").eq("contact_id", contactId).eq("status", "accepted").limit(1);
  if (error) {
    if (error.code && NOT_APPLIED.has(error.code)) return false;
    throw dbError("read agreements", error);
  }
  return (data ?? []).length > 0;
}

/**
 * Whether deleting this profile would have to take an accepted agreement with it: one it wrote, or one on a
 * contact it created (both cascade from the profile, and the acceptance refuses). Service client; false
 * without the migration; any other error throws, so the caller refuses rather than guesses.
 */
export async function profileKeepsSignedAgreements(svc: SupabaseClient, profileId: string): Promise<boolean> {
  const [own, viaContact] = await Promise.all([
    svc.from("agreements").select("id").eq("counselor_id", profileId).eq("status", "accepted").limit(1),
    svc.from("agreements").select("id, pipeline_contacts!inner(counselor_id)").eq("status", "accepted").eq("pipeline_contacts.counselor_id", profileId).limit(1),
  ]);
  for (const r of [own, viaContact]) {
    if (r.error) {
      if (r.error.code && NOT_APPLIED.has(r.error.code)) return false;
      throw dbError("read agreements", r.error);
    }
  }
  return (own.data ?? []).length > 0 || (viaContact.data ?? []).length > 0;
}

// ---- What the family submits ------------------------------------------------------

/** Trimmed, inner white space collapsed, 2 to 120 characters, no control characters. Null if not acceptable. */
export function cleanSignerName(raw: string): string | null {
  const name = raw.replace(/[\t\n\r]+/g, " ").replace(/ {2,}/g, " ").trim().normalize("NFC");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null;
  if (name.length < 2 || name.length > 120) return null;
  return name;
}

const acceptForm = z.object({ signerName: z.string(), consent: z.literal("yes") }).strict();

/** The accept form: exactly `signerName` and `consent=yes`, each once. */
export function parseAcceptForm(raw: string): { ok: true; signerName: string } | { ok: false; reason: string } {
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "repeated" };
  const parsed = acceptForm.safeParse(Object.fromEntries(params));
  if (!parsed.success) return { ok: false, reason: "form" };
  const signerName = cleanSignerName(parsed.data.signerName);
  if (!signerName) return { ok: false, reason: "name" };
  return { ok: true, signerName };
}

export function truncateUserAgent(ua: string | string[] | undefined): string | null {
  const s = (Array.isArray(ua) ? ua[0] : ua)?.trim();
  return s ? s.slice(0, USER_AGENT_MAX) : null;
}

/** An address Postgres's inet takes, or null. */
export function cleanIp(ip: string | undefined): string | null {
  return ip && isIP(ip) ? ip : null;
}

// ---- The certificate -----------------------------------------------------------------

export type CertificateInput = {
  title: string;
  bodySha256: string;
  signerName: string;
  signerEmail: string | null;
  acceptedAt: Date;
  ip: string | null;
  userAgent: string | null;
  consentVersion: string;
  practiceName: string;
};

/** The plain-text record stored on the acceptance and sent to both parties. */
export function buildCertificate(c: CertificateInput): string {
  const or = (v: string | null) => (v && v.trim() ? v : "not recorded");
  return [
    "Agreement acceptance certificate",
    `Agreement: ${c.title}`,
    `Document SHA-256: ${c.bodySha256}`,
    `Accepted by (typed name): ${c.signerName}`,
    `Signer email: ${or(c.signerEmail)}`,
    `Accepted at (UTC): ${c.acceptedAt.toISOString()}`,
    `IP address: ${or(c.ip)}`,
    `User agent: ${or(c.userAgent)}`,
    `Consent wording version: ${c.consentVersion}`,
    `Recorded by Meridies on behalf of ${c.practiceName}.`,
    NOT_CERTIFIED_LINE,
  ].join("\n");
}

// ---- The public page's content ----------------------------------------------------------

const PRE = "white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:15px;line-height:1.6;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px";

/**
 * The page body (inside <body>): every value escaped; a form only while it can be accepted.
 * Once accepted, anyone holding the link sees only the name, the time, the document's
 * fingerprint and what kind of record it is: never the signer's IP or browser, which stay
 * in the stored certificate, the two emails and the counselor's view.
 */
export function agreementPageBody(p: {
  title: string;
  bodyText: string;
  error: string | null;
  accepted?: { signerName: string; acceptedAt: string; bodySha256: string } | null;
}): string {
  const head = `<h1>${escapeHtml(p.title)}</h1>
<pre style="${PRE}">${escapeHtml(p.bodyText)}</pre>`;
  if (p.accepted) {
    return `${head}
<p><strong>Accepted by ${escapeHtml(p.accepted.signerName)}</strong> on ${escapeHtml(p.accepted.acceptedAt)} (UTC).</p>
<p style="color:#6b7280;font-size:13px">Document SHA-256: ${escapeHtml(p.accepted.bodySha256)}<br>${escapeHtml(NOT_CERTIFIED_LINE)}</p>`;
  }
  const error = p.error ? `<p style="color:#b91c1c" role="alert">${escapeHtml(p.error)}</p>` : "";
  return `${head}
${error}<form method="post">
<p><label for="signerName">Type your full name</label><br>
<input id="signerName" name="signerName" type="text" required minlength="2" maxlength="120" autocomplete="name" style="padding:8px;font-size:16px;width:100%;box-sizing:border-box"></p>
<p><label><input type="checkbox" name="consent" value="yes" required> ${escapeHtml(AGREEMENT_CONSENT_SENTENCE)}</label></p>
<button type="submit" style="padding:12px 18px;font-size:16px">Accept the agreement</button>
</form>
<p style="color:#6b7280;font-size:13px">${escapeHtml(NOT_CERTIFIED_LINE)} Your name, the time, your IP address and browser are recorded with a fingerprint of the text above.</p>`;
}

// ---- Emails ----------------------------------------------------------------------------------

export function agreementSentEmail(p: { title: string; url: string; senderName: string | null; recipientName: string }) {
  const from = p.senderName?.trim() || "Your counselor";
  const template = {
    heading: p.title,
    paragraphs: [
      p.recipientName ? `Hi ${p.recipientName},` : "Hello,",
      `${from} sent you an agreement to read: "${p.title}".`,
      "Open it with the button below. If you agree, type your name and tick the box. The link is private to you and works for 30 days.",
      "Reply to this email with any questions.",
    ],
    cta: { label: "Read the agreement", url: p.url },
    footnote: `Sent by ${from} through Meridies. ${NOT_CERTIFIED_LINE}`,
  };
  const recordTemplate = { ...template, cta: undefined, paragraphs: [...template.paragraphs, "[private agreement link omitted]"] };
  return {
    subject: `Agreement to review: ${p.title}`.slice(0, 200),
    html: brandedEmail(template),
    text: brandedText(template),
    recordText: brandedText(recordTemplate),
  };
}

/** The copy each party gets once the family accepts: the certificate, then the agreement text. */
export function acceptanceEmails(p: { title: string; bodyText: string; certificate: string; signerName: string; senderName: string | null }) {
  const make = (heading: string, intro: string) => {
    const template = {
      heading,
      paragraphs: [intro, p.certificate, "The agreement:", p.bodyText],
      footnote: "Keep this email as your copy. Meridies keeps the record.",
    };
    return { subject: heading.slice(0, 200), html: brandedEmail(template), text: brandedText(template) };
  };
  return {
    signer: make(`You accepted: ${p.title}`, `Thank you. This is your copy of the agreement you accepted${p.senderName ? ` with ${p.senderName}` : ""}.`),
    counselor: make(`${p.signerName} accepted: ${p.title}`, `${p.signerName} accepted the agreement. The certificate and the text they accepted are below.`),
  };
}
