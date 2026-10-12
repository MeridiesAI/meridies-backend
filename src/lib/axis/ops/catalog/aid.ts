/**
 * Financial aid (routes/aid.ts, routes/studentAid.ts) and the Program &
 * Opportunity Concierge (routes/opportunities.ts). The aid page's forms,
 * family financials, checklist marks, award letters and appeals are the
 * counselor's record, so writing them runs at once, figures included (the
 * counselor supplies them). The FAFSA carries its status and due date and
 * nothing else, as the route's own schema does. Whatever can change what the
 * student sees asks first, because what they see depends on a row's current
 * status, which an input can't know: recommending a scholarship or taking it
 * back, moving one on their list, and any change to a program recommendation
 * (sending one also notifies the student). Deletes ask.
 *
 * Aid figures are not on the AI allowlist: replies and card lines name
 * letters, schools, scholarships and programs, never a dollar amount, a family
 * circumstance (an appeal's basis included) or a note, and a dollar amount
 * typed into a label is masked. Card details (the counselor's eyes only) do
 * show the figures being set. An appeal's letter text is left to
 * /ai/award-appeal and the counselor.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = Pick<OpHelpers, "get">;
type Row = Record<string, unknown>;

/** The aid routes validate dates with z.string().date() (a real calendar date). */
const date = z.string().date();
const money = z.number().int().min(0).max(100_000_000);

// ---- Shared pieces ------------------------------------------------------------

/** "$1,234" for a card; never in a reply. */
function dollars(cents: unknown): string {
  if (cents === null || cents === undefined) return "cleared";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "cleared";
  return `${n < 0 ? "-" : ""}$${Math.abs(n / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Card lines for money keys present in the input. */
function moneyLines(i: Row, labels: Record<string, string>): string[] {
  return Object.entries(labels)
    .filter(([k]) => k in i)
    .map(([k, label]) => `${label}: ${dollars(i[k])}`);
}

/** The keys of `i` among `keys`, defined ones only: a body that carries just what the model set. */
const pick = (i: Row, keys: readonly string[]): Row => defined(Object.fromEntries(keys.map((k) => [k, i[k]])));

/**
 * The previous value of every input key the write touched, read from a
 * snapshot row (`map`: input key -> snapshot key), with `fallback` for a
 * column the route won't take back as null.
 */
function previous(i: Row, before: Row, map: Record<string, string>, fallback: Row = {}): Row {
  const prev: Row = {};
  for (const [k, from] of Object.entries(map)) {
    if (!(k in i)) continue;
    const v = before[from];
    prev[k] = v === undefined || v === null ? (k in fallback ? fallback[k] : null) : v;
  }
  return prev;
}

/** bigint columns may come back as strings; the ops take numbers. */
function numeric(prev: Row, keys: readonly string[]): Row {
  for (const k of keys) if (typeof prev[k] === "string" && prev[k] !== "" && Number.isFinite(Number(prev[k]))) prev[k] = Number(prev[k]);
  return prev;
}

/** The aid collections have no single-row GET; each list is one call, scoped to the student. */
async function findIn(h: Get, url: string, id: string): Promise<Row | null> {
  const hit = asArray(await h.get<unknown[]>(url)).find((r) => r.id === id);
  return hit ?? null;
}

/** A label a person typed, with any dollar amount in it masked, for a reply the model reads. */
const noFigures = (v: unknown): unknown =>
  typeof v === "string"
    ? v.replace(/\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|usd)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gi, "$…")
    : v;

// ---- Aid profile: forms and family financials --------------------------------

const FAFSA_STATUS = ["not-started", "in-progress", "submitted"] as const;
const CSS_STATUS = ["not-started", "in-progress", "submitted", "not-required", "not-applicable"] as const;

/** The forms: FAFSA status and due date only (v8), the CSS Profile beside it, and which aid the family is pursuing. */
const formFields = {
  fafsa_status: z.enum(FAFSA_STATUS),
  fafsa_due_date: date.nullable(),
  css_status: z.enum(CSS_STATUS),
  css_due_date: date.nullable(),
  css_submitted_at: date.nullable(),
  aid_types_pursued: z.array(z.string().trim().max(60)).max(20),
};
const FORM_KEYS = Object.keys(formFields);
const FORM_LABELS = {
  fafsa_status: "FAFSA status",
  fafsa_due_date: "FAFSA due",
  css_status: "CSS Profile status",
  css_due_date: "CSS Profile due",
  css_submitted_at: "CSS Profile submitted on",
  aid_types_pursued: "Aid types pursued",
};

/** The family's figures and household (route columns of the same names). */
const familyFields = {
  parent_agi_cents: z.number().int().min(0).max(100_000_000_000).nullable(),
  sai_estimate: z.number().int().min(-1_500).max(1_000_000).nullable(),
  household_size: z.number().int().min(1).max(20).nullable(),
  number_in_college: z.number().int().min(0).max(20).nullable(),
  dependency_status: z.enum(["dependent", "independent"]).nullable(),
  state_of_residence: z.string().trim().max(60).nullable(),
  income_band: z.string().trim().max(60).nullable(),
  assets_band: z.string().trim().max(60).nullable(),
};
const FAMILY_KEYS = Object.keys(familyFields);
const FAMILY_LABELS = {
  household_size: "Household size",
  number_in_college: "Number in college",
  dependency_status: "Dependency",
  state_of_residence: "State of residence",
  income_band: "Income band",
  assets_band: "Assets band",
};

/** The family's situation: the CSS-Profile-style questions and the special circumstances. */
const situationFields = {
  home_equity: z.enum(["renting", "under-100k", "100k-300k", "over-300k", "declined"]).nullable(),
  family_business: z.enum(["none", "under-100", "100-plus", "farm", "declined"]).nullable(),
  parent_status: z.enum(["married", "divorced-separated", "single", "remarried", "declined"]).nullable(),
  siblings_in_college: z.enum(["none", "one", "two-plus", "declined"]).nullable(),
  special_circumstances: z.string().trim().max(4000).nullable(),
};
const SITUATION_KEYS = Object.keys(situationFields);
const SITUATION_LABELS = {
  home_equity: "Home equity",
  family_business: "Family business",
  parent_status: "Parents",
  siblings_in_college: "Siblings in college",
  special_circumstances: "Special circumstances",
};

/** Columns the route won't take back as null. */
const PROFILE_FALLBACK: Row = { fafsa_status: "not-started", css_status: "not-started", aid_types_pursued: [] };

const profileUrl = (studentId: string) => `/aid/profile${qs({ studentId })}`;

function profileUndo(name: string, keys: readonly string[]) {
  return (i: Row, _body: unknown, before: unknown) => {
    const b = asRecord(before);
    // The GET answers a default row ({ student_id, statuses }) when none exists yet, so null columns are the true "before".
    if (!b.student_id) return null;
    const map = Object.fromEntries(keys.map((k) => [k, k]));
    return { op: name, input: { student_id: i.student_id, ...numeric(previous(i, b, map, PROFILE_FALLBACK), ["parent_agi_cents", "sai_estimate"]) } };
  };
}

// ---- The per-school checklist on the Financial aid page ------------------------

const CELL_KEYS = ["css", "verification", "award"] as const;
type CellKey = (typeof CELL_KEYS)[number];
const CELL_LABEL: Record<CellKey, string> = {
  css: "CSS Profile submitted",
  verification: "Verification docs",
  award: "Award letter received",
};
/** lib/studentAid.ts ITEM_FOR: the stored mark's checklist item, and the status a tick writes. */
const CELL_ITEM: Record<CellKey, string> = { css: "css-profile", verification: "verification", award: "award-letter" };
const CELL_DONE: Record<CellKey, string> = { css: "submitted", verification: "submitted", award: "received" };

type Cell = { key?: string; done?: boolean; applicable?: boolean; note?: string | null; overridden?: boolean };
type School = { studentCollegeId?: string; name?: string; checklist?: Cell[] };

async function findSchool(h: Get, studentId: string, studentCollegeId: string): Promise<School | null> {
  const o = asRecord(await h.get(`/student-aid/${seg(studentId)}/overview`));
  const hit = asArray(o.schools).find((s) => s.studentCollegeId === studentCollegeId);
  return hit ? (hit as School) : null;
}

function overviewReply(body: unknown): string {
  const o = asRecord(body);
  const form = (label: string, x: Row) =>
    `${label}: ${str(x.status) ?? "not-started"}${
      x.dueDate ? `, due ${str(x.dueDate)}${x.dueDateSource === "derived" ? " (from the earliest priority aid deadline; not set by hand)" : ""}` : ", no due date"
    }`;
  const lines = [form("FAFSA", asRecord(o.fafsa)), form("CSS Profile", asRecord(o.css))];
  const schools = asArray(o.schools);
  if (!schools.length) {
    lines.push("No schools on the college list, so no aid checklist.");
    return lines.join("\n");
  }
  lines.push("Schools (id = student_college_id). Checklist cells css / verification / award: done, open, or n/a; * = marked by hand.");
  lines.push(
    listReply(
      schools,
      (s) => {
        const cells = asArray(s.checklist).map(
          (c) => `${str(c.key)} ${c.applicable === false ? "n/a" : c.done ? "done" : "open"}${c.overridden ? "*" : ""}`
        );
        const css = s.cssRequired === true ? ", asks for the CSS Profile" : s.cssRequired === false ? ", no CSS Profile" : "";
        const priority = s.priorityDeadline ? ` · aid priority deadline ${str(s.priorityDeadline)}` : "";
        return `id ${str(s.studentCollegeId)}: ${untrusted(s.name)}${css}${priority} · ${cells.join(", ")}`;
      },
      ""
    )
  );
  return lines.join("\n");
}

// ---- Award letters, their line items, appeals --------------------------------

const letterFields = {
  school_name: z.string().trim().min(1).max(300),
  student_college_id: uuid.nullable(),
  college_id: uuid.nullable(),
  document_id: uuid.nullable(),
  academic_year: z.string().trim().max(20),
  cost_of_attendance_cents: money.nullable(),
  grants_cents: money,
  scholarships_cents: money,
  work_study_cents: money,
  loans_subsidized_cents: money,
  loans_unsubsidized_cents: money,
  parent_loan_cents: money,
  renewal_requirements: z.string().trim().max(4000),
  appeal_deadline: date.nullable(),
  received_at: date.nullable(),
  notes: z.string().trim().max(4000),
};
const LETTER_KEYS = Object.keys(letterFields);
const LETTER_MONEY = {
  cost_of_attendance_cents: "Cost of attendance",
  grants_cents: "Grants",
  scholarships_cents: "Scholarships",
  work_study_cents: "Work-study",
  loans_subsidized_cents: "Subsidized loans",
  loans_unsubsidized_cents: "Unsubsidized loans",
  parent_loan_cents: "Parent loan",
};
const LETTER_LABELS = {
  school_name: "School",
  academic_year: "Academic year",
  received_at: "Received",
  appeal_deadline: "Appeal deadline",
  renewal_requirements: "Renewal requirements",
  notes: "Notes",
  student_college_id: "College-list school",
  document_id: "Document",
};
const LETTER_FALLBACK: Row = {
  grants_cents: 0,
  scholarships_cents: 0,
  work_study_cents: 0,
  loans_subsidized_cents: 0,
  loans_unsubsidized_cents: 0,
  parent_loan_cents: 0,
  academic_year: "",
  renewal_requirements: "",
  notes: "",
};

const ITEM_CATEGORIES = ["grant", "scholarship", "work-study", "loan", "parent-loan", "other"] as const;
const ITEM_BASIS = ["need", "merit", "both", "unknown"] as const;
const itemFields = {
  award_letter_id: uuid,
  label: z.string().trim().min(1).max(200),
  category: z.enum(ITEM_CATEGORIES),
  basis: z.enum(ITEM_BASIS),
  amount_cents: z.number().int().min(-100_000_000).max(100_000_000),
  renewable: z.boolean().nullable(),
  renewal_note: z.string().trim().max(1000),
  sort_order: z.number().int().min(0).max(999),
};
const ITEM_KEYS = Object.keys(itemFields);
const ITEM_LABELS = { label: "Label", category: "Category", basis: "Basis", renewable: "Renewable", renewal_note: "Renewal note", sort_order: "Position" };

const APPEAL_STATUS = ["draft", "counselor-review", "approved", "sent", "declined"] as const;
const appealFields = {
  school_name: z.string().trim().min(1).max(300),
  student_college_id: uuid.nullable(),
  award_letter_id: uuid.nullable(),
  basis: z.array(z.string().trim().max(80)).max(10),
  circumstances: z.string().trim().max(8000),
  status: z.enum(APPEAL_STATUS),
};
const APPEAL_KEYS = Object.keys(appealFields);
const APPEAL_LABELS = { school_name: "School", status: "Status", basis: "Basis", circumstances: "Circumstances", award_letter_id: "Award letter", student_college_id: "College-list school" };

const lettersUrl = (studentId: string) => `/aid/award-letters${qs({ studentId })}`;
const itemsUrl = (studentId: string) => `/aid/award-letter-items${qs({ studentId })}`;
const appealsUrl = (studentId: string) => `/aid/appeals${qs({ studentId })}`;

/** `the "Tufts" (2026-27) award letter`, or what the card says when the id isn't one of this student's letters. */
const letterLabel = (l: Row | null, studentName: string) =>
  l
    ? `the "${plainText(l.school_name, 80)}"${l.academic_year ? ` (${plainText(l.academic_year, 20)})` : ""} award letter`
    : `an award letter not on ${studentName}'s Financial aid`;
/** A line item's label for a card line (echoed to the model), any dollar amount in it masked. */
const itemLabel = (it: Row | null, studentName: string) =>
  it ? `"${plainText(noFigures(it.label), 80)}"` : `a line item not on ${studentName}'s award letters`;
const appealLabel = (a: Row | null, studentName: string) =>
  a ? `the award appeal to "${plainText(a.school_name, 80)}"` : `an award appeal not on ${studentName}'s Financial aid`;

export const aid: OpGroup = {
  heading: "Financial aid",
  ops: [
    op({
      name: "aid.overview",
      kind: "read",
      title: "A student's Financial aid page: FAFSA and CSS status and due dates, each school's checklist (student_college_id).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/student-aid/${seg(i.student_id)}/overview` }),
      reply: (body) => overviewReply(body),
    }),
    op({
      name: "aid.award_letters",
      kind: "read",
      title: "A student's award letters with ids, and each letter's line items with ids (names only, no amounts).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/aid/comparison${qs({ studentId: i.student_id })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (l) => {
            const head = `id ${str(l.id)}: ${untrusted(l.school_name)}${l.academic_year ? ` ${untrusted(l.academic_year)}` : ""} · ${
              l.received_at ? `received ${str(l.received_at)}` : "not received yet"
            }${l.appeal_deadline ? ` · appeal by ${str(l.appeal_deadline)}` : ""}${l.student_college_id ? ` · student_college_id ${str(l.student_college_id)}` : ""}`;
            const items = asArray(l.items).map(
              (it) =>
                `  item id ${str(it.id)}: ${untrusted(noFigures(it.label))} [${str(it.category)}${it.basis ? `, ${str(it.basis)}` : ""}${
                  it.renewable === true ? ", renewable" : it.renewable === false ? ", one-time" : ""
                }]`
            );
            return [head, ...items].join("\n");
          },
          "No award letters on file."
        ),
    }),
    op({
      name: "aid.appeals",
      kind: "read",
      title: "A student's award appeals with ids, school and status.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: appealsUrl(i.student_id) }),
      // The basis and circumstances are the family's situation: not for the model.
      reply: (body) =>
        listReply(
          asArray(body),
          (a) => `id ${str(a.id)}: ${untrusted(a.school_name)} [${str(a.status)}]${a.award_letter_id ? ` · award letter ${str(a.award_letter_id)}` : ""}`,
          "No award appeals on file."
        ),
    }),
    op({
      name: "aid.update_forms",
      kind: "write",
      risk: "auto",
      title: "Set the FAFSA's status and due date (nothing else from it), the CSS Profile's status and dates, or the aid types pursued.",
      doc: "{ student_id, fafsa_status?: not-started|in-progress|submitted, fafsa_due_date? YYYY-MM-DD|null, css_status?: not-started|in-progress|submitted|not-required|not-applicable, css_due_date?|null, css_submitted_at?|null, aid_types_pursued? [≤60, max 20] }",
      input: z.object(formFields).partial().extend({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: "/aid/profile", body: { studentId: i.student_id, ...pick(i, FORM_KEYS) } }),
      describe: (i, h) => {
        const parts = [
          Object.keys(i).some((k) => k.startsWith("fafsa_")) ? "FAFSA" : null,
          Object.keys(i).some((k) => k.startsWith("css_")) ? "CSS Profile" : null,
          "aid_types_pursued" in i ? "aid types pursued" : null,
        ].filter(Boolean);
        const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "aid forms";
        return `Update ${h.studentName(i.student_id)}'s ${what} on the Financial aid page`;
      },
      details: (i) => changeLines(i, FORM_LABELS),
      snapshot: (i, h) => h.get(profileUrl(i.student_id)),
      undo: profileUndo("aid.update_forms", FORM_KEYS),
    }),
    op({
      name: "aid.update_family",
      kind: "write",
      risk: "auto",
      title: "Set a family's aid figures: parent AGI (cents), SAI estimate, household, number in college, dependency, state, income and asset bands.",
      doc: "{ student_id, parent_agi_cents? int|null, sai_estimate? -1500..1000000|null, household_size? 1-20|null, number_in_college? 0-20|null, dependency_status?: dependent|independent|null, state_of_residence? ≤60|null, income_band? ≤60|null, assets_band? ≤60|null }",
      input: z.object(familyFields).partial().extend({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: "/aid/profile", body: { studentId: i.student_id, ...pick(i, FAMILY_KEYS) } }),
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s family figures on the Financial aid page`,
      details: (i) => [...moneyLines(i, { parent_agi_cents: "Parent AGI" }), ...changeLines(i, { sai_estimate: "SAI estimate", ...FAMILY_LABELS })],
      snapshot: (i, h) => h.get(profileUrl(i.student_id)),
      undo: profileUndo("aid.update_family", FAMILY_KEYS),
    }),
    op({
      name: "aid.update_family_situation",
      kind: "write",
      risk: "auto",
      title: "Set a family's situation for aid: home equity, family business, parents' status, siblings in college, special circumstances.",
      doc: "{ student_id, home_equity?: renting|under-100k|100k-300k|over-300k|declined|null, family_business?: none|under-100|100-plus|farm|declined|null, parent_status?: married|divorced-separated|single|remarried|declined|null, siblings_in_college?: none|one|two-plus|declined|null, special_circumstances? ≤4000|null }",
      input: z.object(situationFields).partial().extend({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: "/aid/profile", body: { studentId: i.student_id, ...pick(i, SITUATION_KEYS) } }),
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s family situation on the Financial aid page`,
      details: (i) => [
        ...changeLines(Object.fromEntries(Object.entries(i).filter(([k]) => k !== "special_circumstances")), SITUATION_LABELS),
        ...("special_circumstances" in i ? [`Special circumstances: ${i.special_circumstances ? plainText(i.special_circumstances, 1500) : "cleared"}`] : []),
      ],
      snapshot: (i, h) => h.get(profileUrl(i.student_id)),
      undo: profileUndo("aid.update_family_situation", SITUATION_KEYS),
    }),
    op({
      name: "aid.set_checklist",
      kind: "write",
      risk: "auto",
      title: "Tick or untick a school's aid checklist cell (css, verification, award); done null returns it to what's on file.",
      doc: "{ student_id, student_college_id (aid.overview), key: css|verification|award, done: bool|null, note? ≤1000|null }",
      input: z
        .object({
          student_id: uuid,
          student_college_id: uuid,
          key: z.enum(CELL_KEYS),
          done: z.boolean().nullable(),
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PUT",
        url: `/student-aid/${seg(i.student_id)}/checklist`,
        body: defined({ studentCollegeId: i.student_college_id, key: i.key, done: i.done, note: i.note }),
      }),
      describe: async (i, h) => {
        const s = await findSchool(h, i.student_id, i.student_college_id);
        const school = s ? `"${plainText(s.name, 80)}"` : "a school";
        const verb = i.done === null ? "Clear the mark on" : i.done ? "Tick" : "Untick";
        return `${verb} "${CELL_LABEL[i.key]}" for ${school} on ${h.studentName(i.student_id)}'s aid checklist`;
      },
      details: (i) => ("note" in i ? [i.note ? `Note: ${plainText(i.note, 1000)}` : "Note: cleared"] : []),
      // The stored mark itself (GET /aid/checklist): its status says exactly what a tick, an untick or no mark puts back.
      snapshot: async (i, h) => {
        const rows = await h.get<unknown[]>(`/aid/checklist${qs({ studentId: i.student_id })}`);
        if (!Array.isArray(rows)) return null;
        const mark = asArray(rows).find((r) => r.student_college_id === i.student_college_id && r.item === CELL_ITEM[i.key]);
        return { mark: mark ? { status: str(mark.status), note: str(mark.note) } : null };
      },
      undo: (i, _body, before) => {
        if (!before) return null;
        const base = { student_id: i.student_id, student_college_id: i.student_college_id, key: i.key };
        const raw = asRecord(before).mark;
        if (raw === null) return { op: "aid.set_checklist", input: { ...base, done: null } };
        const mark = asRecord(raw);
        // A mark set some other way (waived, in progress, not applicable) can't be written back by this op.
        const done = mark.status === CELL_DONE[i.key] ? true : mark.status === "todo" ? false : null;
        if (done === null) return null;
        // Dropping the mark (done: null) took its note with it, so the note goes back too.
        const note = "note" in i || i.done === null ? { note: str(mark.note) } : {};
        return { op: "aid.set_checklist", input: { ...base, done, ...note } };
      },
    }),
    op({
      name: "aid.add_award_letter",
      kind: "write",
      risk: "auto",
      title: "Enter a school's award letter for a student (amounts in integer cents).",
      doc: "{ student_id, school_name ≤300, student_college_id?, academic_year? ≤20, cost_of_attendance_cents?|null, grants_cents?, scholarships_cents?, work_study_cents?, loans_subsidized_cents?, loans_unsubsidized_cents?, parent_loan_cents?, received_at? YYYY-MM-DD, appeal_deadline? YYYY-MM-DD, renewal_requirements?, notes? }",
      input: z.object(letterFields).partial().extend({ student_id: uuid, school_name: letterFields.school_name }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/aid/award-letters", body: { studentId: i.student_id, ...pick(i, LETTER_KEYS) } }),
      describe: (i, h) => `Add the "${plainText(i.school_name, 80)}" award letter to ${h.studentName(i.student_id)}'s Financial aid`,
      details: (i) => [...moneyLines(i, LETTER_MONEY), ...changeLines(i, { academic_year: "Academic year", received_at: "Received", appeal_deadline: "Appeal deadline", renewal_requirements: "Renewal requirements", notes: "Notes" })],
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "aid.delete_award_letter", input: { student_id: i.student_id, award_letter_id: id } } : null;
      },
    }),
    op({
      name: "aid.update_award_letter",
      kind: "write",
      risk: "auto",
      title: "Correct an award letter: school, year, amounts (integer cents), dates, renewal terms, notes.",
      doc: "{ student_id, award_letter_id, school_name?, academic_year?, cost_of_attendance_cents?|null, grants_cents?, scholarships_cents?, work_study_cents?, loans_subsidized_cents?, loans_unsubsidized_cents?, parent_loan_cents?, received_at?|null, appeal_deadline?|null, renewal_requirements?, notes?, student_college_id?|null }",
      input: z.object(letterFields).partial().extend({ student_id: uuid, award_letter_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/aid/award-letters/${seg(i.award_letter_id)}${qs({ studentId: i.student_id })}`, body: pick(i, LETTER_KEYS) }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Update ${letterLabel(await findIn(h, lettersUrl(i.student_id), i.award_letter_id), name)} for ${name}`;
      },
      details: (i) => [...changeLines(i, LETTER_LABELS), ...moneyLines(i, LETTER_MONEY)],
      snapshot: (i, h) => findIn(h, lettersUrl(i.student_id), i.award_letter_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev = numeric(previous(i, b, Object.fromEntries(LETTER_KEYS.map((k) => [k, k])), LETTER_FALLBACK), Object.keys(LETTER_MONEY));
        if ("school_name" in prev && !prev.school_name) return null;
        return { op: "aid.update_award_letter", input: { student_id: i.student_id, award_letter_id: i.award_letter_id, ...prev } };
      },
    }),
    op({
      name: "aid.delete_award_letter",
      kind: "write",
      risk: "confirm",
      title: "Delete an award letter (and its line items).",
      doc: "{ student_id, award_letter_id }",
      input: z.object({ student_id: uuid, award_letter_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/aid/award-letters/${seg(i.award_letter_id)}${qs({ studentId: i.student_id })}` }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        const l = await findIn(h, lettersUrl(i.student_id), i.award_letter_id);
        return `Delete ${letterLabel(l, name)}${l ? ` from ${name}'s Financial aid` : ""}`;
      },
      warning: "The letter and its line items are deleted from the comparison; an appeal linked to it loses the link.",
    }),
    op({
      name: "aid.add_award_item",
      kind: "write",
      risk: "auto",
      title: "Add a line item (a grant, scholarship, loan…) to an award letter.",
      doc: "{ student_id, award_letter_id (aid.award_letters), label ≤200, category: grant|scholarship|work-study|loan|parent-loan|other, amount_cents int, basis?: need|merit|both|unknown, renewable? bool|null, renewal_note? ≤1000, sort_order? 0-999 }",
      input: z
        .object(itemFields)
        .partial()
        .extend({ student_id: uuid, award_letter_id: itemFields.award_letter_id, label: itemFields.label, category: itemFields.category, amount_cents: itemFields.amount_cents })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/aid/award-letter-items", body: { studentId: i.student_id, ...pick(i, ITEM_KEYS) } }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Add "${plainText(noFigures(i.label), 80)}" (${i.category}) to ${letterLabel(await findIn(h, lettersUrl(i.student_id), i.award_letter_id), name)} for ${name}`;
      },
      details: (i) => [...moneyLines(i, { amount_cents: "Amount" }), ...changeLines(i, { basis: "Basis", renewable: "Renewable", renewal_note: "Renewal note" })],
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "aid.delete_award_item", input: { student_id: i.student_id, item_id: id } } : null;
      },
    }),
    op({
      name: "aid.update_award_item",
      kind: "write",
      risk: "auto",
      title: "Change an award letter's line item: label, category, basis, amount (integer cents), renewal.",
      doc: "{ student_id, item_id (aid.award_letters), label? ≤200, category?, basis?, amount_cents? int, renewable?|null, renewal_note? ≤1000, sort_order? 0-999 }",
      input: z.object(itemFields).omit({ award_letter_id: true }).partial().extend({ student_id: uuid, item_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/aid/award-letter-items/${seg(i.item_id)}${qs({ studentId: i.student_id })}`, body: pick(i, ITEM_KEYS) }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Update ${itemLabel(await findIn(h, itemsUrl(i.student_id), i.item_id), name)} on an award letter for ${name}`;
      },
      details: (i) => [...changeLines(i, ITEM_LABELS), ...moneyLines(i, { amount_cents: "Amount" })],
      snapshot: (i, h) => findIn(h, itemsUrl(i.student_id), i.item_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev = numeric(previous(i, b, Object.fromEntries(ITEM_KEYS.map((k) => [k, k])), { renewal_note: "", sort_order: 0, basis: "unknown", amount_cents: 0 }), ["amount_cents"]);
        if (("label" in prev && !prev.label) || ("category" in prev && !prev.category)) return null;
        return { op: "aid.update_award_item", input: { student_id: i.student_id, item_id: i.item_id, ...prev } };
      },
    }),
    op({
      name: "aid.delete_award_item",
      kind: "write",
      risk: "confirm",
      title: "Delete a line item from an award letter.",
      doc: "{ student_id, item_id }",
      input: z.object({ student_id: uuid, item_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/aid/award-letter-items/${seg(i.item_id)}${qs({ studentId: i.student_id })}` }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Delete ${itemLabel(await findIn(h, itemsUrl(i.student_id), i.item_id), name)} from an award letter for ${name}`;
      },
      warning: "The line item is deleted; the letter's merit, need and renewable totals change with it.",
    }),
    op({
      name: "aid.add_appeal",
      kind: "write",
      risk: "auto",
      title: "Log an award appeal to a school (no letter text; the letter is drafted from the aid page).",
      doc: "{ student_id, school_name ≤300, award_letter_id? (aid.award_letters), student_college_id?, basis? [≤80, max 10], circumstances? ≤8000, status?: draft|counselor-review|approved|sent|declined }",
      input: z.object(appealFields).partial().extend({ student_id: uuid, school_name: appealFields.school_name }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/aid/appeals", body: { studentId: i.student_id, ...pick(i, APPEAL_KEYS) } }),
      describe: (i, h) => `Log an award appeal to "${plainText(i.school_name, 80)}" for ${h.studentName(i.student_id)}`,
      details: (i) => [
        ...changeLines(i, { status: "Status", basis: "Basis" }),
        ...("circumstances" in i ? [`Circumstances: ${plainText(i.circumstances, 1500)}`] : []),
      ],
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "aid.delete_appeal", input: { student_id: i.student_id, appeal_id: id } } : null;
      },
    }),
    op({
      name: "aid.update_appeal",
      kind: "write",
      risk: "auto",
      title: "Update an award appeal: status, basis, circumstances, school or linked letter.",
      doc: "{ student_id, appeal_id (aid.appeals), status?: draft|counselor-review|approved|sent|declined, basis? [≤80, max 10], circumstances? ≤8000, school_name? ≤300, award_letter_id?|null, student_college_id?|null }",
      input: z.object(appealFields).partial().extend({ student_id: uuid, appeal_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/aid/appeals/${seg(i.appeal_id)}${qs({ studentId: i.student_id })}`, body: pick(i, APPEAL_KEYS) }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Update ${appealLabel(await findIn(h, appealsUrl(i.student_id), i.appeal_id), name)} for ${name}`;
      },
      details: (i) => [
        ...changeLines(Object.fromEntries(Object.entries(i).filter(([k]) => k !== "circumstances")), APPEAL_LABELS),
        ...("circumstances" in i ? [`Circumstances: ${plainText(i.circumstances, 1500)}`] : []),
      ],
      snapshot: (i, h) => findIn(h, appealsUrl(i.student_id), i.appeal_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev = previous(i, b, Object.fromEntries(APPEAL_KEYS.map((k) => [k, k])), { basis: [], circumstances: "", status: "draft" });
        if ("school_name" in prev && !prev.school_name) return null;
        return { op: "aid.update_appeal", input: { student_id: i.student_id, appeal_id: i.appeal_id, ...prev } };
      },
    }),
    op({
      name: "aid.delete_appeal",
      kind: "write",
      risk: "confirm",
      title: "Delete an award appeal (and any letter drafted for it).",
      doc: "{ student_id, appeal_id }",
      input: z.object({ student_id: uuid, appeal_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/aid/appeals/${seg(i.appeal_id)}${qs({ studentId: i.student_id })}` }),
      describe: async (i, h) => {
        const name = h.studentName(i.student_id);
        return `Delete ${appealLabel(await findIn(h, appealsUrl(i.student_id), i.appeal_id), name)} for ${name}`;
      },
      warning: "The appeal is deleted, with any letter drafted for it.",
    }),
  ],
};

// ---- Scholarships ---------------------------------------------------------------

const AUDIENCES = ["union", "military-family", "first-responder", "language", "disability", "hardship", "single-parent", "military-service"] as const;
const MATCH_STATUS = ["suggested", "saved", "applying", "applied", "awarded", "dismissed"] as const;

const prefsFields = {
  audience: z.array(z.enum(AUDIENCES)).max(AUDIENCES.length),
  other_connection: z.string().trim().max(120).nullable(),
  home_language: z.string().trim().max(60).nullable(),
  min_award_cents: z.number().int().min(0).max(10_000_000),
  essays_ok: z.boolean(),
  basis: z.enum(["any", "merit", "need"]),
  max_applications: z.number().int().min(1).max(99),
};
const PREFS_DTO: Record<string, string> = {
  audience: "audience",
  other_connection: "otherConnection",
  home_language: "homeLanguage",
  min_award_cents: "minAwardCents",
  essays_ok: "essaysOk",
  basis: "basis",
  max_applications: "maxApplications",
};
const PREFS_LABELS = {
  audience: "Family circumstances",
  other_connection: "Other connection",
  home_language: "Home language",
  essays_ok: "Essays OK",
  basis: "Basis",
  max_applications: "Most to show",
};

const scanUrl = (studentId: string) => `/student-aid/${seg(studentId)}/scholarships/scan`;
const matchesUrl = (studentId: string) => `/aid/scholarships${qs({ studentId })}`;

/**
 * A catalog scholarship by id, for the card and the undo: from the student's
 * scan (matches, then the ones timing held back), else their own list. On the
 * student's list ("recommended") means a match row that isn't suggested or
 * dismissed, as lib/studentAid.ts reads it; the list leaves dismissed rows out,
 * so no row on either read means not recommended. Null when a read failed.
 */
async function findScholarship(
  h: Get,
  studentId: string,
  scholarshipId: string
): Promise<{ row: Row | null; recommended: boolean | null; match: Row | null }> {
  const [scan, list] = await Promise.all([h.get(scanUrl(studentId)), h.get<unknown[]>(matchesUrl(studentId))]);
  const s = asRecord(scan);
  const scanned = asArray(s.matches).find((m) => m.id === scholarshipId) ?? null;
  const held = asArray(s.held).find((m) => m.id === scholarshipId) ?? null;
  const match = asArray(list).find((m) => m.scholarship_id === scholarshipId) ?? null;
  const recommended =
    scanned && typeof scanned.recommended === "boolean" ? scanned.recommended : match ? match.status !== "suggested" : scan && Array.isArray(list) ? false : null;
  return { row: scanned ?? held ?? match, recommended, match };
}

export const scholarships: OpGroup = {
  heading: "Scholarships",
  ops: [
    op({
      name: "scholarships.find",
      kind: "read",
      title: "Catalog scholarships that match a student under the current search, with scholarship ids and which are recommended.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: scanUrl(i.student_id) }),
      reply: (body) => {
        const s = asRecord(body);
        const p = asRecord(s.prefs);
        const lines = [
          `Search: basis ${str(p.basis) ?? "any"}, essays ${p.essaysOk === false ? "excluded" : "OK"}, at most ${str(p.maxApplications) ?? "8"} shown.`,
          listReply(
            asArray(s.matches),
            (m) =>
              `scholarship_id ${str(m.id)}: ${untrusted(m.name)}${m.sponsor ? ` · ${untrusted(m.sponsor)}` : ""} · ${m.deadline ? `deadline ${str(m.deadline)}` : "no deadline"}${
                m.basis ? ` · ${str(m.basis)}` : ""
              }${m.essayRequired === true ? " · essay" : ""}${m.renewable === true ? " · renewable" : ""}${m.recommended ? " · recommended to the student" : ""}`,
            "No matches under the current search."
          ),
        ];
        const held = asArray(s.held).length;
        if (held) lines.push(`${held} more ${held === 1 ? "matches but is" : "match but are"} closed or not open yet.`);
        const missing = Array.isArray(s.missing) ? (s.missing as unknown[]).map(String) : [];
        if (missing.length) lines.push(`Not on file, so not checked: ${missing.join(", ")}.`);
        return lines.join("\n");
      },
    }),
    op({
      name: "scholarships.list",
      kind: "read",
      title: "The scholarship matches on a student's list with match ids and status (saved, applying, applied, awarded are on their side).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: matchesUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (m) =>
            `id ${str(m.id)}: ${untrusted(m.name)}${m.sponsor ? ` · ${untrusted(m.sponsor)}` : ""} [${str(m.status)}${m.status === "suggested" ? ", not on the student's side" : ""}]${
              m.deadline ? ` · deadline ${str(m.deadline)}` : ""
            }${m.scholarship_id ? ` · scholarship_id ${str(m.scholarship_id)}` : ""}`,
          "No scholarships on the student's list."
        ),
    }),
    op({
      name: "scholarships.update_search",
      kind: "write",
      risk: "auto",
      title: "Change a student's scholarship search: family circumstances, smallest award, essays OK, merit/need, how many to show.",
      doc: "{ student_id, audience? [union|military-family|first-responder|language|disability|hardship|single-parent|military-service], other_connection? ≤120|null, home_language? ≤60|null, min_award_cents? 0-10000000, essays_ok? bool, basis?: any|merit|need, max_applications? 1-99 }",
      input: z.object(prefsFields).partial().extend({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PUT",
        url: `/student-aid/${seg(i.student_id)}/scholarships/prefs`,
        body: defined({
          audience: i.audience,
          otherConnection: i.other_connection,
          homeLanguage: i.home_language,
          minAwardCents: i.min_award_cents,
          essaysOk: i.essays_ok,
          basis: i.basis,
          maxApplications: i.max_applications,
        }),
      }),
      describe: (i, h) => `Change ${h.studentName(i.student_id)}'s scholarship search`,
      details: (i) => [
        ...changeLines(i, PREFS_LABELS),
        ...("min_award_cents" in i ? [`Smallest award: ${i.min_award_cents ? `${dollars(i.min_award_cents)}+` : "any"}`] : []),
      ],
      snapshot: (i, h) => h.get(`/student-aid/${seg(i.student_id)}/scholarships/prefs`),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!("basis" in b)) return null;
        const prev = previous(i, b, PREFS_DTO, { audience: [], min_award_cents: 0, essays_ok: true, basis: "any", max_applications: 8 });
        return { op: "scholarships.update_search", input: { student_id: i.student_id, ...numeric(prev, ["min_award_cents", "max_applications"]) } };
      },
    }),
    op({
      name: "scholarships.recommend",
      kind: "write",
      risk: "confirm",
      title: "Recommend a catalog scholarship to a student (it goes on their own list), or take a recommendation back.",
      doc: "{ student_id, scholarship_id (scholarships.find), recommended: bool }",
      input: z.object({ student_id: uuid, scholarship_id: uuid, recommended: z.boolean() }).strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PUT",
        url: `/student-aid/${seg(i.student_id)}/scholarships/${seg(i.scholarship_id)}/recommend`,
        body: { recommended: i.recommended },
      }),
      describe: async (i, h) => {
        const { row } = await findScholarship(h, i.student_id, i.scholarship_id);
        const what = row ? `"${plainText(row.name, 80)}"` : "a scholarship";
        const name = h.studentName(i.student_id);
        return i.recommended ? `Recommend ${what} to ${name}` : `Take back the recommendation of ${what} from ${name}`;
      },
      details: async (i, h) => {
        const { row: s } = await findScholarship(h, i.student_id, i.scholarship_id);
        const amount = s ? s.amountCents ?? s.amount_cents : null;
        return [
          ...(s?.sponsor ? [`Sponsor: ${plainText(s.sponsor, 120)}`] : []),
          ...(s?.deadline ? [`Deadline: ${dayLabel(s.deadline)}`] : []),
          ...(amount != null ? [`Award: ${dollars(amount)}`] : []),
          ...(s ? [] : ["Scholarship: not found in this student's matches or list; check the id with scholarships.find"]),
          `The student: ${i.recommended ? "sees it on their own scholarship list" : "no longer sees it on their list"}`,
        ];
      },
      warning: "A recommended scholarship shows on the student's own list; taking one back removes it.",
      snapshot: async (i, h) => {
        const { recommended, match } = await findScholarship(h, i.student_id, i.scholarship_id);
        return recommended === null ? null : { recommended, matchId: match ? str(match.id) : null, status: match ? str(match.status) : null };
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (typeof b.recommended !== "boolean" || b.recommended === i.recommended) return null;
        // A match the counselor had only as a suggestion goes back to being one, not to dismissed.
        if (i.recommended && b.status === "suggested" && typeof b.matchId === "string") {
          return { op: "scholarships.set_status", input: { student_id: i.student_id, match_id: b.matchId, status: "suggested" } };
        }
        return { op: "scholarships.recommend", input: { student_id: i.student_id, scholarship_id: i.scholarship_id, recommended: b.recommended } };
      },
    }),
    op({
      name: "scholarships.set_status",
      kind: "write",
      risk: "confirm",
      title: "Move a scholarship match on the student's list: saved, applying, applied, awarded (on their side), or suggested, dismissed (off it).",
      doc: "{ student_id, match_id (scholarships.list), status: suggested|saved|applying|applied|awarded|dismissed }",
      input: z.object({ student_id: uuid, match_id: uuid, status: z.enum(MATCH_STATUS) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/aid/scholarships/${seg(i.match_id)}`, body: { status: i.status } }),
      describe: async (i, h) => {
        const m = await findIn(h, matchesUrl(i.student_id), i.match_id);
        const name = h.studentName(i.student_id);
        return `Set ${m ? `"${plainText(m.name, 80)}"` : `a scholarship that isn't on ${name}'s list`} to ${i.status} on ${name}'s list`;
      },
      details: async (i, h) => {
        const m = await findIn(h, matchesUrl(i.student_id), i.match_id);
        const was = m ? str(m.status) : null;
        const onSide = (s: string | null) => !!s && s !== "suggested" && s !== "dismissed";
        const lines = was ? [`Now: ${was}`] : [];
        if (onSide(i.status) && !onSide(was)) lines.push("The student: sees it on their own scholarship list from now on");
        else if (!onSide(i.status) && onSide(was)) lines.push("The student: no longer sees it on their list");
        return lines;
      },
      warning: "This changes what the student sees on their own scholarship list.",
      snapshot: async (i, h) => {
        const m = await findIn(h, matchesUrl(i.student_id), i.match_id);
        return m ? { status: m.status } : null;
      },
      undo: (i, _body, before) => {
        const prev = str(asRecord(before).status);
        if (!prev || prev === i.status) return null;
        return { op: "scholarships.set_status", input: { student_id: i.student_id, match_id: i.match_id, status: prev } };
      },
    }),
  ],
};

// ---- Program & Opportunity Concierge -------------------------------------------------

const OPP_STATUS = ["suggested", "counselor-review", "approved", "sent", "saved", "applied", "dismissed"] as const;
/** The student can read a match in these statuses (RLS `opportunity_matches_select`). */
const STUDENT_SEES = new Set<string>(["sent", "saved", "applied"]);

const oppUrl = (studentId: string) => `/opportunities/matches${qs({ studentId })}`;

export const opportunities: OpGroup = {
  heading: "Programs & opportunities",
  ops: [
    op({
      name: "opportunities.list",
      kind: "read",
      title: "A student's program and opportunity recommendations with ids and status (sent, saved, applied are on their side).",
      doc: "{ student_id, status?: suggested|counselor-review|approved|sent|saved|applied|dismissed }",
      input: z.object({ student_id: uuid, status: z.enum(OPP_STATUS).optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/opportunities/matches${qs({ studentId: i.student_id, status: i.status })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (m) => `id ${str(m.id)}: ${untrusted(m.name)}${m.org ? ` · ${untrusted(m.org)}` : ""} [${str(m.status)}]${m.deadline ? ` · deadline ${str(m.deadline)}` : ""}`,
          "No program recommendations for this student."
        ),
    }),
    op({
      name: "opportunities.update",
      kind: "write",
      // A sent recommendation is on the student's side, and an input can't tell whether this one is:
      // an edit, a dismissal or a status change may be what the student sees next.
      risk: "confirm",
      title: "Approve, dismiss or re-status a program recommendation, or edit why it fits, its summary or deadline.",
      doc: "{ student_id, match_id (opportunities.list), status?: suggested|counselor-review|approved|sent|saved|applied|dismissed, why_fit? ≤500, summary? ≤500, deadline? YYYY-MM-DD|null }",
      input: z
        .object({
          student_id: uuid,
          match_id: uuid,
          status: z.enum(OPP_STATUS).optional(),
          why_fit: z.string().trim().max(500).optional(),
          summary: z.string().trim().max(500).optional(),
          deadline: date.nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/opportunities/matches/${seg(i.match_id)}`,
        body: defined({ status: i.status, whyFit: i.why_fit, summary: i.summary, deadline: i.deadline }),
      }),
      describe: async (i, h) => {
        const m = await findIn(h, oppUrl(i.student_id), i.match_id);
        const name = h.studentName(i.student_id);
        const what = m ? `"${plainText(m.name, 80)}"` : `a program recommendation that isn't on ${name}'s list`;
        const keys = Object.keys(i).filter((k) => k !== "student_id" && k !== "match_id");
        if (keys.length === 1 && i.status === "approved") return `Approve ${what} for ${name}`;
        if (keys.length === 1 && i.status === "dismissed") return `Dismiss ${what} for ${name}`;
        return `Update ${what} for ${name}`;
      },
      details: async (i, h) => {
        const m = await findIn(h, oppUrl(i.student_id), i.match_id);
        const lines = changeLines(i, { status: "Status", deadline: "Deadline" });
        if (i.why_fit !== undefined) lines.push(`Why it fits: ${plainText(i.why_fit, 600)}`);
        if (i.summary !== undefined) lines.push(`Summary: ${plainText(i.summary, 600)}`);
        const was = m ? str(m.status) : null;
        const seesNow = was ? STUDENT_SEES.has(was) : false;
        const seesAfter = i.status !== undefined ? STUDENT_SEES.has(i.status) : seesNow;
        if (was) lines.unshift(`Now: ${was}`);
        if (!seesNow && seesAfter) lines.push("The student: sees it from now on (without the notification or calendar deadline that Send adds)");
        else if (seesNow && !seesAfter) lines.push("The student: no longer sees it");
        else if (seesNow) lines.push("The student: already sees this recommendation, and sees the change");
        return lines;
      },
      warning: "The student sees a recommendation once it is sent; this can change what they see.",
      snapshot: (i, h) => findIn(h, oppUrl(i.student_id), i.match_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev = previous(i, b, { status: "status", why_fit: "why_fit", summary: "summary", deadline: "deadline" }, { why_fit: "", summary: "" });
        if ("status" in prev && !prev.status) return null;
        return { op: "opportunities.update", input: { student_id: i.student_id, match_id: i.match_id, ...prev } };
      },
    }),
    op({
      name: "opportunities.send",
      kind: "write",
      risk: "confirm",
      title: "Send program recommendations to a student: one notification, and each one with a deadline lands on their calendar.",
      doc: "{ student_id, match_ids [1-25] (opportunities.list), note? ≤1000 }",
      input: z
        .object({
          student_id: uuid,
          match_ids: z.array(uuid).min(1).max(25),
          note: z.string().trim().max(1000).optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/opportunities/matches/send",
        body: defined({ studentId: i.student_id, matchIds: i.match_ids, note: i.note }),
      }),
      describe: (i, h) =>
        `Send ${i.match_ids.length === 1 ? "a program recommendation" : `${i.match_ids.length} program recommendations`} to ${h.studentName(i.student_id)}`,
      // The notification as routes/opportunities.ts writes it: its title from the matches found for this student, the note as its body.
      details: async (i, h) => {
        const name = h.studentName(i.student_id);
        const rows = asArray(await h.get<unknown[]>(oppUrl(i.student_id)));
        const found = i.match_ids.map((id) => rows.find((r) => r.id === id) ?? null);
        const known = found.filter((m): m is Row => m !== null);
        const subject = !known.length
          ? "(none of these is on this student's list, so nothing would be sent)"
          : known.length === 1
            ? `Your counselor recommended ${plainText(known[0]!.name, 120)}`
            : `Your counselor sent ${known.length} program recommendations`;
        const listed = found.map((m) =>
          m ? `${plainText(m.name, 80)}${m.deadline ? ` (deadline ${dayLabel(m.deadline)}: "Apply: …" goes on their calendar)` : ""}` : "an id that isn't on this student's list (skipped)"
        );
        return [
          `To: ${name}, the student (an in-app notification; no email or text)`,
          `Subject: ${subject}`,
          `Body: ${i.note ?? "Open your dashboard to see why each one fits and how to apply."}`,
          `Recommendations: ${listed.join("; ")}`,
        ];
      },
      warning: "The student is notified now and each dated recommendation lands on their calendar; it can't be unsent.",
    }),
  ],
};
