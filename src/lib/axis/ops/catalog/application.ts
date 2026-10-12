/**
 * A student's College list and Application page (routes/application.ts,
 * under /application). The board (Interested, Applying, Applied), the
 * Recommended column, essays as records, supplement Google Docs, and the
 * Activities and Awards & Honors sheets.
 *
 * Adding, moving, recording a decision and editing records run at once with an
 * Undo. These ask first: putting a school in Recommended, or taking one out or
 * putting it back (the student sees the column and the reason); removing a
 * school (the tasks, aid checklist and net price estimates tied to it go with
 * it); deleting an essay or a sheet row; giving an essay a link (the student
 * can open it); filing a document as an essay (its text is copied into a
 * record the student reads); creating a supplement Doc (Google shares it with
 * the student and emails them) and re-reading the Docs (every essay's saved
 * text is replaced).
 *
 * The essay guardrail: no op here carries essay or supplement prose. Essay ops
 * set the record (title, prompt, school, status, word limit, due date, link),
 * never its text. The sheets' free-text answers, which go into the student's
 * application as written (an activity's description and UC organization
 * description, an honor's UC eligibility and "how you earned it"), are left
 * out too: only names, categories, grades, hours and levels.
 *
 * Catalog ids come from colleges.find; a student's files from files.list_documents.
 */
import { z } from "zod";
import { GRADES, RECOGNITION, TIMINGS, UC_CATEGORIES, UC_LEVELS } from "../../../studentApplication.js";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";
import { docName } from "./files.js";

type Row = Record<string, unknown>;
type Getter = Pick<OpHelpers, "get">;

// The route's own shapes (routes/application.ts).
const trimmed = (max: number) => z.string().trim().max(max);
const date = z.string().date();

const ROUNDS = ["ED", "ED2", "EA", "REA", "SCEA", "RD", "rolling", "priority"] as const;
const STATUSES = ["not-started", "in-progress", "submitted", "accepted", "denied", "waitlisted", "deferred", "enrolled", "withdrawn"] as const;
const DECISIONS = new Set<string>(["accepted", "denied", "waitlisted", "deferred", "enrolled", "withdrawn"]);
const STAGES = ["interested", "applying", "applied"] as const;
const FITS = ["reach", "target", "likely"] as const;
const TESTING = ["required", "optional", "flexible", "blind"] as const;
const ESSAY_KINDS = ["personal-statement", "supplement", "other"] as const;
const ESSAY_STATUSES = ["not-started", "drafting", "review", "final"] as const;

const STAGE_LABEL: Record<(typeof STAGES)[number], string> = { interested: "Interested", applying: "Applying", applied: "Applied" };
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  "not-started": "not started",
  "in-progress": "in progress",
  submitted: "submitted",
  accepted: "admitted",
  denied: "denied",
  waitlisted: "waitlisted",
  deferred: "deferred",
  enrolled: "enrolling",
  withdrawn: "withdrawn",
};

// ---- lookups (for card labels and snapshots) -----------------------------------

type Board = { rows: Row[]; recs: Row[] };

async function loadBoard(h: Getter, studentId: string): Promise<Board | null> {
  const body = await h.get<unknown>(`/application/college-list${qs({ studentId })}`);
  if (!body) return null;
  const b = asRecord(body);
  return { rows: asArray(b.rows), recs: asArray(b.recommendations) };
}

async function findSchool(h: Getter, studentId: string, id: string): Promise<Row | null> {
  const board = await loadBoard(h, studentId);
  return board?.rows.find((r) => r.id === id) ?? null;
}

/** Only open recommendations come back from the board; a dismissed one reads as null. */
async function findRec(h: Getter, studentId: string, id: string): Promise<Row | null> {
  const board = await loadBoard(h, studentId);
  return board?.recs.find((r) => r.id === id) ?? null;
}

async function catalogName(h: Getter, collegeId: string): Promise<string | null> {
  const body = await h.get<unknown>(`/colleges/${seg(collegeId)}`);
  return str(asRecord(asRecord(body).college).name);
}

async function findEssay(h: Getter, studentId: string, id: string): Promise<Row | null> {
  const body = await h.get<unknown>(`/application/essays${qs({ studentId })}`);
  return asArray(asRecord(body).essays).find((e) => e.id === id) ?? null;
}

async function findStudentDocument(h: Getter, studentId: string, id: string): Promise<Row | null> {
  const docs = asArray(await h.get<unknown>(`/files/documents${qs({ studentId })}`));
  return docs.find((d) => d.id === id) ?? null;
}

async function loadSheets(h: Getter, studentId: string): Promise<{ activities: Row[]; honors: Row[] } | null> {
  const body = await h.get<unknown>(`/application/sheets${qs({ studentId })}`);
  if (!body) return null;
  const b = asRecord(body);
  return { activities: asArray(b.activities), honors: asArray(b.honors) };
}

async function findActivity(h: Getter, studentId: string, id: string): Promise<Row | null> {
  return (await loadSheets(h, studentId))?.activities.find((r) => r.id === id) ?? null;
}

async function findHonor(h: Getter, studentId: string, id: string): Promise<Row | null> {
  return (await loadSheets(h, studentId))?.honors.find((r) => r.id === id) ?? null;
}

/**
 * "Duke University" on "Maya Chen's" list. When the id isn't on that student's
 * list the card says so ("an unidentified school"), so a Confirm is never
 * asked for under a name the row doesn't have.
 */
const schoolLabel = (r: Row | null) => (r ? plainText(r.name, 80) : "an unidentified school");
const whose = (h: OpHelpers, r: Row | null, studentId: string) => (r ? `${h.studentName(studentId)}'s` : "the student's");
const essayLabel = (e: Row | null) => (e ? `"${plainText(e.title, 80)}"` : "an unidentified essay");
const activityLabel = (a: Row | null) => (a ? `"${plainText(str(a.organization) ?? str(a.position) ?? "Untitled activity", 80)}"` : "an unidentified activity");
const honorLabel = (a: Row | null) => (a ? `"${plainText(str(a.title) ?? "Untitled honor", 80)}"` : "an unidentified honor");

/** A snapshot value back into the op's input, or undefined when it no longer fits the route's enum. */
function enumArray<T extends string>(allowed: readonly T[], v: unknown): T[] | undefined {
  const arr = Array.isArray(v) ? v.map(String) : [];
  return arr.every((x) => (allowed as readonly string[]).includes(x)) ? (arr as T[]) : undefined;
}
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const SCHOOL_ID_DOC = "student_college_id (from college_list.list)";

// ==== College list ================================================================

const LIST_LABELS = {
  round: "Round",
  fit: "Fit",
  deadline: "Deadline",
  custom_deadline: "Counselor deadline",
  intended_major: "Intended major",
  binding: "Binding",
  notes: "Notes",
  sort_order: "Order",
};

const REQ_LABELS = { recs_required: "Recommendations required", recs_in_hand: "Recommendations in hand", testing: "Testing" };

const schoolRef = { student_id: uuid, student_college_id: uuid };

export const collegeList: OpGroup = {
  heading: "College list",
  ops: [
    op({
      name: "college_list.list",
      kind: "read",
      title: "A student's college list (with student_college_id) and their open Recommended schools.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/application/college-list${qs({ studentId: i.student_id })}` }),
      reply: (body) => {
        const b = asRecord(body);
        const rows = listReply(
          asArray(b.rows),
          (r) =>
            `student_college_id ${str(r.id)}: ${untrusted(r.name)} [${str(r.stage) ?? "?"}, ${str(r.status) ?? "?"}]${r.round ? ` round ${str(r.round)}` : ""}${r.fit ? `, ${str(r.fit)}` : ""}${r.collegeId ? "" : " (not in the catalog)"}`,
          "The college list is empty."
        );
        const recs = listReply(
          asArray(b.recommendations),
          (r) => `recommendation_id ${str(r.id)}: ${untrusted(r.name)}${r.fit ? ` (${str(r.fit)})` : ""}, suggested by ${str(r.suggestedBy) ?? "counselor"}`,
          "No open recommendations.",
          30
        );
        return `College list:\n${rows}\n\nRecommended:\n${recs}`;
      },
    }),
    op({
      name: "college_list.add",
      kind: "write",
      risk: "auto",
      title: "Put a school on a student's college list.",
      doc: "{ student_id, college_id? (from colleges.find) or name? ≤300, round?: ED|ED2|EA|REA|SCEA|RD|rolling|priority, fit?: reach|target|likely (likely = Safety), stage?: interested|applying|applied, intended_major? ≤200 }",
      input: z
        .object({
          student_id: uuid,
          college_id: uuid.nullable().optional(),
          name: trimmed(300).nullable().optional(),
          round: z.enum(ROUNDS).nullable().optional(),
          fit: z.enum(FITS).nullable().optional(),
          stage: z.enum(STAGES).optional(),
          intended_major: trimmed(200).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/application/college-list",
        body: defined({
          studentId: i.student_id,
          collegeId: i.college_id,
          name: i.name,
          round: i.round,
          fit: i.fit,
          stage: i.stage,
          intendedMajor: i.intended_major,
        }),
      }),
      describe: async (i, h) => {
        const name = (i.college_id ? await catalogName(h, i.college_id) : null) ?? (i.college_id ? "a catalog school" : plainText(i.name, 80) || "a school");
        return `Add ${name} to ${h.studentName(i.student_id)}'s college list${i.stage ? ` (${STAGE_LABEL[i.stage]})` : ""}`;
      },
      details: (i) => changeLines(i, { round: "Round", fit: "Fit", intended_major: "Intended major" }),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "college_list.remove", input: { student_id: i.student_id, student_college_id: id } } : null;
      },
    }),
    op({
      name: "college_list.recommend",
      kind: "write",
      // The student sees the school and the reason in their Recommended column.
      risk: "confirm",
      title: "Put a school in a student's Recommended column, with your reason (the student sees both).",
      doc: "{ student_id, college_id? (from colleges.find) or name? ≤300, fit?: reach|target|likely, why? ≤600 }",
      input: z
        .object({
          student_id: uuid,
          college_id: uuid.nullable().optional(),
          name: trimmed(300).nullable().optional(),
          fit: z.enum(FITS).nullable().optional(),
          why: trimmed(600).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/application/college-list/recommendations",
        body: defined({ studentId: i.student_id, collegeId: i.college_id, name: i.name, fit: i.fit, why: i.why }),
      }),
      describe: async (i, h) => {
        const name = (i.college_id ? await catalogName(h, i.college_id) : null) ?? (i.college_id ? "a catalog school" : plainText(i.name, 80) || "a school");
        return `Recommend ${name} to ${h.studentName(i.student_id)}`;
      },
      details: (i) => [...changeLines(i, { fit: "Fit" }), ...(i.why ? [`Why (the student reads this): ${plainText(i.why, 600)}`] : [])],
      warning: "The student sees this school, and the reason if one is given, in their Recommended column.",
      snapshot: async (i, h) => (await loadBoard(h, i.student_id))?.recs.map((r) => str(r.id)) ?? null,
      undo: (i, body, before) => {
        const id = idOf(body);
        // A recommendation already open before is only refreshed by the route; dismissing it would undo more than this did.
        if (!id || !Array.isArray(before) || before.includes(id)) return null;
        return { op: "college_list.update_recommendation", input: { student_id: i.student_id, recommendation_id: id, status: "dismissed" } };
      },
    }),
    op({
      name: "college_list.accept_recommendation",
      kind: "write",
      risk: "auto",
      title: "Move a Recommended school onto the student's college list.",
      doc: "{ student_id, recommendation_id (from college_list.list), stage?: interested|applying|applied, intended_major? ≤200 }",
      input: z
        .object({
          student_id: uuid,
          recommendation_id: uuid,
          stage: z.enum(STAGES).optional(),
          intended_major: trimmed(200).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: `/application/college-list/recommendations/${seg(i.recommendation_id)}/accept`,
        body: defined({ stage: i.stage, intendedMajor: i.intended_major }),
      }),
      describe: async (i, h) => {
        const r = await findRec(h, i.student_id, i.recommendation_id);
        return `Add recommended ${schoolLabel(r)} to ${whose(h, r, i.student_id)} college list${i.stage ? ` (${STAGE_LABEL[i.stage]})` : ""}`;
      },
      details: (i) => changeLines(i, { intended_major: "Intended major" }),
      // No undo: the route marks the recommendation "added", and nothing puts it back in the
      // column; removing the school alone would take it off the list and out of Recommended both.
    }),
    op({
      name: "college_list.move",
      kind: "write",
      risk: "auto",
      title: "Move a school between board columns (Applied keeps a decision already recorded).",
      doc: `{ student_id, ${SCHOOL_ID_DOC}, stage: interested|applying|applied }`,
      input: z.object({ ...schoolRef, stage: z.enum(STAGES) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/college-list/${seg(i.student_college_id)}`, body: { stage: i.stage } }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        return `Move ${schoolLabel(r)} to ${STAGE_LABEL[i.stage]} on ${whose(h, r, i.student_id)} college list`;
      },
      snapshot: (i, h) => findSchool(h, i.student_id, i.student_college_id),
      undo: (i, _body, before) => {
        const status = str(asRecord(before).status);
        return status && (STATUSES as readonly string[]).includes(status)
          ? { op: "college_list.set_status", input: { student_id: i.student_id, student_college_id: i.student_college_id, status } }
          : null;
      },
    }),
    op({
      name: "college_list.set_status",
      kind: "write",
      risk: "auto",
      title: "Record a school's application status or admission decision (admitted, denied, waitlisted…).",
      doc: `{ student_id, ${SCHOOL_ID_DOC}, status: not-started|in-progress|submitted|accepted|denied|waitlisted|deferred|enrolled|withdrawn }`,
      input: z.object({ ...schoolRef, status: z.enum(STATUSES) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/college-list/${seg(i.student_college_id)}`, body: { status: i.status } }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        const who = r ? ` for ${h.studentName(i.student_id)}` : "";
        return DECISIONS.has(i.status)
          ? `Record ${schoolLabel(r)}: ${STATUS_LABEL[i.status]}${who}`
          : `Set ${schoolLabel(r)} to ${STATUS_LABEL[i.status]}${who}`;
      },
      snapshot: (i, h) => findSchool(h, i.student_id, i.student_college_id),
      undo: (i, _body, before) => {
        const status = str(asRecord(before).status);
        return status && (STATUSES as readonly string[]).includes(status)
          ? { op: "college_list.set_status", input: { student_id: i.student_id, student_college_id: i.student_college_id, status } }
          : null;
      },
    }),
    op({
      name: "college_list.update",
      kind: "write",
      risk: "auto",
      title: "Change a school on the list: round, deadline, fit, intended major, binding, notes, order.",
      doc: "{ student_id, student_college_id, round?: ED|ED2|EA|REA|SCEA|RD|rolling|priority, fit?: reach|target|likely (likely = Safety), deadline? YYYY-MM-DD (the school's), custom_deadline? YYYY-MM-DD (yours), intended_major? ≤200, binding? bool, notes? ≤4000, sort_order? 0-999 } (null clears)",
      input: z
        .object({
          ...schoolRef,
          round: z.enum(ROUNDS).nullable().optional(),
          fit: z.enum(FITS).nullable().optional(),
          deadline: date.nullable().optional(),
          custom_deadline: date.nullable().optional(),
          intended_major: trimmed(200).nullable().optional(),
          binding: z.boolean().optional(),
          notes: trimmed(4000).nullable().optional(),
          sort_order: z.number().int().min(0).max(999).optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/application/college-list/${seg(i.student_college_id)}`,
        body: defined({
          round: i.round,
          fit: i.fit,
          deadline: i.deadline,
          customDeadline: i.custom_deadline,
          intendedMajor: i.intended_major,
          binding: i.binding,
          notes: i.notes,
          sortOrder: i.sort_order,
        }),
      }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        return `Update ${schoolLabel(r)} on ${whose(h, r, i.student_id)} college list`;
      },
      details: (i) => changeLines(i, LIST_LABELS),
      snapshot: (i, h) => findSchool(h, i.student_id, i.student_college_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, student_college_id: i.student_college_id };
        if ("round" in i) {
          prev.round = b.round ?? null;
          // The route moves the catalog deadline with the round; put the old date back with it.
          if (!("deadline" in i)) prev.deadline = b.deadline ?? null;
        }
        if ("fit" in i) prev.fit = b.fit ?? null;
        if ("deadline" in i) prev.deadline = b.deadline ?? null;
        if ("custom_deadline" in i) prev.custom_deadline = b.customDeadline ?? null;
        if ("intended_major" in i) prev.intended_major = b.intendedMajor ?? null;
        if ("binding" in i) prev.binding = b.binding === true;
        if ("notes" in i) prev.notes = textOrNull(b.notes);
        if ("sort_order" in i) prev.sort_order = typeof b.sortOrder === "number" ? b.sortOrder : 0;
        return { op: "college_list.update", input: prev };
      },
    }),
    op({
      name: "college_list.update_requirements",
      kind: "write",
      risk: "auto",
      title: "Set a school's requirements: recommendation letters required and in hand, testing, application fee.",
      doc: "{ student_id, student_college_id, recs_required? 0-10, recs_in_hand? 0-10, testing?: required|optional|flexible|blind, application_fee_cents? 0-100000 } (null goes back to the catalog's)",
      input: z
        .object({
          ...schoolRef,
          recs_required: z.number().int().min(0).max(10).nullable().optional(),
          recs_in_hand: z.number().int().min(0).max(10).nullable().optional(),
          testing: z.enum(TESTING).nullable().optional(),
          application_fee_cents: z.number().int().min(0).max(100000).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/application/college-list/${seg(i.student_college_id)}`,
        body: defined({
          recsRequired: i.recs_required,
          recsInHand: i.recs_in_hand,
          testing: i.testing,
          applicationFeeCents: i.application_fee_cents,
        }),
      }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        return `Update ${schoolLabel(r)}'s requirements on ${whose(h, r, i.student_id)} college list`;
      },
      details: (i) => {
        const lines = changeLines(i, REQ_LABELS);
        if ("application_fee_cents" in i) {
          lines.push(`Application fee: ${i.application_fee_cents == null ? "the catalog's" : `$${(i.application_fee_cents / 100).toFixed(2)}`}`);
        }
        return lines;
      },
      snapshot: (i, h) => findSchool(h, i.student_id, i.student_college_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, student_college_id: i.student_college_id };
        // Lowering the requirement can clamp the count in hand, so both go back together.
        if ("recs_required" in i || "recs_in_hand" in i) {
          if ("recs_required" in i) prev.recs_required = b.recsRequired ?? null;
          prev.recs_in_hand = b.recsInHand ?? null;
        }
        // Testing and the fee read through to the catalog unless this row overrode them.
        if ("testing" in i) prev.testing = b.testingOverridden === true ? b.testing ?? null : null;
        if ("application_fee_cents" in i) prev.application_fee_cents = b.feeOverridden === true ? b.applicationFeeCents ?? null : null;
        if (typeof prev.testing === "string" && !(TESTING as readonly string[]).includes(prev.testing)) return null;
        return { op: "college_list.update_requirements", input: prev };
      },
    }),
    op({
      name: "college_list.update_recommendation",
      kind: "write",
      // Dismissing takes it out of the student's column; reopening shows it (and its reason) again.
      risk: (i) => (i.status !== undefined ? "confirm" : "auto"),
      title: "Dismiss a Recommended school or put one back (both wait for Confirm), or change its fit.",
      doc: "{ student_id, recommendation_id (from college_list.list), status?: open|dismissed, fit?: reach|target|likely|null }",
      input: z
        .object({
          student_id: uuid,
          recommendation_id: uuid,
          status: z.enum(["open", "dismissed"]).optional(),
          fit: z.enum(FITS).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/application/college-list/recommendations/${seg(i.recommendation_id)}`,
        body: defined({ status: i.status, fit: i.fit }),
      }),
      describe: async (i, h) => {
        const r = await findRec(h, i.student_id, i.recommendation_id);
        const name = r ? plainText(r.name, 80) : "a recommended school";
        if (i.status === "dismissed") return `Dismiss ${name} from ${whose(h, r, i.student_id)} Recommended column`;
        if (i.status === "open") return `Put ${name} back in ${h.studentName(i.student_id)}'s Recommended column`;
        return `Update ${name} in ${whose(h, r, i.student_id)} Recommended column`;
      },
      details: (i) => changeLines(i, { fit: "Fit" }),
      warning: "This changes what the student sees in their Recommended column.",
      snapshot: (i, h) => findRec(h, i.student_id, i.recommendation_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        // Only an open recommendation can be read back, so only its changes can be put back.
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, recommendation_id: i.recommendation_id };
        if ("status" in i) prev.status = "open";
        if ("fit" in i) prev.fit = b.fit ?? null;
        return { op: "college_list.update_recommendation", input: prev };
      },
    }),
    op({
      name: "college_list.remove",
      kind: "write",
      risk: "confirm",
      title: "Take a school off a student's college list.",
      doc: `{ student_id, ${SCHOOL_ID_DOC} }`,
      input: z.object(schoolRef).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/college-list/${seg(i.student_college_id)}` }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        return `Remove ${schoolLabel(r)} from ${whose(h, r, i.student_id)} college list`;
      },
      warning: "Tasks, the aid checklist and net price estimates tied to this school are deleted with it; its essays stay, unlinked.",
    }),
  ],
};

// ==== Essays ======================================================================

const ESSAY_LABELS = {
  essay_kind: "Kind",
  title: "Title",
  prompt: "Prompt",
  word_limit: "Word limit",
  external_url: "Link",
  status: "Status",
  due_date: "Due",
  sort_order: "Order",
};

async function schoolLine(h: OpHelpers, studentId: string, id: string | null | undefined): Promise<string[]> {
  if (id === undefined) return [];
  if (id === null) return ["School: none"];
  const r = await findSchool(h, studentId, id);
  return [`School: ${r ? plainText(r.name, 80) : "a school on the list"}`];
}

export const applicationEssays: OpGroup = {
  heading: "Application essays",
  ops: [
    op({
      name: "essays.list",
      kind: "read",
      title: "A student's essays with ids, the schools on their list, and the catalog's supplement prompts.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/application/essays${qs({ studentId: i.student_id })}` }),
      reply: (body) => {
        const b = asRecord(body);
        const colleges = asArray(b.colleges);
        const byCatalog = new Map(colleges.map((c) => [str(c.collegeId) ?? "", c.name]));
        const essays = listReply(
          asArray(b.essays),
          (e) => `essay_id ${str(e.id)}: [${str(e.status) ?? "?"}] ${untrusted(e.title)}${e.school ? ` · ${untrusted(e.school)}` : ""} · ${Number(e.wordCount ?? 0)} words`,
          "No essays on file."
        );
        const schools = listReply(colleges, (c) => `student_college_id ${str(c.id)}: ${untrusted(c.name)}`, "The college list is empty.");
        const prompts = listReply(
          asArray(b.prompts),
          (p) =>
            `college_supplement_id ${str(p.id)}: ${untrusted(byCatalog.get(str(p.collegeId) ?? "") ?? "", "catalog")} ${untrusted(p.title, "catalog")}${p.wordLimit ? ` (up to ${Number(p.wordLimit)} words)` : ""}${p.required === false ? ", optional" : ""}`,
          "No catalog prompts for these schools this cycle.",
          40
        );
        const docs = asArray(b.docs).map((d) => untrusted(d.collegeName)).join(", ");
        return [`Essays:\n${essays}`, `Schools on the list:\n${schools}`, `Catalog supplement prompts (${str(b.cycle) ?? "this cycle"}):\n${prompts}`, docs ? `Schools that already have a supplement Google Doc: ${docs}` : ""]
          .filter(Boolean)
          .join("\n\n");
      },
    }),
    op({
      name: "essays.create",
      kind: "write",
      // A link on the record is one the student can open: a URL AxIS chose waits for the counselor.
      risk: (i) => (typeof i.external_url === "string" ? "confirm" : "auto"),
      title: "Add an essay record (personal statement or supplement); never its text. With a link it waits for Confirm.",
      doc: "{ student_id, essay_kind?: personal-statement|supplement|other, title? ≤300, prompt? ≤2000, student_college_id?, college_supplement_id?, word_limit? 1-20000, external_url? https, status?, due_date? YYYY-MM-DD }",
      input: z
        .object({
          student_id: uuid,
          essay_kind: z.enum(ESSAY_KINDS).optional(),
          title: trimmed(300).nullable().optional(),
          prompt: trimmed(2000).nullable().optional(),
          student_college_id: uuid.nullable().optional(),
          college_supplement_id: uuid.nullable().optional(),
          word_limit: z.number().int().min(1).max(20000).nullable().optional(),
          external_url: z.string().trim().url().max(2000).startsWith("https://").nullable().optional(),
          status: z.enum(ESSAY_STATUSES).optional(),
          due_date: date.nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/application/essays",
        body: defined({
          studentId: i.student_id,
          essayKind: i.essay_kind,
          title: i.title,
          prompt: i.prompt,
          studentCollegeId: i.student_college_id,
          collegeSupplementId: i.college_supplement_id,
          wordLimit: i.word_limit,
          externalUrl: i.external_url,
          status: i.status,
          dueDate: i.due_date,
        }),
      }),
      describe: (i, h) => {
        const what = i.title
          ? `essay "${plainText(i.title, 80)}"`
          : i.essay_kind === "personal-statement"
            ? "the Personal Statement"
            : i.college_supplement_id
              ? "a supplement from the catalog's prompt"
              : "an essay";
        return `Add ${what} to ${h.studentName(i.student_id)}'s Application page`;
      },
      details: async (i, h) => [...(await schoolLine(h, i.student_id, i.student_college_id)), ...changeLines(i, ESSAY_LABELS)],
      warning: "The student sees the essay record on their Application page and can open its link.",
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "essays.delete", input: { student_id: i.student_id, essay_id: id } } : null;
      },
    }),
    op({
      name: "essays.from_document",
      kind: "write",
      // The file's text is copied into the essay record, which the student reads (an excerpt and the
      // word count) even when the file itself is one they can't see (counselor-only, IEP/504, a waived letter).
      risk: "confirm",
      title: "File a document already in the student's Files as an essay (its word count is read from the file).",
      doc: "{ student_id, document_id (from files.list_documents), essay_kind?: personal-statement|supplement|other, student_college_id?, college_supplement_id?, title? ≤300 }",
      input: z
        .object({
          student_id: uuid,
          document_id: uuid,
          essay_kind: z.enum(ESSAY_KINDS).optional(),
          student_college_id: uuid.nullable().optional(),
          college_supplement_id: uuid.nullable().optional(),
          title: trimmed(300).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/application/essays/from-document",
        body: defined({
          studentId: i.student_id,
          documentId: i.document_id,
          essayKind: i.essay_kind,
          studentCollegeId: i.student_college_id,
          collegeSupplementId: i.college_supplement_id,
          title: i.title,
        }),
      }),
      describe: async (i, h) => {
        const d = await findStudentDocument(h, i.student_id, i.document_id);
        return `File ${d ? docName(d) : "an unidentified document"} as an essay for ${h.studentName(i.student_id)}`;
      },
      details: async (i, h) => {
        const d = await findStudentDocument(h, i.student_id, i.document_id);
        return [
          ...(d ? [`File: ${plainText(str(d.title) ?? d.filename, 120)} (${str(d.kind) ?? "other"})`] : ["File: not found among this student's files"]),
          ...(await schoolLine(h, i.student_id, i.student_college_id)),
          ...changeLines(i, { essay_kind: "Kind", title: "Title" }),
        ];
      },
      warning: "The file's text is copied into an essay record the student can read on their Application page.",
      reply: (body) => {
        const b = asRecord(body);
        return `Filed as an essay (id ${idOf(body) ?? "unknown"}).${b.textStatus === "unreadable" ? " Its text couldn't be read, so the word count is 0." : ""}`;
      },
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "essays.delete", input: { student_id: i.student_id, essay_id: id } } : null;
      },
    }),
    op({
      name: "essays.create_supplement_doc",
      kind: "write",
      risk: "confirm",
      title: "Create a Google Doc of a school's supplement prompts in your Drive, shared with the student.",
      doc: `{ student_id, ${SCHOOL_ID_DOC} } (needs Google connected; one Doc per school and cycle)`,
      input: z.object(schoolRef).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/supplement-docs", body: { studentId: i.student_id, studentCollegeId: i.student_college_id } }),
      describe: async (i, h) => {
        const r = await findSchool(h, i.student_id, i.student_college_id);
        return `Create a Google Doc of ${schoolLabel(r)}'s supplement prompts for ${h.studentName(i.student_id)} and share it with them`;
      },
      warning: "The Doc is created in your Google Drive and shared with the student, and Google emails them the link.",
      reply: (body) => {
        const b = asRecord(body);
        const doc = asRecord(b.doc);
        const essays = asArray(b.essays);
        const share = doc.shareStatus === "shared" ? "shared with the student" : doc.shareStatus === "failed" ? "not shared (Google refused the share)" : "not shared (no email on file)";
        return `Created the Doc (${share}) with ${essays.length} essay record(s): ${essays.map((e) => `essay_id ${str(e.id)} ${untrusted(e.title, "catalog")}`).join("; ") || "none"}.`;
      },
    }),
    op({
      name: "essays.update",
      kind: "write",
      risk: (i) => (typeof i.external_url === "string" ? "confirm" : "auto"),
      title: "Change an essay record (title, prompt, school, limit, link, status, due date); never its text. A new link waits.",
      doc: "{ student_id, essay_id, essay_kind?, title? ≤300, prompt? ≤2000|null, student_college_id?|null, word_limit?|null, external_url? https|null, status?: not-started|drafting|review|final, due_date?|null, sort_order? }",
      input: z
        .object({
          student_id: uuid,
          essay_id: uuid,
          essay_kind: z.enum(ESSAY_KINDS).optional(),
          title: trimmed(300).optional(),
          prompt: trimmed(2000).nullable().optional(),
          student_college_id: uuid.nullable().optional(),
          word_limit: z.number().int().min(1).max(20000).nullable().optional(),
          external_url: z.string().trim().url().max(2000).startsWith("https://").nullable().optional(),
          status: z.enum(ESSAY_STATUSES).optional(),
          due_date: date.nullable().optional(),
          sort_order: z.number().int().min(0).max(999).optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/application/essays/${seg(i.essay_id)}`,
        body: defined({
          essayKind: i.essay_kind,
          title: i.title,
          prompt: i.prompt,
          studentCollegeId: i.student_college_id,
          wordLimit: i.word_limit,
          externalUrl: i.external_url,
          status: i.status,
          dueDate: i.due_date,
          sortOrder: i.sort_order,
        }),
      }),
      describe: async (i, h) => {
        const e = await findEssay(h, i.student_id, i.essay_id);
        return `Update ${essayLabel(e)}${e ? ` on ${h.studentName(i.student_id)}'s Application page` : ""}`;
      },
      details: async (i, h) => [...(await schoolLine(h, i.student_id, i.student_college_id)), ...changeLines(i, ESSAY_LABELS)],
      warning: "The student can open the essay's new link from their Application page.",
      snapshot: (i, h) => findEssay(h, i.student_id, i.essay_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, essay_id: i.essay_id };
        if ("essay_kind" in i) prev.essay_kind = b.essayKind ?? "supplement";
        if ("title" in i) prev.title = str(b.title) ?? "Untitled essay";
        if ("prompt" in i) prev.prompt = textOrNull(b.prompt);
        if ("student_college_id" in i) {
          // A school typed on an older record has no list row to point back at; clearing would lose it.
          if (!b.studentCollegeId && str(b.school)) return null;
          prev.student_college_id = b.studentCollegeId ?? null;
        }
        if ("word_limit" in i) prev.word_limit = b.wordLimit ?? null;
        if ("external_url" in i) {
          // The DTO's url is the Doc's or the file's when there is one, so the old link is only known for a plain link.
          if (b.supplementDocId || b.documentId) return null;
          prev.external_url = b.url ?? null;
        }
        if ("status" in i) prev.status = b.status ?? "not-started";
        if ("due_date" in i) prev.due_date = b.dueDate ?? null;
        if ("sort_order" in i) prev.sort_order = typeof b.sortOrder === "number" ? b.sortOrder : 0;
        if (typeof prev.title === "string" && prev.title.length > 300) return null;
        if (typeof prev.prompt === "string" && prev.prompt.length > 2000) return null;
        return { op: "essays.update", input: prev };
      },
    }),
    op({
      name: "essays.sync_docs",
      kind: "write",
      risk: "confirm",
      title: "Re-read the Google Docs behind a student's essays so their word counts match the Docs.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/essays/sync", body: { studentId: i.student_id } }),
      describe: (i, h) => `Re-read the Google Docs behind ${h.studentName(i.student_id)}'s essays and update their word counts`,
      warning: "Each essay's saved text and word count are replaced by what its Doc holds now.",
      reply: (body) => {
        const b = asRecord(body);
        return `Re-read the Docs: ${Number(b.updated ?? 0)} essay(s) updated, ${Number(b.failed ?? 0)} couldn't be read.`;
      },
    }),
    op({
      name: "essays.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete an essay record from a student's Application page.",
      doc: "{ student_id, essay_id }",
      input: z.object({ student_id: uuid, essay_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/essays/${seg(i.essay_id)}` }),
      describe: async (i, h) => {
        const e = await findEssay(h, i.student_id, i.essay_id);
        return `Delete ${essayLabel(e)}${e ? ` from ${h.studentName(i.student_id)}'s Application page` : ""}`;
      },
      warning: "The essay record, its saved text and versions, and any task tied to it are deleted; a file or Google Doc it came from stays.",
    }),
  ],
};

// ==== Activities and Awards & Honors sheets ========================================

const activityFields = {
  organization: z.string().max(300).nullable(),
  position: z.string().max(300).nullable(),
  category: trimmed(100).nullable(),
  grade_levels: z.array(z.enum(GRADES)).max(5),
  timing: z.array(z.enum(TIMINGS)).max(1),
  hours_per_week: z.number().min(0).max(168).nullable(),
  weeks_per_year: z.number().int().min(0).max(52).nullable(),
  continuing: z.boolean().nullable(),
  uc_category: z.enum(UC_CATEGORIES).nullable(),
  sort_order: z.number().int().min(0).max(999),
};

const honorFields = {
  name: z.string().trim().max(300).nullable(),
  grade_levels: z.array(z.enum(GRADES)).max(5),
  recognition_levels: z.array(z.enum(RECOGNITION)).max(4),
  uc_type: z.enum(["academic", "non-academic"]).nullable(),
  uc_level: z.enum(UC_LEVELS).nullable(),
  sort_order: z.number().int().min(0).max(999),
};

const ACTIVITY_LABELS = {
  organization: "Organization",
  position: "Position",
  category: "Category",
  grade_levels: "Grades",
  timing: "Timing",
  hours_per_week: "Hours/week",
  weeks_per_year: "Weeks/year",
  continuing: "Continuing",
  uc_category: "UC category",
  sort_order: "Order",
};

const HONOR_LABELS = {
  name: "Honor",
  grade_levels: "Grades",
  recognition_levels: "Recognition",
  uc_type: "UC type",
  uc_level: "UC level",
  sort_order: "Order",
};

const activityBody = (i: Partial<Record<keyof typeof activityFields, unknown>>) =>
  defined({
    organization: i.organization,
    position: i.position,
    category: i.category,
    grade_levels: i.grade_levels,
    timing: i.timing,
    hours_per_week: i.hours_per_week,
    weeks_per_year: i.weeks_per_year,
    continuing: i.continuing,
    uc_category: i.uc_category,
    sort_order: i.sort_order,
  });

const honorBody = (i: Partial<Record<keyof typeof honorFields, unknown>>) =>
  defined({
    name: i.name,
    grade_levels: i.grade_levels,
    recognition_levels: i.recognition_levels,
    uc_type: i.uc_type,
    uc_level: i.uc_level,
    sort_order: i.sort_order,
  });

const optional = <T extends Record<string, z.ZodTypeAny>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };

export const applicationSheets: OpGroup = {
  heading: "Application sheets: activities and honors",
  ops: [
    op({
      name: "application.list_sheets",
      kind: "read",
      title: "A student's Activities and Awards & Honors sheet rows, with ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/application/sheets${qs({ studentId: i.student_id })}` }),
      reply: (body) => {
        const b = asRecord(body);
        const activities = listReply(
          asArray(b.activities),
          (a) =>
            `activity_id ${str(a.id)}: ${untrusted(a.organization)}${str(a.position) ? ` · ${untrusted(a.position)}` : ""}${str(a.category) ? ` [${untrusted(a.category)}]` : ""}${Array.isArray(a.gradeLevels) && a.gradeLevels.length ? ` grades ${a.gradeLevels.map(String).join(", ")}` : ""}`,
          "No activities.",
          30
        );
        const honors = listReply(
          asArray(b.honors),
          (a) =>
            `honor_id ${str(a.id)}: ${untrusted(a.title)}${Array.isArray(a.gradeLevels) && a.gradeLevels.length ? ` grades ${a.gradeLevels.map(String).join(", ")}` : ""}${Array.isArray(a.recognitionLevels) && a.recognitionLevels.length ? ` · ${a.recognitionLevels.map(String).join(", ")}` : ""}`,
          "No honors.",
          30
        );
        return `Activities:\n${activities}\n\nAwards & Honors:\n${honors}`;
      },
    }),
    op({
      name: "application.add_activity",
      kind: "write",
      risk: "auto",
      title: "Add a row to a student's Activities sheet (no descriptions: those are the student's own words).",
      doc: "{ student_id, organization? ≤300, position? ≤300, category? ≤100, grade_levels? [9|10|11|12|PG], timing? [school|break|year] (one), hours_per_week? 0-168, weeks_per_year? 0-52, continuing? bool, uc_category?: coursework-other|educational-prep|extracurricular|volunteer|work, sort_order? 0-999 }",
      input: z.object({ student_id: uuid, ...optional(activityFields) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/activities", body: { studentId: i.student_id, ...activityBody(i) } }),
      describe: (i, h) => `Add activity ${i.organization ? `"${plainText(i.organization, 80)}"` : "a row"} to ${h.studentName(i.student_id)}'s Activities sheet`,
      details: (i) => changeLines(i, ACTIVITY_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "application.delete_activity", input: { student_id: i.student_id, activity_id: id } } : null;
      },
    }),
    op({
      name: "application.add_honor",
      kind: "write",
      risk: "auto",
      title: "Add a row to a student's Awards & Honors sheet (no UC write-ups: those are the student's own words).",
      doc: "{ student_id, name? ≤300, grade_levels? [9|10|11|12|PG], recognition_levels? [school|state-regional|national|international], uc_type?: academic|non-academic, uc_level?: school|city-community|state|regional|national|international, sort_order? 0-999 }",
      input: z.object({ student_id: uuid, ...optional(honorFields) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/honors", body: { studentId: i.student_id, ...honorBody(i) } }),
      describe: (i, h) => `Add honor ${i.name ? `"${plainText(i.name, 80)}"` : "a row"} to ${h.studentName(i.student_id)}'s Awards & Honors sheet`,
      details: (i) => changeLines(i, HONOR_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "application.delete_honor", input: { student_id: i.student_id, honor_id: id } } : null;
      },
    }),
    op({
      name: "application.update_activity",
      kind: "write",
      risk: "auto",
      title: "Change a row on a student's Activities sheet.",
      doc: "{ student_id, activity_id, any add_activity field } (null clears; grade_levels/timing [] clear)",
      input: z.object({ student_id: uuid, activity_id: uuid, ...optional(activityFields) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/activities/${seg(i.activity_id)}`, body: activityBody(i) }),
      describe: async (i, h) => {
        const a = await findActivity(h, i.student_id, i.activity_id);
        return `Update ${activityLabel(a)}${a ? ` on ${h.studentName(i.student_id)}'s Activities sheet` : ""}`;
      },
      details: (i) => changeLines(i, ACTIVITY_LABELS),
      snapshot: (i, h) => findActivity(h, i.student_id, i.activity_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, activity_id: i.activity_id };
        if ("organization" in i) prev.organization = textOrNull(b.organization);
        if ("position" in i) prev.position = textOrNull(b.position);
        if ("category" in i) prev.category = textOrNull(b.category);
        if ("grade_levels" in i) {
          const grades = enumArray(GRADES, b.gradeLevels);
          if (!grades) return null;
          prev.grade_levels = grades;
        }
        if ("timing" in i) prev.timing = typeof b.timing === "string" ? [b.timing] : [];
        if ("hours_per_week" in i) prev.hours_per_week = b.hoursPerWeek ?? null;
        if ("weeks_per_year" in i) prev.weeks_per_year = b.weeksPerYear ?? null;
        if ("continuing" in i) prev.continuing = b.continuing ?? null;
        if ("uc_category" in i) prev.uc_category = b.ucCategory ?? null;
        if ("sort_order" in i) prev.sort_order = typeof b.sortOrder === "number" ? b.sortOrder : 0;
        return { op: "application.update_activity", input: prev };
      },
    }),
    op({
      name: "application.update_honor",
      kind: "write",
      risk: "auto",
      title: "Change a row on a student's Awards & Honors sheet.",
      doc: "{ student_id, honor_id, any add_honor field } (null clears; grade_levels/recognition_levels [] clear)",
      input: z.object({ student_id: uuid, honor_id: uuid, ...optional(honorFields) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/honors/${seg(i.honor_id)}`, body: honorBody(i) }),
      describe: async (i, h) => {
        const a = await findHonor(h, i.student_id, i.honor_id);
        return `Update ${honorLabel(a)}${a ? ` on ${h.studentName(i.student_id)}'s Awards & Honors sheet` : ""}`;
      },
      details: (i) => changeLines(i, HONOR_LABELS),
      snapshot: (i, h) => findHonor(h, i.student_id, i.honor_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, honor_id: i.honor_id };
        if ("name" in i) prev.name = textOrNull(b.title);
        if ("grade_levels" in i) {
          const grades = enumArray(GRADES, b.gradeLevels);
          if (!grades) return null;
          prev.grade_levels = grades;
        }
        if ("recognition_levels" in i) {
          const levels = enumArray(RECOGNITION, b.recognitionLevels);
          if (!levels) return null;
          prev.recognition_levels = levels;
        }
        if ("uc_type" in i) prev.uc_type = b.ucType ?? null;
        if ("uc_level" in i) prev.uc_level = b.ucLevel ?? null;
        if ("sort_order" in i) prev.sort_order = typeof b.sortOrder === "number" ? b.sortOrder : 0;
        return { op: "application.update_honor", input: prev };
      },
    }),
    op({
      name: "application.delete_activity",
      kind: "write",
      risk: "confirm",
      title: "Delete a row from a student's Activities sheet.",
      doc: "{ student_id, activity_id }",
      input: z.object({ student_id: uuid, activity_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/activities/${seg(i.activity_id)}` }),
      describe: async (i, h) => {
        const a = await findActivity(h, i.student_id, i.activity_id);
        return `Delete ${activityLabel(a)}${a ? ` from ${h.studentName(i.student_id)}'s Activities sheet` : ""}`;
      },
      warning: "The row is deleted, with the description the student wrote for it.",
    }),
    op({
      name: "application.delete_honor",
      kind: "write",
      risk: "confirm",
      title: "Delete a row from a student's Awards & Honors sheet.",
      doc: "{ student_id, honor_id }",
      input: z.object({ student_id: uuid, honor_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/honors/${seg(i.honor_id)}` }),
      describe: async (i, h) => {
        const a = await findHonor(h, i.student_id, i.honor_id);
        return `Delete ${honorLabel(a)}${a ? ` from ${h.studentName(i.student_id)}'s Awards & Honors sheet` : ""}`;
      },
      warning: "The row is deleted, with what the student wrote about it.",
    }),
  ],
};
