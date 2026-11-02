/**
 * What a Contact Pipeline card must hold. A phone is 10-15 digits (spaces,
 * dashes, dots, parentheses and a leading + allowed); a family can only become
 * an Active student with a student email to invite, a phone and an address.
 */

export function isValidPhone(value: string): boolean {
  const v = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

export type ActiveStudentFields = {
  studentEmail?: string | null;
  studentPhone?: string | null;
  parentPhone?: string | null;
  address?: string | null;
};

/** The missing pieces, in words, for a card about to become an Active student; empty when ready. */
export function missingForActiveStudent(c: ActiveStudentFields): string[] {
  const missing: string[] = [];
  if (!c.studentEmail?.trim()) missing.push("a student email");
  if (!isValidPhone(c.studentPhone ?? "") && !isValidPhone(c.parentPhone ?? "")) missing.push("a valid phone number");
  if (!c.address?.trim()) missing.push("an address");
  return missing;
}

export function activeStudentMessage(name: string, missing: string[]): string {
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0];
  return `${name || "This contact"} needs ${list} before becoming an active student`;
}
