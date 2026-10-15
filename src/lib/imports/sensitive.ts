/**
 * Sensitive values (spec §7.4). Imports only ever write fields in
 * import_fields; these rules are the extra protection for values that slip
 * into allowed columns (free text, a mislabelled column).
 *
 * - A column whose header names a never-stored category is forced to ignore.
 * - `###-##-####` is always blocked: never staged, never sent to a model.
 * - A bare 9-digit value under an SSN-like header is blocked.
 * - A bare 9-digit value anywhere else (often a district student ID) is
 *   flagged for the counselor, never blocked or silently redacted.
 */

export type SensitiveCategory =
  | "government-id"
  | "financial"
  | "health"
  | "discipline"
  | "economic-status"
  | "beliefs-identity"
  | "login-secret";

const HEADER_RULES: ReadonlyArray<[SensitiveCategory, RegExp]> = [
  ["government-id", /\b(ssn|social\s*security|soc\.?\s*sec|passport|driver'?s?\s*licen[cs]e|drivers?\s*lic|licen[cs]e\s*(no|number|#)|state\s*id|a[\s-]?number|alien|immigration|itin|tax\s*id|national\s*id)\b/i],
  ["financial", /\b(income|salary|wages?|agi|tax(es)?|bank|account\s*(no|number|#)|routing|iban|swift|credit\s*card|card\s*(no|number|#)|debit|efc|sai|net\s*worth|assets)\b/i],
  ["health", /\b(iep|504|diagnos\w*|medica\w*|medicine|accommodat\w*|disabilit\w*|disabled|health|allerg\w*|mental|therap\w*|counsel+ing\s*notes|illness|adhd|autism)\b/i],
  ["discipline", /\b(disciplin\w*|suspen\w*|expel\w*|expulsion|criminal|arrest\w*|police|detention|infraction|misconduct|incident)\b/i],
  ["economic-status", /\b(free\s*(and|&|\/)?\s*reduced|reduced\s*lunch|lunch\s*status|frl|frpl|fee\s*waiver|low[\s-]*income|pell|title\s*i)\b/i],
  ["beliefs-identity", /\b(religio\w*|faith|church|ethnic\w*|race|racial|sexual\s*orientation|orientation|lgbt\w*|gender\s*identity|political|immigration\s*status|undocumented)\b/i],
  ["login-secret", /\b(password|passcode|pin\s*(code|number)?|security\s*(question|answer)|secret)\b/i],
];

/** Headers that suggest an SSN, for the bare 9-digit rule. */
const SSN_HEADER = /\b(ssn|social\s*security|soc\.?\s*sec|tax\s*id|itin)\b/i;

/** The category a header names, or null. */
export function sensitiveHeader(header: string): SensitiveCategory | null {
  const h = header.replace(/[_.]+/g, " ");
  for (const [category, re] of HEADER_RULES) if (re.test(h)) return category;
  return null;
}

export const forceIgnore = (header: string): boolean => sensitiveHeader(header) !== null;

const SSN_SHAPE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const NINE_DIGITS = /^\d{9}$/;

/** Never staged and never sent to a model. */
export function blockValue(value: string, header: string): boolean {
  if (SSN_SHAPE.test(value)) return true;
  const bare = value.trim();
  return NINE_DIGITS.test(bare) && SSN_HEADER.test(header.replace(/[_.]+/g, " "));
}

/** Kept, but shown to the counselor as a possible ID number. */
export function flagValue(value: string, header: string): boolean {
  return NINE_DIGITS.test(value.trim()) && !blockValue(value, header);
}
