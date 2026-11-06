/**
 * What a parent is told, and who counts as reachable.
 *
 * The composer used to send one template to everyone, so a parent read "Reply
 * to your counselor directly" as if they were the student, and had no way to
 * actually do it. This file is the parent's wording: pure functions, no I/O, so
 * the copy and the recipient rules are unit-tested (`test/unit/parent-comms.test.ts`).
 *
 * Type-only imports from studentMessages.ts keep this free of an import cycle.
 */

import type { FamilyContact, Recipient } from "./studentMessages.js";

export const SMS_MAX_CHARS = 1600;

export const normEmail = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim().toLowerCase();
  return t ? t : null;
};

/** "n/a", "-" and the like are no phone at all. */
export const normPhone = (v: string | null | undefined): string | null => {
  const t = (v ?? "").replace(/[^\d+]/g, "");
  return t ? t : null;
};

const firstWord = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0] ?? "";

const GREETING = /^(dear|hi|hello|hey|good\s+(morning|afternoon|evening))\b/i;

export type CopyContext = {
  /** The sending counselor's display name; null when it isn't known. */
  counselorName: string | null;
  /** The student the message is about. */
  studentName: string;
  /**
   * The body was translated into the family's language (it holds the translation, then the English).
   * It already greets them, in their language, so no English greeting or opener is put above it.
   */
  translated?: boolean;
};

/** The footer on anything a parent receives from their child's counselor. */
export function guardianFootnote(counselorName: string | null): string {
  return counselorName
    ? `Sent by ${counselorName} through Meridies. Reply to this email and ${counselorName} will receive it directly.`
    : "Sent through Meridies on behalf of your child's counselor. Reply to this email and the counselor will receive it directly.";
}

export type EmailTemplate = { heading: string; paragraphs: string[]; footnote: string };

function paragraphsOf(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The composer's email as the recipient should read it. A guardian gets a
 * greeting by name, a heading that says which student it is about, and a
 * footer that tells them replying to the email reaches the counselor (which it
 * now does: the send sets Reply-To). The student keeps their own wording.
 */
export function composerEmailTemplate(
  msg: { subject: string | null; body: string },
  to: Pick<Recipient, "kind" | "name">,
  ctx: CopyContext
): EmailTemplate {
  const paragraphs = paragraphsOf(msg.body);

  if (to.kind === "guardian") {
    const studentFirst = firstWord(ctx.studentName);
    const parentFirst = firstWord(to.name);
    const greeted = ctx.translated === true || (paragraphs[0] ? GREETING.test(paragraphs[0]) : false);
    return {
      heading: msg.subject?.trim() || (studentFirst ? `A note about ${studentFirst}` : "A note from your child's counselor"),
      paragraphs: greeted || !parentFirst ? paragraphs : [`Dear ${parentFirst},`, ...paragraphs],
      footnote: guardianFootnote(ctx.counselorName),
    };
  }

  return {
    heading: msg.subject?.trim() || "A note from your counselor",
    paragraphs,
    footnote: ctx.counselorName
      ? `Sent by ${ctx.counselorName} through Meridies. Reply to your counselor directly with any questions.`
      : "Sent by your counselor through Meridies. Reply to your counselor directly with any questions.",
  };
}

/**
 * A text to a parent opens with who it is from and which student it is about,
 * because a parent sees only a phone number. A body that already greets them is
 * left alone. Never longer than one SMS request allows.
 */
export function parentTextBody(body: string, to: Pick<Recipient, "name">, ctx: CopyContext): string {
  const text = body.trim();
  if (ctx.translated === true || GREETING.test(text)) return text.slice(0, SMS_MAX_CHARS);
  const parentFirst = firstWord(to.name);
  const studentFirst = firstWord(ctx.studentName);
  const sender = ctx.counselorName ?? "your child's counselor";
  const opener = `${parentFirst ? `Hi ${parentFirst}, ` : "Hi, "}it's ${sender}${studentFirst ? ` about ${studentFirst}` : ""}: `;
  return (opener + text).slice(0, SMS_MAX_CHARS);
}

/**
 * The guardians a message can reach on a channel: switched on, and with a real
 * address (email) or phone (text) on file. Pure; the caller has already checked
 * `copy_parents` and read the family (failing closed on a read error).
 */
export function pickParentRecipients(family: FamilyContact[], channel: "email" | "sms"): Recipient[] {
  return family
    .filter((g) => g.receivesMessages && (channel === "email" ? normEmail(g.email) : normPhone(g.phone)))
    .map((g) => ({ kind: "guardian" as const, id: g.id, name: g.name, email: g.email, phone: g.phone }));
}

/**
 * The footer on an accountability alert. The alert is about the student, so a
 * parent is told which student's counselor wrote and that replying reaches
 * them; the student (copied on it) is pointed at their own counselor.
 */
export function alertFootnote(to: "guardian" | "student", studentName: string | null, counselorName: string | null): string {
  if (to === "guardian") {
    const who = counselorName ?? (studentName ? `${firstWord(studentName)}'s counselor` : "your child's counselor");
    return `Sent by ${who} through Meridies. Reply to this email and ${counselorName ?? "they"} will receive it directly.`;
  }
  return studentName
    ? `Sent by ${counselorName ?? "your counselor"} through Meridies. Reply to your counselor directly with any questions.`
    : "Sent by your counselor through Meridies. Reply to your counselor directly with any questions.";
}

/**
 * A text from the contact page, to the parent or the student on the card.
 * A parent is told who it is from and which student it is about (they see only
 * a number); a student is just told who. A body that already greets is left alone.
 */
export function contactTextBody(
  body: string,
  to: { who: "parent" | "student"; name: string },
  ctx: CopyContext
): string {
  if (to.who === "parent") return parentTextBody(body, { name: to.name }, ctx);
  const text = body.trim();
  if (GREETING.test(text)) return text.slice(0, SMS_MAX_CHARS);
  const first = firstWord(to.name);
  const sender = ctx.counselorName ?? "your counselor";
  return `${first ? `Hi ${first}, ` : "Hi, "}it's ${sender}: ${text}`.slice(0, SMS_MAX_CHARS);
}

const OPT_OUT_NOTICE = " Reply STOP to opt out.";

/**
 * The first text to a number carries the opt-out line the carriers expect.
 * The message is trimmed to make room for it, never the other way round.
 */
export function withOptOutNotice(body: string, isFirstText: boolean): string {
  if (!isFirstText) return body;
  if (/reply stop/i.test(body)) return body.slice(0, SMS_MAX_CHARS);
  return body.slice(0, SMS_MAX_CHARS - OPT_OUT_NOTICE.length).trimEnd() + OPT_OUT_NOTICE;
}
