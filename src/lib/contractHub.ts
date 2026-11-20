/**
 * Contract Hub (migration 20261130000001; routes/contractHub.ts): the pure parts. A counselor uploads a PDF,
 * adds up to 4 signers, places their fields on the pages, sends it; each signer signs from an emailed link with
 * a typed or drawn signature. A bare-minimum port of SignuDoc's envelope model (github.com/NYLLON-SOFTWARE/signudoc,
 * MIT, Copyright (c) 2026 Nyllon Software). Typed or drawn acceptance, not a certified e-signature.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { brandedEmail, brandedText } from "./email.js";
import { HttpError } from "./errors.js";

export const HUB_BUCKET = "contract-hub";
export const HUB_MAX_BYTES = 10 * 1024 * 1024;
export const HUB_MAX_SIGNERS = 4;
export const HUB_MAX_FIELDS = 200;
export const HUB_UPLOAD_EXPIRES_IN = 7200;
/** A signing link works this long; Remind mints a new one and the old stops. */
export const HUB_LINK_DAYS = 30;
/** A drawn signature or initials, as the database keeps it (decoded PNG bytes). */
export const HUB_PNG_MAX_BYTES = 61440;

export const FIELD_TYPES = ["signature", "initials", "date", "name", "text"] as const;
export type HubFieldType = (typeof FIELD_TYPES)[number];
export type HubStatus = "draft" | "sent" | "completed" | "declined" | "voided";

export const hubUnavailable = () => new HttpError(503, "Contract Hub isn't switched on yet", "contract_hub_unavailable");

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const uploadBody = z.object({ sizeBytes: z.number().int().positive().max(HUB_MAX_BYTES, "A PDF can be at most 10 MB") }).strict();

const signerInput = z
  .object({
    name: z.string().trim().min(1, "Add each signer's name").max(120),
    email: z.string().trim().toLowerCase().email("Add a valid email for each signer").max(254),
  })
  .strict();

export const createBody = z
  .object({
    title: z.string().trim().min(1, "Add a title").max(160),
    fileName: z.string().trim().min(1).max(200),
    path: z.string().min(1).max(200),
    pageCount: z.number().int().min(1).max(500),
    signers: z.array(signerInput).min(1, "Add at least one signer").max(HUB_MAX_SIGNERS, `At most ${HUB_MAX_SIGNERS} signers`),
  })
  .strict();

const unit = z.number().finite().min(0).max(1);
export const fieldsBody = z
  .object({
    fields: z
      .array(
        z
          .object({
            signerId: z.string().uuid(),
            type: z.enum(FIELD_TYPES),
            page: z.number().int().min(1).max(500),
            x: unit,
            y: unit,
            w: z.number().finite().gt(0).max(1),
            h: z.number().finite().gt(0).max(1),
          })
          .strict()
          .refine((f) => f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001, "A field must sit on its page"),
      )
      .max(HUB_MAX_FIELDS, `At most ${HUB_MAX_FIELDS} fields`),
  })
  .strict();

const mark = z
  .object({
    kind: z.enum(["typed", "drawn"]),
    /** Typed: the text. Drawn: a PNG as a data URL or raw base64. */
    value: z.string().min(1).max(100_000),
  })
  .strict();

export const signBody = z
  .object({
    consent: z.literal(true, { errorMap: () => ({ message: "Agree to sign electronically first" }) }),
    signature: mark.optional(),
    initials: mark.optional(),
    values: z.record(z.string().uuid(), z.string().trim().min(1).max(200)).default({}),
  })
  .strict();

export const declineBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();

// ---------------------------------------------------------------------------
// Storage paths and the PDF
// ---------------------------------------------------------------------------

export const hubObjectPath = (counselorId: string) => `${counselorId}/${randomUUID()}.pdf`;
const OBJECT_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

/** True only for an object path the API could have named in this counselor's own folder. */
export function ownHubPath(path: unknown, counselorId: string): boolean {
  if (typeof path !== "string") return false;
  const m = OBJECT_PATH.exec(path);
  return !!m && m[1] === counselorId;
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

// ---------------------------------------------------------------------------
// Signing links
// ---------------------------------------------------------------------------

export const hashHubToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function mintHubToken(now = Date.now()): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashHubToken(token), expiresAt: new Date(now + HUB_LINK_DAYS * 86_400_000).toISOString() };
}
/** A token as minted: 43 base64url characters. Anything else is refused before the database is asked. */
export const isHubToken = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

// ---------------------------------------------------------------------------
// A drawn mark
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The raw base64 of a real PNG of at most HUB_PNG_MAX_BYTES, from a data URL or raw base64; else null. */
export function cleanPng(value: string): string | null {
  const raw = value.startsWith("data:image/png;base64,") ? value.slice("data:image/png;base64,".length) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length === 0 || bytes.length > HUB_PNG_MAX_BYTES) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  return bytes.toString("base64");
}

export type CleanMark = { kind: "typed"; text: string; png: null } | { kind: "drawn"; text: null; png: string };

/** A signature (120 characters typed) or initials (12) the signer sent, checked; or a 400 in words. */
export function cleanMark(m: { kind: "typed" | "drawn"; value: string }, what: "signature" | "initials"): CleanMark {
  if (m.kind === "drawn") {
    const png = cleanPng(m.value);
    if (!png) throw new HttpError(400, `That ${what} drawing is too detailed or isn't an image. Clear it and draw again.`, "bad_mark");
    return { kind: "drawn", text: null, png };
  }
  const text = m.value.trim().replace(/\s+/g, " ");
  const max = what === "initials" ? 12 : 120;
  if (!text || text.length > max) throw new HttpError(400, `Type your ${what} (at most ${max} characters).`, "bad_mark");
  return { kind: "typed", text, png: null };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type SignerLike = { id: string; name: string };
type FieldLike = { signer_id: string; type: string };

const names = (list: { name: string }[]) =>
  list.length <= 1 ? (list[0]?.name ?? "") : `${list.slice(0, -1).map((s) => s.name).join(", ")} and ${list[list.length - 1]!.name}`;

/** Why a draft can't be sent yet, or null. Every signer needs a signature field, as in SignuDoc. */
export function sendProblem(signers: SignerLike[], fields: FieldLike[]): string | null {
  if (signers.length === 0) return "Add at least one signer.";
  const missing = signers.filter((s) => !fields.some((f) => f.signer_id === s.id && f.type === "signature"));
  return missing.length ? `Place a signature field for ${names(missing)}.` : null;
}

/** What a signer must send: a signature when they have a signature field, initials likewise, and every name/text field filled. */
export function signProblem(
  mine: { id: string; type: string }[],
  body: { signature?: unknown; initials?: unknown; values: Record<string, string> },
): string | null {
  if (mine.some((f) => f.type === "signature") && !body.signature) return "Add your signature.";
  if (mine.some((f) => f.type === "initials") && !body.initials) return "Add your initials.";
  const empty = mine.filter((f) => (f.type === "name" || f.type === "text") && !body.values[f.id]?.trim());
  return empty.length ? `Fill in ${empty.length === 1 ? "the last field" : `the ${empty.length} empty fields`}.` : null;
}

/** "Nov 20, 2026", the date a date field takes when its signer finishes (UTC). */
export const signedDate = (now = new Date()) =>
  now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const pngUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  // PostgREST returns bytea as "\x" + hex.
  const hex = v.startsWith("\\x") ? v.slice(2) : null;
  return hex ? `data:image/png;base64,${Buffer.from(hex, "hex").toString("base64")}` : null;
};

export function toEnvelopeDTO(e: Row, signers: Row[], fields: Row[], events: Row[] = []) {
  return {
    id: String(e.id),
    title: String(e.title),
    fileName: String(e.file_name),
    pageCount: Number(e.page_count),
    status: String(e.status) as HubStatus,
    createdAt: String(e.created_at),
    sentAt: str(e.sent_at),
    completedAt: str(e.completed_at),
    voidedAt: str(e.voided_at),
    signers: signers.map(toSignerDTO),
    fields: fields.map(toFieldDTO),
    events: events.map((v) => ({ at: String(v.at), text: String(v.text) })),
  };
}

export function toSignerDTO(s: Row) {
  return {
    id: String(s.id),
    name: String(s.name),
    email: String(s.email),
    status: String(s.status) as "waiting" | "signed" | "declined",
    signedAt: str(s.signed_at),
    declinedAt: str(s.declined_at),
    declineReason: str(s.decline_reason),
    signature: markDTO(s.signature_kind, s.signature_text, s.signature_png),
    initials: markDTO(s.initials_kind, s.initials_text, s.initials_png),
  };
}

/** A signer's mark as the page draws it: typed text, or the drawn PNG as a data URL (only when the image was read). */
function markDTO(kind: unknown, text: unknown, png: unknown) {
  if (kind === "typed" && typeof text === "string") return { kind: "typed" as const, value: text };
  if (kind === "drawn") return { kind: "drawn" as const, value: pngUrl(png) };
  return null;
}

export function toFieldDTO(f: Row) {
  return {
    id: String(f.id),
    signerId: String(f.signer_id),
    type: String(f.type) as HubFieldType,
    page: Number(f.page),
    x: Number(f.x),
    y: Number(f.y),
    w: Number(f.w),
    h: Number(f.h),
    value: str(f.value),
  };
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export function signRequestEmail(p: { signerName: string; senderName: string; title: string; url: string; reminder: boolean }) {
  const t = {
    heading: p.reminder ? `Reminder: ${p.title} is waiting for your signature` : `${p.senderName} sent you ${p.title} to sign`,
    paragraphs: [
      `Hi ${p.signerName},`,
      `${p.senderName} asked you to review and sign ${p.title}. Open the document, add your signature, and press Finish. It takes about a minute, and you don't need an account.`,
      `The link works for ${HUB_LINK_DAYS} days.${p.reminder ? " Earlier links for this document no longer work." : ""}`,
    ],
    cta: { label: "Review and sign", url: p.url },
    footnote: "If you weren't expecting this, you can ignore it or decline from the document.",
  };
  return {
    subject: p.reminder ? `Reminder: please sign ${p.title}` : `Please sign: ${p.title}`,
    html: brandedEmail(t),
    text: brandedText(t),
    recordText: brandedText({ ...t, cta: { label: t.cta.label, url: "[private signing link omitted]" } }),
  };
}

export function outcomeEmail(p: { title: string; heading: string; line: string; url: string }) {
  const t = { heading: p.heading, paragraphs: [p.line], cta: { label: "Open in Contract Hub", url: p.url } };
  return { subject: `${p.heading}: ${p.title}`, html: brandedEmail(t), text: brandedText(t) };
}
