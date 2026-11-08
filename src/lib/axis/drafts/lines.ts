/**
 * What the counselor and the model are told about an activity draft, written by code (spec 4.3, 4.7).
 *
 * Status lines follow AxIS's answer on every turn an activity op ran. They come from the draft's rows and the
 * turn's notes, never from the model's text, so "saved", "waiting for Confirm" and "couldn't save" are always true.
 * The draft block goes in the user turn (not the cached system prompt) and tells the model what the draft holds,
 * how to add to it, and not to narrate outcomes itself.
 */
import { wrapUntrusted } from "../../context/pack.js";
import type { ActivityField } from "./normalize.js";
import { rowLabel, type Draft, type DraftRow } from "./state.js";

/** The fixed sentences (spec 4.1, 4.4, 4.7). */
export const LINES = {
  reminder: (name: string) => `You still have an activity draft for ${name}. Continue or cancel?`,
  expired: "Your activity draft expired. Want to start again?",
  switchQuestion: (a: string, b: string) => `Your activity draft for ${a} isn't finished. Drop it and start one for ${b}?`,
  cancelled: (name: string) => `Okay, I dropped the activity draft for ${name}.`,
  saveFailed: "I couldn't keep this draft; send the details again.",
  overLimit: "Over the Common App's 150-character limit.",
  continueAsk: 'Send what\'s missing, or say "add it" to file it with blanks.',
  nothingOpen: "There's nothing left in the activity draft.",
} as const;

/** The fields a row should have before its card is filed (asked for once), in the order they're asked. */
export const FILING_FIELDS: readonly ActivityField[] = ["position", "grade_levels", "timing", "hours_per_week", "weeks_per_year"];

/** Short words for "Still need …". */
const NEED_WORDS: Partial<Record<ActivityField, string>> = {
  organization: "organization", position: "position", grade_levels: "grades", timing: "timing", hours_per_week: "hours", weeks_per_year: "weeks",
};
/** Field names as a counselor reads them. */
export const FIELD_WORDS: Record<ActivityField, string> = {
  organization: "organization", position: "position", category: "category", grade_levels: "grades", timing: "timing",
  hours_per_week: "hours per week", weeks_per_year: "weeks per year", continuing: "continuing", uc_category: "UC category", description: "description",
};

const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The filing fields a row still lacks, organization first. */
export function missingOf(r: DraftRow): ActivityField[] {
  if (r.op !== "add") return [];
  return [...(blank(r.fields.organization) ? (["organization"] as ActivityField[]) : []), ...FILING_FIELDS.filter((f) => blank(r.fields[f]))];
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const sentence = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** The status lines for this turn, in a fixed order. `name` covers a draft that closed during the turn. */
export function statusLines(d: Draft, o: { name?: string; saveFailed?: boolean } = {}): string[] {
  const name = o.name ?? d.header?.student_name ?? "the student";
  const out: string[] = [];
  const labelOf = (key: string | undefined, fallback?: string) => {
    const row = key ? d.rows.find((r) => r.key === key) : undefined;
    return row ? rowLabel(row) : (fallback ?? "the new activity");
  };
  for (const n of d.notes) if (n.kind === "saved") out.push(`Saved: ${labelOf(n.key, n.label)} on ${name}'s Activities sheet.`);
  for (const n of d.notes) if (n.kind === "failed") out.push(`Couldn't save ${labelOf(n.key, n.label)}: ${sentence(n.counselor ?? n.reason ?? "it wasn't saved")}.`);
  for (const n of d.notes) {
    if (n.kind !== "rejected") continue;
    const what = n.field && n.field in FIELD_WORDS ? `${FIELD_WORDS[n.field as ActivityField]}: ` : "";
    out.push(`Couldn't save ${labelOf(n.key, n.label)} yet: ${what}${sentence(n.counselor ?? n.reason ?? "")}.`);
  }
  // One line per waiting card.
  const cards = new Map<string, DraftRow[]>();
  for (const r of d.rows) if (r.status === "card" && r.card_id) cards.set(r.card_id, [...(cards.get(r.card_id) ?? []), r]);
  for (const rows of cards.values()) {
    out.push(
      rows[0]!.op === "update"
        ? `Waiting for your Confirm: change ${rowLabel(rows[0]!)} on ${name}'s Activities sheet.`
        : `Waiting for your Confirm: add ${list(rows.map(rowLabel))} to ${name}'s Activities sheet.`
    );
  }
  for (const r of d.rows) {
    if (r.status !== "collecting") continue;
    const missing = missingOf(r);
    if (missing.length) out.push(`Still need for ${rowLabel(r)} row: ${missing.map((f) => NEED_WORDS[f] ?? f).join(", ")}.`);
  }
  if (d.header?.switch_to && d.notes.some((n) => n.kind === "refused-student")) out.push(LINES.switchQuestion(d.header.student_name, d.header.switch_to.name));
  if (o.saveFailed) out.push(LINES.saveFailed);
  return [...new Set(out)];
}

/** The code-written reply to "continue": where the draft stands and what it needs. */
export function continueReply(d: Draft, o: { name?: string } = {}): string {
  const lines = statusLines(d, o);
  const needs = d.rows.some((r) => r.status === "collecting" && missingOf(r).length > 0);
  if (!lines.length) return LINES.nothingOpen;
  return [...lines, ...(needs ? [LINES.continueAsk] : [])].join("\n");
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? `"${v}"` : String(v));

/** The draft as the model sees it in the user turn. Descriptions by length and source only, never their text. */
export function draftBlock(d: Draft): string {
  if (!d.header) return "";
  const rows = d.rows
    .filter((r) => r.status === "collecting" || r.status === "card" || r.status === "saved")
    .map((r) => {
      const parts: string[] = [];
      for (const [f, v] of Object.entries(r.fields) as [ActivityField, unknown][]) {
        if (v === undefined) continue;
        const src = r.sources[f]?.label ?? "your message";
        if (f === "description") {
          parts.push(`description: ${typeof v === "string" ? v.length : 0} characters, from ${src}`);
          continue;
        }
        const read = r.read_as[f] ? `; read from "${r.read_as[f]}"` : "";
        parts.push(`${FIELD_WORDS[f]} ${show(v)} (${src}${read})`);
      }
      const missing = missingOf(r);
      const status = r.status === "card" ? "waiting on its card" : r.status === "saved" ? `saved as activity_id ${r.activity_id ?? "?"}` : "collecting";
      const what = r.op === "update" ? `update of activity_id ${r.activity_id}` : "add";
      return `- ${r.key} (${what}, ${status}): ${parts.join("; ") || "nothing yet"}${missing.length && r.status === "collecting" ? `; missing: ${missing.map((f) => FIELD_WORDS[f]).join(", ")}` : ""}`;
    });
  const lines = [
    `Activity draft for ${d.header.student_name}. What it holds so far (values and where each came from):`,
    wrapUntrusted("draft", rows.join("\n") || "(no rows yet)", false),
    "How to fill it: call perform_action application.add_activity with draft_row (application.update_activity with activity_id for a saved row) whenever the counselor gives or corrects a value, even partial. Use the counselor's own words; never fill a field they didn't give.",
    "Don't say whether anything was saved, tried or needs Confirm, and don't describe earlier attempts: status lines written by the server follow your answer.",
  ];
  if (d.switchAccepted) {
    lines.push(`The counselor agreed to drop the earlier draft and start one for ${d.header.student_name} from their message before this one: add that activity now with application.add_activity.`);
  }
  return lines.join("\n");
}

/** Outcome codes for the turn's log line: field names, never values. */
export function outcomeCodes(d: Draft): string[] {
  const code = (n: Draft["notes"][number]) =>
    n.kind === "rejected" ? `rejected:${n.field ?? "row"}` : n.kind === "refused-student" ? "refused:other-student" : n.kind === "refused-unrelated" ? "refused:unrelated" : n.kind;
  return [...new Set(d.notes.map(code))];
}
