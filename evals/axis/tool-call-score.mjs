// Scoring for the tool-call evals (tool-calls.mjs, tool-call-cases.mjs). Pure: given a case and the tool calls the
// model made, a run scores 1 (an expected call was made, and no forbidden one) or 0, with a note saying what it did.
// What counts as a drop between two runs is the quality suite's rule (quality-score.mjs compareQuality).

/** @typedef {{ name: string, input: Record<string, unknown> }} Call */
/** @typedef {{ tool: string, input?: Record<string, unknown> }} Expected */

/** The value at a dotted path ("input.title"), or undefined. */
export function at(obj, path) {
  let v = obj;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = /** @type {Record<string, unknown>} */ (v)[k];
  }
  return v;
}

/** Whether one value meets a case's matcher: a RegExp, a function, undefined (absent) or a value (deep equal). */
export function meets(want, got) {
  if (want instanceof RegExp) return got !== undefined && got !== null && want.test(String(got));
  if (typeof want === "function") return want(got) === true;
  if (want === undefined) return got === undefined;
  return JSON.stringify(got) === JSON.stringify(want);
}

/** @param {Expected} want @param {Call} call */
export function callMatches(want, call) {
  if (call.name !== want.tool) return false;
  return Object.entries(want.input ?? {}).every(([path, m]) => meets(m, at(call.input ?? {}, path)));
}

/** A short line for a call: `perform_action deadlines.update {"deadline_id":"..."}`. */
export function describe(call) {
  const i = call.input ?? {};
  const op = typeof i.action === "string" ? i.action : typeof i.what === "string" ? i.what : "";
  const rest = op ? (i.input ?? {}) : i;
  return `${call.name}${op ? ` ${op}` : ""} ${JSON.stringify(rest)}`.slice(0, 160);
}

/**
 * @param {{ expect: Expected | Expected[], never?: Expected[] }} c
 * @param {Call[]} calls every tool call the model made in the run, in order
 * @returns {{ score: 0 | 1, note: string }}
 */
export function scoreToolCalls(c, calls) {
  if (!calls.length) return { score: 0, note: "no tool call" };
  for (const bad of c.never ?? []) {
    const hit = calls.find((call) => callMatches(bad, call));
    if (hit) return { score: 0, note: `forbidden call: ${describe(hit)}` };
  }
  const wants = Array.isArray(c.expect) ? c.expect : [c.expect];
  const hit = calls.find((call) => wants.some((w) => callMatches(w, call)));
  if (hit) return { score: 1, note: describe(hit) };
  return { score: 0, note: `got ${calls.map(describe).join(" | ")}`.slice(0, 240) };
}

/** Whether a run can stop asking the model: it already passed, or it made a call that isn't a gathering read. */
export const GATHER = new Set(["lookup", "find_student", "get_student_record"]);
export function settled(c, calls) {
  return scoreToolCalls(c, calls).score === 1 || calls.some((x) => !GATHER.has(x.name));
}
