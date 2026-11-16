/**
 * Two bounds on what a request body can cost before a handler sees it.
 *
 * zod 3 does not stop at an array's `.max(n)`: it validates every element and
 * records an issue for each bad one, so a 700 KB array of junk against
 * `z.array(uuid).max(25)` took about a second of the one thread, 190 MB, and
 * came back as a 12 MB list of issues. `bodyTooComplex` refuses such a body
 * before any schema runs, and `cappedValidationDetails` bounds what a
 * validation error may say. Pure, so both are unit tested.
 */

/** No route accepts an array this long: the largest bound in a schema is 2,000 (a pipeline column's cards). */
export const MAX_ARRAY_LENGTH = 5_000;
/** Array elements plus object keys in one body. A full 300 KB profile or a 500-row roster is far under it. */
export const MAX_BODY_NODES = 50_000;

export const MAX_VALIDATION_ISSUES = 20;
const MAX_ISSUE_CHARS = 300;
const MAX_FIELD_CHARS = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Why a parsed body is refused, or null. Walks arrays and plain objects only
 * (a Buffer or a string body is left alone), with a stack rather than
 * recursion, and stops at the first bound it passes, so the walk itself never
 * costs more than MAX_BODY_NODES steps.
 */
export function bodyTooComplex(body: unknown): "array" | "nodes" | null {
  if (!Array.isArray(body) && !isPlainObject(body)) return null;
  const stack: unknown[] = [body];
  let nodes = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY_LENGTH) return "array";
      nodes += v.length;
      if (nodes > MAX_BODY_NODES) return "nodes";
      for (let i = 0; i < v.length; i++) {
        const child: unknown = v[i];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    } else if (isPlainObject(v)) {
      for (const key in v) {
        nodes += 1;
        if (nodes > MAX_BODY_NODES) return "nodes";
        const child = v[key];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
  }
  return null;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export type ValidationDetails = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
  /** How many issues were left out, when any were. */
  omitted?: number;
};

/**
 * A validation error in the shape `ZodError.flatten()` gives (`formErrors`,
 * `fieldErrors` by top-level field), which clients read, built from the first
 * MAX_VALIDATION_ISSUES issues with each message cut to a bounded length.
 */
export function cappedValidationDetails(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>
): ValidationDetails {
  const formErrors: string[] = [];
  // No prototype: a body key named "__proto__" is an ordinary field name here.
  const fieldErrors = Object.create(null) as Record<string, string[]>;
  const shown = Math.min(issues.length, MAX_VALIDATION_ISSUES);
  for (let i = 0; i < shown; i++) {
    const issue = issues[i]!;
    const message = clip(String(issue.message), MAX_ISSUE_CHARS);
    if (issue.path.length > 0) {
      const field = clip(String(issue.path[0]), MAX_FIELD_CHARS);
      const list = fieldErrors[field];
      if (list) list.push(message);
      else fieldErrors[field] = [message];
    } else {
      formErrors.push(message);
    }
  }
  const omitted = issues.length - shown;
  return omitted > 0 ? { formErrors, fieldErrors, omitted } : { formErrors, fieldErrors };
}
