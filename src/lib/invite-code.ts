/**
 * Server-side mirror of meridies-app/lib/invite.ts — same alphabet, same
 * `ABC-123` format, so codes look identical whichever side generates them.
 */
import { randomInt } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const INVITE_CODE_LENGTH = 6;

export function generateInviteCode(): string {
  let raw = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return formatInviteCode(raw);
}

/** Insert the dash and normalize casing: "abc123" -> "ABC-123". */
export function formatInviteCode(raw: string): string {
  const cleaned = normalizeInviteCode(raw).slice(0, INVITE_CODE_LENGTH);
  if (cleaned.length <= 3) return cleaned;
  return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
}

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(normalizeInviteCode(code));
}
