/**
 * One invoice layout for every place a family reads an invoice: the email
 * (`renderInvoiceEmail`, table-based and inline-styled for Gmail and Outlook,
 * with a plain-text twin) and the public pay page (`renderInvoicePage`,
 * routes/pay.ts). The app's tracker and Send preview draw the same layout in
 * React (meridies-app components/pipeline/InvoiceDocument.tsx) from the same
 * figures.
 *
 * Nothing here does arithmetic. Every amount is handed in already worked out
 * by lib/payments.ts (`planInvoice` for a new invoice, `deriveAccount` /
 * `invoiceOwed` for one on file); this only formats and escapes.
 *
 * The practice's identity (name, logo, accent) is the practice branding
 * (`firms` for a firm, `counselor_branding` for a solo counselor), read with
 * whatever client the caller has. A practice with no logo shows its name in
 * the brand serif instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { CORNER_RADIUS, FONTS, type InvoiceStyle } from "./invoiceStyle.js";
import { formatUsd, type InvoiceState } from "./payments.js";

type Row = Record<string, unknown>;

export type PracticeIdentity = { name: string; logoUrl: string | null; accentColor: string | null };

/** What a family is told about an invoice. "Due" is the API's `open`. */
export type InvoiceStatus = "paid" | "due" | "overdue" | "void";
export const STATUS_LABEL: Record<InvoiceStatus, string> = { paid: "Paid", due: "Due", overdue: "Overdue", void: "Void" };

export function invoiceStatus(state: InvoiceState): InvoiceStatus {
  return state === "open" ? "due" : state;
}

export type InvoiceLine = { description: string; detail: string | null; amountCents: number };

export type InvoiceDocument = {
  practice: PracticeIdentity;
  /** Null for a draft (the Send preview): it is numbered when it is sent. */
  number: string | null;
  issuedOn: string;
  dueOn: string;
  billTo: { name: string; contactName: string | null; email: string | null };
  lines: InvoiceLine[];
  subtotalCents: number;
  creditAppliedCents: number;
  alreadyPaidCents: number;
  amountDueCents: number;
  status: InvoiceStatus;
  /** The pay link; the button shows only while something is owed. */
  payUrl: string | null;
  /** "Payment 2 of 3 for Senior package ($6,000 over 6 months)." */
  plan: string | null;
  /** Who sent it and where a reply goes. */
  footnote: string | null;
  // ---- Invoice composer (all optional: an invoice without them is drawn exactly as before) ----
  /** The practice's look (invoice_style / the invoice's snapshot). Absent: the original design. */
  style?: InvoiceStyle | null;
  /** Other ways to pay with the practice's instructions (card is the button, not listed). */
  methods?: Array<{ key: string; label: string; instructions: string }>;
  /** The consultant's note to the family. */
  note?: string | null;
  /** The card processing fee passed to the family; shown only by card. Absent/0: none. */
  feeCents?: number;
  /** The invoice's own page, for an invoice with no pay button (manual ways to pay only). */
  viewUrl?: string | null;
  /** A contract on the pay page: its title, and the path a click on "Review" posts to. */
  contract?: { title: string; action: string } | null;
};

/**
 * An agreement sent in the same email as the invoice (lib/invoiceAgreement.ts): its title and the
 * private /agree/:token link. `url: null` draws the record copy, with the link left out, for
 * message_deliveries. Only the email carries it; the pay page never does.
 */
export type InvoiceEmailAgreement = { title: string; url: string | null };

/** What the record copy says where the agreement's private link was. */
export const AGREEMENT_LINK_OMITTED = "[private agreement link omitted]";

/**
 * The agreement block's words (reviewed 2026-11-11 with the rest of the agreement copy). The family is
 * asked to read the agreement first and then pay: the agreement says what the invoice is for, so it
 * comes before the Pay by card button. Paying never depends on accepting.
 */
export const AGREEMENT_HEADING = "Agreement to review";
export const AGREEMENT_BUTTON = "Review and accept the agreement";
export function agreementIntro(title: string, beforePaying: boolean): string {
  return beforePaying
    ? `This invoice comes with an agreement, "${title}". Please read it before you pay. If you agree, accept it by typing your name.`
    : `This invoice comes with an agreement, "${title}". Please read it. If you agree, accept it by typing your name.`;
}
export const AGREEMENT_FINE_PRINT = "The link is private to you and works for 30 days. Typed-name acceptance; not a certified electronic signature.";

const DEFAULT_ACCENT = "#12402e";

// ---- Reading the practice ----------------------------------------------------------

/** "Ava Hartwell family"; a card already named "Rivera Family" isn't doubled. */
export function familyLabel(studentName: string): string {
  const n = studentName.trim();
  if (!n) return "Family";
  return /\bfamily$/i.test(n) ? n : `${n} family`;
}

/** Who the invoice is addressed to, from the pipeline contact. */
export function billToOf(contact: Row): InvoiceDocument["billTo"] {
  const parent = String(contact.parent_name ?? "").trim();
  const email = String(contact.parent_email || contact.student_email || "").trim();
  return { name: familyLabel(String(contact.student_name ?? "")), contactName: parent || null, email: email || null };
}

/**
 * The practice an invoice comes from: a firm's name, logo and accent, or a
 * solo counselor's own branding under their name. Never fails: a read that
 * errors (or a database without `counselor_branding`) gives the name alone.
 */
export async function readPractice(
  db: SupabaseClient,
  scope: { firmId: string | null; counselorId: string },
  fallbackName: string | null = null
): Promise<PracticeIdentity> {
  const fallback = (fallbackName ?? "").trim() || "Your counselor";
  try {
    if (scope.firmId) {
      const { data } = await db.from("firms").select("name, logo_url, accent_color").eq("id", scope.firmId).maybeSingle();
      const r = (data as Row | null) ?? {};
      return {
        name: String(r.name ?? "").trim() || fallback,
        logoUrl: typeof r.logo_url === "string" ? r.logo_url : null,
        accentColor: isHex(r.accent_color) ? r.accent_color : null,
      };
    }
    const [profile, branding] = await Promise.all([
      fallbackName ? Promise.resolve({ data: null }) : db.from("profiles").select("full_name").eq("id", scope.counselorId).maybeSingle(),
      db.from("counselor_branding").select("logo_url, accent_color").eq("counselor_id", scope.counselorId).maybeSingle(),
    ]);
    const p = (profile.data as Row | null) ?? {};
    const b = (branding.data as Row | null) ?? {};
    return {
      name: String(p.full_name ?? "").trim() || fallback,
      logoUrl: typeof b.logo_url === "string" ? b.logo_url : null,
      accentColor: isHex(b.accent_color) ? b.accent_color : null,
    };
  } catch {
    return { name: fallback, logoUrl: null, accentColor: null };
  }
}

// ---- Colour and safety ---------------------------------------------------------------

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of a colour against white (WCAG ratio). */
export function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/**
 * The practice's accent, darkened until white text on it (the pay button, the
 * rule under the header) reads at 4.5:1. A pale brand yellow still shows as
 * itself, only deeper. No accent is the app's own green.
 */
export function readableAccent(hex: string | null | undefined): string {
  if (!isHex(hex)) return DEFAULT_ACCENT;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let out = hex.toLowerCase();
  for (let i = 0; i < 40 && contrastOnWhite(out) < 4.5; i++) {
    [r, g, b] = [r, g, b].map((c) => Math.floor(c * 0.92));
    out = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  return out;
}

/**
 * Text and attribute-safe: double quotes too, since names land in alt="".
 * Every attribute here is double-quoted, so an apostrophe ("O'Brien") stays as typed.
 */
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** A logo address an email or the pay page may load: https, or plain http on a loopback host (the local stack). */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return u.toString();
    return null;
  } catch {
    return null;
  }
}

/** "Nov 9, 2026" from "2026-11-09", without a timezone shift. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** The "reply with questions" line, unless the footnote already says where a reply goes. */
function replyLine(d: InvoiceDocument): string | null {
  return d.footnote && /\breply\b/i.test(d.footnote) ? null : "Reply to this email with any questions about the invoice.";
}

const PILL: Record<InvoiceStatus, { fg: string; bg: string; border: string }> = {
  paid: { fg: "#1c6b47", bg: "#eaf2ed", border: "#cfe3d6" },
  due: { fg: "#1e4e6e", bg: "#e9eff4", border: "#cddbe6" },
  overdue: { fg: "#93382a", bg: "#f7ebe8", border: "#ecd2cc" },
  void: { fg: "#5b635d", bg: "#f1f2ef", border: "#dfe2dc" },
};


// ---- Composer extras: ways to pay, the note, the card fee ---------------------------------

/** What the card button asks for: what is due, plus the card fee when the practice passes it on. */
export const cardTotalCents = (d: InvoiceDocument) => d.amountDueCents + Math.max(0, d.feeCents ?? 0);

/** The button's words: the style's own label, else "Pay $X by card" as it always read. */
export function payButtonLabel(d: InvoiceDocument): string {
  const custom = d.style?.buttonLabel;
  return custom && custom !== "Pay by card" ? custom : `Pay ${formatUsd(cardTotalCents(d))} by card`;
}

export const feeSentence = (d: InvoiceDocument): string | null =>
  (d.feeCents ?? 0) > 0
    ? `Paying by card adds a ${formatUsd(d.feeCents ?? 0)} processing fee (${formatUsd(cardTotalCents(d))} in all). Other ways to pay have no fee.`
    : null;

const waysToPay = (d: InvoiceDocument) => (d.status === "due" || d.status === "overdue" ? d.methods ?? [] : []);

/** Whether the document carries a Pay by card button (the pay page passes "": its button posts to itself). */
export function showsPayButton(d: InvoiceDocument): boolean {
  return d.payUrl !== null && d.amountDueCents > 0 && (d.status === "due" || d.status === "overdue");
}

/** The sentence under the total, when one is needed. */
export function statusNote(d: InvoiceDocument): string | null {
  if (d.status === "void") return "This invoice was cancelled. There's nothing to pay.";
  if (d.status !== "paid") return null;
  // A draft can only be covered already by held credit (planInvoice refuses one payments alone cover).
  return d.number === null ? "Your credit covers this invoice in full. There's nothing to pay." : "Paid in full. Thank you.";
}

type TotalRow = { label: string; value: string; tone?: "credit" };
function totalRows(d: InvoiceDocument): TotalRow[] {
  const rows: TotalRow[] = [{ label: "Subtotal", value: formatUsd(d.subtotalCents) }];
  if (d.creditAppliedCents > 0) rows.push({ label: "Credit applied", value: `−${formatUsd(d.creditAppliedCents)}`, tone: "credit" });
  if (d.alreadyPaidCents > 0) rows.push({ label: "Already paid", value: `−${formatUsd(d.alreadyPaidCents)}`, tone: "credit" });
  return rows;
}

// ---- The email -----------------------------------------------------------------------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Newsreader,Georgia,'Times New Roman',serif";
const INK = "#141815";
const MUTED = "#5b635d";
const HAIR = "#e4e7e1";

/** The font stacks a document draws with: the style's, else the original design's. */
function fontsOf(d: InvoiceDocument): { font: string; serif: string } {
  const f = d.style ? FONTS[d.style.fontKey].stack : null;
  return { font: f ?? FONT, serif: f ?? SERIF };
}
const radiusOf = (d: InvoiceDocument) => (d.style ? CORNER_RADIUS[d.style.corner] : { button: 10, card: 14 });
const accentOf = (d: InvoiceDocument) => readableAccent(d.style?.accentColor ?? d.practice.accentColor);

function emailBrand(d: InvoiceDocument): string {
  const { serif: SERIF } = fontsOf(d);
  const logo = d.style?.showLogo === false ? null : safeImageUrl(d.practice.logoUrl);
  if (logo) {
    return `<img src="${esc(logo)}" alt="${esc(d.practice.name)}" height="44" style="display:block;height:44px;max-height:44px;max-width:200px;border:0;outline:none;text-decoration:none;">`;
  }
  return `<span style="font-family:${SERIF};font-size:24px;line-height:1.2;font-weight:500;color:${INK};">${esc(d.practice.name)}</span>`;
}

function emailPill(s: InvoiceStatus, FONT: string): string {
  const p = PILL[s];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td bgcolor="${p.bg}" style="background:${p.bg};border:1px solid ${p.border};border-radius:999px;padding:4px 12px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.02em;color:${p.fg};white-space:nowrap;">${STATUS_LABEL[s]}</td></tr></table>`;
}

/** The agreement block, under the header and above the bill-to: first in the email, before the invoice and its Pay button. */
function agreementHtml(a: InvoiceEmailAgreement, accent: string, beforePaying: boolean, FONT: string, radius: number): string {
  const button = a.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
      <td align="center" bgcolor="${accent}" style="background:${accent};border-radius:${radius}px;">
        <a href="${esc(a.url)}" style="display:block;padding:13px 20px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:${radius}px;">${AGREEMENT_BUTTON}</a>
      </td>
    </tr></table>`
    : `<div style="margin-top:14px;font-family:${FONT};font-size:13px;color:${MUTED};">${esc(AGREEMENT_LINK_OMITTED)}</div>`;
  return `<tr><td style="padding:24px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f8f5" style="background:#f7f8f5;border:1px solid ${HAIR};border-radius:12px;border-collapse:separate;"><tr>
      <td style="padding:18px 20px;font-family:${FONT};">
        <div style="font-size:12px;font-weight:600;color:${MUTED};">${AGREEMENT_HEADING}</div>
        <div dir="auto" style="padding-top:4px;font-size:16px;font-weight:600;color:${INK};">${esc(a.title)}</div>
        <div dir="auto" style="padding-top:6px;font-size:14px;line-height:1.55;color:${INK};">${esc(agreementIntro(a.title, beforePaying))}</div>
        ${button}
        <div style="padding-top:10px;font-size:12px;line-height:1.5;color:${MUTED};">${esc(AGREEMENT_FINE_PRINT)}</div>
      </td>
    </tr></table>
  </td></tr>
  `;
}

/** The invoice email's HTML: tables and inline styles only, light on purpose (dark-mode clients keep the paper white). */
export function renderInvoiceEmailHtml(d: InvoiceDocument, agreement: InvoiceEmailAgreement | null = null): string {
  const accent = accentOf(d);
  const { font: FONT } = fontsOf(d);
  const radius = radiusOf(d);
  const center = d.style?.headerAlign === "center";
  const title = d.number ? `Invoice ${d.number}` : "Invoice";
  const meta = [
    ["Invoice", d.number ?? "Draft"],
    ["Issued", longDate(d.issuedOn)],
    ["Due", longDate(d.dueOn)],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;font-family:${FONT};font-size:13px;color:${MUTED};white-space:nowrap;">${k}</td><td align="right" style="padding:2px 0;font-family:${FONT};font-size:13px;font-weight:600;color:${INK};white-space:nowrap;">${esc(v)}</td></tr>`
    )
    .join("");
  const billTo = [
    `<div style="font-family:${FONT};font-size:15px;font-weight:600;color:${INK};">${esc(d.billTo.name)}</div>`,
    d.billTo.contactName ? `<div style="font-family:${FONT};font-size:13px;color:${MUTED};padding-top:2px;">${esc(d.billTo.contactName)}</div>` : "",
    d.billTo.email ? `<div style="font-family:${FONT};font-size:13px;color:${MUTED};padding-top:2px;">${esc(d.billTo.email)}</div>` : "",
  ].join("");
  const lines = d.lines
    .map(
      (l) => `<tr>
  <td style="padding:14px 0;border-bottom:1px solid ${HAIR};font-family:${FONT};" valign="top">
    <div dir="auto" style="font-size:15px;font-weight:600;color:${INK};">${esc(l.description)}</div>${
      l.detail ? `<div dir="auto" style="font-size:13px;color:${MUTED};padding-top:3px;">${esc(l.detail)}</div>` : ""
    }
  </td>
  <td align="right" valign="top" style="padding:14px 0 14px 16px;border-bottom:1px solid ${HAIR};font-family:${FONT};font-size:15px;color:${INK};white-space:nowrap;">${esc(formatUsd(l.amountCents))}</td>
</tr>`
    )
    .join("");
  const totals = totalRows(d)
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;font-family:${FONT};font-size:14px;color:${MUTED};">${r.label}</td><td align="right" style="padding:6px 0;font-family:${FONT};font-size:14px;color:${r.tone === "credit" ? "#1c6b47" : INK};white-space:nowrap;">${esc(r.value)}</td></tr>`
    )
    .join("");
  const note = statusNote(d);
  const pay = showsPayButton(d)
    ? `<tr><td style="padding:24px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td align="center" bgcolor="${accent}" style="background:${accent};border-radius:${radius.button}px;">
      <a href="${esc(d.payUrl ?? "")}" style="display:block;padding:15px 20px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:${radius.button}px;">${esc(payButtonLabel(d))}</a>
    </td>
  </tr></table>
  <div style="padding-top:10px;text-align:center;font-family:${FONT};font-size:12px;color:${MUTED};">${
    feeSentence(d) ? `${esc(feeSentence(d) ?? "")} ` : ""
  }Paid securely through Stripe, straight to ${esc(d.practice.name)}.</div>
</td></tr>`
    : "";
  const plan = d.plan
    ? `<tr><td style="padding:20px 32px 0;font-family:${FONT};font-size:13px;line-height:1.55;color:${MUTED};" dir="auto">${esc(d.plan)}</td></tr>`
    : "";
  const footnote = d.footnote ? `<div style="padding-top:6px;">${esc(d.footnote)}</div>` : "";
  const footerText = d.style?.footerText ? `<div dir="auto" style="padding-top:6px;">${esc(d.style.footerText)}</div>` : "";
  const ways = waysToPay(d).filter((m) => m.key !== "card");
  const waysHtml = ways.length
    ? `<tr><td style="padding:24px 32px 0;">
  <div style="font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};padding-bottom:8px;">Other ways to pay</div>
  ${ways
    .map(
      (m) =>
        `<div dir="auto" style="font-family:${FONT};font-size:14px;line-height:1.55;color:${INK};padding-bottom:8px;"><strong>${esc(m.label)}</strong>${
          m.instructions ? `<br><span style="color:${MUTED};">${esc(m.instructions).replace(/\n/g, "<br>")}</span>` : ""
        }</div>`
    )
    .join("")}
</td></tr>`
    : "";
  const viewHtml =
    d.viewUrl && !showsPayButton(d)
      ? `<tr><td style="padding:16px 32px 0;font-family:${FONT};font-size:13px;"><a href="${esc(d.viewUrl)}" style="color:${accent};">View this invoice online</a></td></tr>`
      : "";
  const noteHtml = d.note
    ? `<tr><td style="padding:20px 32px 0;"><div dir="auto" style="font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};white-space:pre-line;border-left:3px solid ${accent};padding-left:12px;">${esc(d.note)}</div></td></tr>`
    : "";
  const feeHtml =
    feeSentence(d) && !showsPayButton(d)
      ? `<tr><td style="padding:12px 32px 0;font-family:${FONT};font-size:12px;color:${MUTED};">${esc(feeSentence(d) ?? "")}</td></tr>`
      : "";
  const agree = agreement ? agreementHtml(agreement, accent, showsPayButton(d), FONT, radius.button) : "";
  const headerRow = center
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-bottom:12px;">${emailBrand(d)}</td></tr><tr><td align="center">${emailPill(d.status, FONT)}</td></tr></table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle">${emailBrand(d)}</td>
      <td valign="middle" align="right">${emailPill(d.status, FONT)}</td>
    </tr></table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f3;" bgcolor="#f5f6f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f6f3" style="background:#f5f6f3;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;background:#ffffff;border:1px solid ${HAIR};border-radius:${radius.card}px;border-collapse:separate;">
  <tr><td height="4" bgcolor="${accent}" style="height:4px;line-height:4px;font-size:0;background:${accent};border-radius:${radius.card}px ${radius.card}px 0 0;">&nbsp;</td></tr>
  <tr><td style="padding:28px 32px 0;">
    ${headerRow}
  </td></tr>
  ${agree}<tr><td style="padding:28px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top" style="padding-bottom:16px;">
        <div style="font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};padding-bottom:6px;">Bill to</div>
        ${billTo}
      </td>
      <td valign="top" align="right" style="padding-bottom:16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">${meta}</table>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:8px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 0 8px;border-bottom:1px solid ${HAIR};font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};">Description</td>
        <td align="right" style="padding:0 0 8px;border-bottom:1px solid ${HAIR};font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};">Amount</td>
      </tr>
      ${lines}
    </table>
  </td></tr>
  <tr><td style="padding:10px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${totals}
      <tr>
        <td style="padding:12px 0 0;border-top:1px solid ${HAIR};font-family:${FONT};font-size:15px;font-weight:700;color:${INK};">Amount due</td>
        <td align="right" style="padding:12px 0 0;border-top:1px solid ${HAIR};font-family:${FONT};font-size:24px;font-weight:700;color:${INK};white-space:nowrap;">${esc(formatUsd(d.amountDueCents))}</td>
      </tr>
      ${note ? `<tr><td colspan="2" align="right" style="padding:6px 0 0;font-family:${FONT};font-size:13px;color:${MUTED};">${esc(note)}</td></tr>` : ""}
    </table>
  </td></tr>
  ${pay}
  ${feeHtml}
  ${waysHtml}
  ${viewHtml}
  ${noteHtml}
  ${plan}
  <tr><td style="padding:28px 32px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="border-top:1px solid ${HAIR};padding-top:16px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
        <div style="font-weight:600;color:${INK};">${esc(d.practice.name)}</div>${replyLine(d) ? `<div style="padding-top:6px;">${esc(replyLine(d) ?? "")}</div>` : ""}
        ${footnote}${footerText}
      </td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text part: the same document, line by line. */
export function renderInvoiceEmailText(d: InvoiceDocument, agreement: InvoiceEmailAgreement | null = null): string {
  const out = [
    d.practice.name,
    `${d.number ? `Invoice ${d.number}` : "Invoice"} · ${STATUS_LABEL[d.status]}`,
    `Issued ${longDate(d.issuedOn)} · Due ${longDate(d.dueOn)}`,
    "",
    ...(agreement
      ? [
          `${AGREEMENT_HEADING}: ${agreement.title}`,
          agreementIntro(agreement.title, showsPayButton(d)),
          `${AGREEMENT_BUTTON}:`,
          agreement.url ?? AGREEMENT_LINK_OMITTED,
          AGREEMENT_FINE_PRINT,
          "",
        ]
      : []),
    "Bill to",
    d.billTo.name,
    ...(d.billTo.contactName ? [d.billTo.contactName] : []),
    ...(d.billTo.email ? [d.billTo.email] : []),
    "",
    ...d.lines.flatMap((l) => [`${l.description}: ${formatUsd(l.amountCents)}`, ...(l.detail ? [`  ${l.detail}`] : [])]),
    "",
    ...totalRows(d).map((r) => `${r.label}: ${r.value}`),
    `Amount due: ${formatUsd(d.amountDueCents)}`,
  ];
  const note = statusNote(d);
  if (note) out.push(note);
  if (showsPayButton(d)) out.push("", `${d.style?.buttonLabel && d.style.buttonLabel !== "Pay by card" ? d.style.buttonLabel : `Pay ${formatUsd(cardTotalCents(d))} by card`}:`, d.payUrl ?? "");
  const fee = feeSentence(d);
  if (fee) out.push(fee);
  const ways = waysToPay(d).filter((m) => m.key !== "card");
  if (ways.length) out.push("", "Other ways to pay:", ...ways.map((m) => `- ${m.label}${m.instructions ? `: ${m.instructions}` : ""}`));
  if (d.viewUrl && !showsPayButton(d)) out.push("", `View this invoice online: ${d.viewUrl}`);
  if (d.note) out.push("", d.note);
  if (d.plan) out.push("", d.plan);
  out.push("");
  const reply = replyLine(d);
  if (reply) out.push(reply);
  if (d.footnote) out.push(d.footnote);
  if (d.style?.footerText) out.push(d.style.footerText);
  return out.join("\n");
}

/**
 * The invoice as a text message (the composer's Text tab): one short message with who, what, when and the link.
 * Plain text, no HTML; the practice's note and ways to pay are on the page the link opens, not in the text.
 */
export function renderInvoiceSms(d: InvoiceDocument, recipientFirst: string | null = null): string {
  const hi = recipientFirst ? `Hi ${recipientFirst}, ` : "";
  const what = d.number ? `invoice ${d.number}` : "an invoice";
  const owed = d.amountDueCents > 0 ? `${formatUsd(d.amountDueCents)} due ${longDate(d.dueOn)}` : "nothing due";
  const link = d.payUrl ? ` View and pay: ${d.payUrl}` : d.viewUrl ? ` View it here: ${d.viewUrl}` : "";
  return `${hi}${d.practice.name} sent ${what}: ${owed}.${link}`;
}

/**
 * The invoice email. With an agreement, the same document with the agreement block first, plus
 * `recordText`: the text with the agreement's private link left out, for message_deliveries (an
 * email carrying a one-time link records this instead). Without one, exactly the invoice email.
 */
export function renderInvoiceEmail(d: InvoiceDocument, agreement: InvoiceEmailAgreement | null = null): { html: string; text: string; recordText?: string } {
  if (!agreement) return { html: renderInvoiceEmailHtml(d), text: renderInvoiceEmailText(d) };
  return {
    html: renderInvoiceEmailHtml(d, agreement),
    text: renderInvoiceEmailText(d, agreement),
    recordText: renderInvoiceEmailText(d, { ...agreement, url: null }),
  };
}

// ---- The pay page ----------------------------------------------------------------------

const PAGE_CSS = `
:root{--ink:#141815;--muted:#5b635d;--hair:#e4e7e1;--paper:#ffffff;--ground:#f5f6f3;--credit:#1c6b47;color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:40px 16px 48px}
.doc{background:var(--paper);border:1px solid var(--hair);border-radius:16px;overflow:hidden;box-shadow:0 12px 28px -14px rgba(20,24,21,.14)}
.doc{border-radius:var(--r,16px);font-family:var(--font,inherit)}
.top.center{flex-direction:column;gap:12px}
.bar{height:4px;background:var(--accent)}
.ways{margin-top:24px}.ways .k{margin-bottom:8px}.way{font-size:14px;margin-bottom:8px}.way span{display:block;color:var(--muted);white-space:pre-line}
.pnote{margin-top:20px;padding-left:12px;border-left:3px solid var(--accent);white-space:pre-line;font-size:14px}
.contract{margin-top:24px;border:1px solid var(--hair);border-radius:12px;padding:16px 18px}.contract form{margin:12px 0 0}
.contract button{font-size:15px;padding:13px 20px}
.in{padding:28px 32px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand img{display:block;height:44px;max-width:200px;object-fit:contain}
.brand span{font-family:Newsreader,Georgia,"Times New Roman",serif;font-size:24px;font-weight:500;line-height:1.2}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;letter-spacing:.02em;white-space:nowrap;border:1px solid}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.p-paid{color:#1c6b47;background:#eaf2ed;border-color:#cfe3d6}.p-due{color:#1e4e6e;background:#e9eff4;border-color:#cddbe6}
.p-overdue{color:#93382a;background:#f7ebe8;border-color:#ecd2cc}.p-void{color:#5b635d;background:#f1f2ef;border-color:#dfe2dc}
.head{display:flex;justify-content:space-between;gap:24px;margin-top:28px}
.k{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.who{font-weight:600}.sub{font-size:13px;color:var(--muted)}
dl{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 16px;font-size:13px}
dt{color:var(--muted)}dd{margin:0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;margin-top:24px}
th{font-size:12px;font-weight:600;color:var(--muted);text-align:left;padding:0 0 8px;border-bottom:1px solid var(--hair)}
th:last-child,td.amt{text-align:right}
td{padding:14px 0;border-bottom:1px solid var(--hair);vertical-align:top}
td.amt{padding-left:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.d1{font-weight:600}.d2{font-size:13px;color:var(--muted);margin-top:3px}
.totals{margin:10px 0 0 auto;max-width:320px}
.row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}
.row b{font-weight:400;color:var(--ink)}.row .cr{color:var(--credit)}
.due{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--hair);margin-top:6px;padding-top:12px;font-weight:700}
.due strong{font-size:26px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.note{text-align:right;font-size:13px;color:var(--muted);margin-top:6px}
form{margin:24px 0 0}
button{width:100%;border:0;border-radius:var(--rb,10px);background:var(--accent);color:#fff;font-family:inherit;font-weight:700;font-size:16px;line-height:1;padding:16px 20px;cursor:pointer}
button:hover{filter:brightness(1.08)}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.fine{text-align:center;font-size:12px;color:var(--muted);margin-top:10px}
.plan{font-size:13px;color:var(--muted);margin-top:20px}
.foot{border-top:1px solid var(--hair);margin-top:28px;padding-top:16px;font-size:12px;color:var(--muted)}
.foot b{color:var(--ink);font-weight:600}
.msg{text-align:center;padding:40px 32px}.msg h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}.msg p{margin:0;color:var(--muted)}
@media (max-width:520px){.in{padding:22px 20px}.head{flex-direction:column;gap:16px}dl{justify-self:start}.totals{max-width:none}.msg{padding:32px 20px}}
@media (prefers-color-scheme:dark){:root{--ink:#e6ebe7;--muted:#9aa59e;--hair:#26302b;--paper:#151d19;--ground:#0f1512;--credit:#79c79c}
.doc{box-shadow:none}.brand img{background:#fff;border-radius:8px;padding:4px}
.p-paid{color:#79c79c;background:#17271f;border-color:#24402f}.p-due{color:#8bb8db;background:#15212b;border-color:#24384a}
.p-overdue{color:#ec8f7d;background:#2c1915;border-color:#4a2a23}.p-void{color:#9aa59e;background:#1b231f;border-color:#2c3630}}
`;

export const PAGE_STYLE = PAGE_CSS.trim();

/** The pay page's document, with the Pay by card button while something is owed. */
export function renderInvoicePageBody(d: InvoiceDocument): string {
  const logo = d.style?.showLogo === false ? null : safeImageUrl(d.practice.logoUrl);
  const brand = logo ? `<img src="${esc(logo)}" alt="${esc(d.practice.name)}">` : `<span>${esc(d.practice.name)}</span>`;
  const lines = d.lines
    .map(
      (l) =>
        `<tr><td><div class="d1" dir="auto">${esc(l.description)}</div>${l.detail ? `<div class="d2" dir="auto">${esc(l.detail)}</div>` : ""}</td><td class="amt">${esc(formatUsd(l.amountCents))}</td></tr>`
    )
    .join("");
  const totals = totalRows(d)
    .map((r) => `<div class="row"><span>${r.label}</span><b${r.tone === "credit" ? ' class="cr"' : ""}>${esc(r.value)}</b></div>`)
    .join("");
  const note = statusNote(d);
  const pay = showsPayButton(d)
    ? `<form method="post"><button type="submit">${esc(payButtonLabel(d))}</button></form><p class="fine">${
        feeSentence(d) ? `${esc(feeSentence(d) ?? "")} ` : ""
      }You'll pay on Stripe's secure page. The payment goes straight to ${esc(d.practice.name)}.</p>`
    : "";
  const ways = waysToPay(d).filter((m) => m.key !== "card");
  const waysHtml = ways.length
    ? `<div class="ways"><div class="k">Other ways to pay</div>${ways
        .map((m) => `<div class="way" dir="auto"><b>${esc(m.label)}</b>${m.instructions ? `<span>${esc(m.instructions)}</span>` : ""}</div>`)
        .join("")}</div>`
    : "";
  const noteHtml = d.note ? `<div class="pnote" dir="auto">${esc(d.note)}</div>` : "";
  const contractHtml =
    d.contract && d.status !== "void"
      ? `<div class="contract"><div class="k">${esc(AGREEMENT_HEADING)}</div><div class="who" dir="auto">${esc(d.contract.title)}</div><form method="post" action="${esc(d.contract.action)}"><button type="submit">${esc(AGREEMENT_BUTTON)}</button></form></div>`
      : "";
  const vars = [`--accent:${accentOf(d)}`];
  if (d.style) vars.push(`--r:${CORNER_RADIUS[d.style.corner].card + 2}px`, `--rb:${CORNER_RADIUS[d.style.corner].button}px`, `--font:${FONTS[d.style.fontKey].stack}`);
  return `<article class="doc" style="${vars.join(";")}">
<div class="bar"></div>
<div class="in">
  <div class="top${d.style?.headerAlign === "center" ? " center" : ""}"><div class="brand">${brand}</div><span class="pill p-${d.status}">${STATUS_LABEL[d.status]}</span></div>
  <div class="head">
    <div><div class="k">Bill to</div><div class="who" dir="auto">${esc(d.billTo.name)}</div>${
      d.billTo.contactName ? `<div class="sub" dir="auto">${esc(d.billTo.contactName)}</div>` : ""
    }</div>
    <dl><dt>Invoice</dt><dd>${esc(d.number ?? "Draft")}</dd><dt>Issued</dt><dd>${esc(longDate(d.issuedOn))}</dd><dt>Due</dt><dd>${esc(longDate(d.dueOn))}</dd></dl>
  </div>
  <table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table>
  <div class="totals">${totals}<div class="due"><span>Amount due</span><strong>${esc(formatUsd(d.amountDueCents))}</strong></div>${
    note ? `<p class="note">${esc(note)}</p>` : ""
  }</div>
  ${pay}
  ${waysHtml}
  ${contractHtml}
  ${noteHtml}
  ${d.plan ? `<p class="plan" dir="auto">${esc(d.plan)}</p>` : ""}
  <div class="foot"><b>${esc(d.practice.name)}</b> · Questions? Reply to the invoice email.${d.footnote ? `<br>${esc(d.footnote)}` : ""}${d.style?.footerText ? `<br>${esc(d.style.footerText)}` : ""}</div>
</div>
</article>`;
}

/** A short message in the same card (an invalid link, card payments off, the thank-you). */
export function renderPageMessage(heading: string, text: string): string {
  return `<article class="doc" style="--accent:${DEFAULT_ACCENT}"><div class="bar"></div><div class="msg"><h1>${esc(heading)}</h1><p>${esc(text)}</p></div></article>`;
}

/** A whole pay page. */
export function renderPayPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** The pay page's CSP image source for a document's logo: its own origin, or nothing. */
export function logoOrigin(d: InvoiceDocument | null): string | null {
  const u = safeImageUrl(d?.practice.logoUrl);
  return u ? new URL(u).origin : null;
}
