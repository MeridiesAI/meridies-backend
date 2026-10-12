/**
 * The student record: the Application page's Activities and Honors sheets
 * (routes/application.ts, the routes the app edits them through, with the
 * sheet's row cap), and from routes/records.ts the courses, test scores,
 * academics and meeting notes; guardians are the
 * /accountability/guardians collection (routes/accountability.ts).
 *
 * Record edits are data the counselor and the student already keep; nothing
 * is sent when one changes, so adding and editing run at once with an Undo.
 * Deleting asks. So does sharing a meeting note with the student, and every
 * guardian change, because a guardian's contact details and switches decide
 * who receives parent alerts. A guardian reaches the model as an id, a first
 * name and a relationship, never an email, a phone number or an address.
 *
 * Activity and honor text (descriptions, UC answers) is the student's or the
 * counselor's words: AxIS enters what it is given and never composes it.
 */
import { z } from "zod";
import { GRADES, RECOGNITION, TIMINGS, UC_CATEGORIES, UC_LEVELS } from "../../../studentApplication.js";
import { op, type OpGroup, type UndoStep } from "../types.js";
import { asArray, asRecord, changeLines, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = { get<T>(url: string): Promise<T | null> };
type Row = Record<string, unknown>;

// ---- shared ---------------------------------------------------------------------

/** One row of a student-scoped list, or null (not on file, or not this student's). */
async function findRow(h: Get, url: string, id: string): Promise<Row | null> {
  return asArray(await h.get<unknown[]>(url)).find((r) => r.id === id) ?? null;
}

/** The update that puts back exactly the keys `i` changed, or null when the old values don't pass the op's own input. */
function restore(
  name: string,
  schema: z.ZodTypeAny,
  i: Row,
  keep: Row,
  from: Record<string, (b: Row) => unknown>,
  before: unknown
): UndoStep | null {
  const b = asRecord(before);
  if (!b.id) return null;
  const prev: Row = { ...keep };
  for (const [k, get] of Object.entries(from)) {
    if (!(k in i) || i[k] === undefined) continue;
    const v = get(b);
    if (v === undefined) return null;
    prev[k] = v;
  }
  if (Object.keys(prev).length === Object.keys(keep).length) return null;
  return schema.safeParse(prev).success ? { op: name, input: prev } : null;
}

const quoted = (v: unknown, fallback: string) => {
  const s = str(v);
  return s ? `"${plainText(s, 80)}"` : fallback;
};

const sortOrder = z.number().int().min(0).max(999);
const trimmed = (max: number) => z.string().trim().max(max);

/** Card name for a student, only once the row was found on that student's list. */
const whose = (row: Row | null, studentId: string, h: { studentName(id: string): string }) => (row ? ` for ${h.studentName(studentId)}` : "");

// ---- Activities sheet (/application/activities) ---------------------------------------

const activityFields = {
  category: trimmed(100).nullable(),
  grade_levels: z.array(z.enum(GRADES)).max(5),
  timing: z.array(z.enum(TIMINGS)).max(1),
  hours_per_week: z.number().min(0).max(168).nullable(),
  weeks_per_year: z.number().int().min(0).max(52).nullable(),
  continuing: z.boolean().nullable(),
  position: z.string().max(300).nullable(),
  organization: z.string().max(300).nullable(),
  description: z.string().max(2000).nullable(),
  uc_category: z.enum(UC_CATEGORIES).nullable(),
  uc_org_description: z.string().max(2000).nullable(),
  uc_description: z.string().max(2000).nullable(),
  sort_order: sortOrder,
};
const activityOptional = Object.fromEntries(Object.entries(activityFields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof activityFields]: z.ZodOptional<(typeof activityFields)[K]>;
};

const ACTIVITY_LABELS = {
  organization: "Activity",
  position: "Position",
  category: "Category",
  grade_levels: "Grades",
  timing: "Timing",
  hours_per_week: "Hours/week",
  weeks_per_year: "Weeks/year",
  continuing: "Continuing",
  description: "Description",
  uc_category: "UC category",
  uc_org_description: "UC organization description",
  uc_description: "UC description",
  sort_order: "Order",
};

const activityBody = (i: Row) => defined(Object.fromEntries(Object.keys(activityFields).map((k) => [k, i[k]])));
const activitiesUrl = (studentId: string) => `/application/activities${qs({ studentId })}`;
const activityName = (a: Row | null) => (a ? quoted(a.organization, quoted(a.position, "an untitled activity")) : "an activity");

const activityUpdateInput = z.object({ activity_id: uuid, student_id: uuid, ...activityOptional }).strict();

export const activities: OpGroup = {
  heading: "Activities sheet",
  ops: [
    op({
      name: "activities.list",
      kind: "read",
      title: "A student's Activities sheet rows with ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: activitiesUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (a) => {
            const facts = [
              str(a.category) ? `category ${untrusted(a.category)}` : null,
              Array.isArray(a.gradeLevels) && a.gradeLevels.length ? `grades ${a.gradeLevels.join(",")}` : null,
              a.hoursPerWeek != null ? `${str(a.hoursPerWeek)} h/wk` : null,
              a.weeksPerYear != null ? `${str(a.weeksPerYear)} wk/yr` : null,
            ].filter(Boolean);
            return `id ${str(a.id)}: ${untrusted(a.organization)}${str(a.position) ? ` · ${untrusted(a.position)}` : ""}${facts.length ? ` [${facts.join(", ")}]` : ""}`;
          },
          "The Activities sheet is empty."
        ),
    }),
    op({
      name: "activities.create",
      kind: "write",
      risk: "auto",
      title: "Add a row to a student's Activities sheet.",
      doc: "{ student_id, organization? (the activity), position?, category?, grade_levels? [9|10|11|12|PG], timing? [school|break|year], hours_per_week?, weeks_per_year?, continuing?, description? ≤2000, uc_category?, uc_description?, uc_org_description? }",
      input: z.object({ student_id: uuid, ...activityOptional }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/activities", body: { studentId: i.student_id, ...activityBody(i) } }),
      describe: (i, h) => `Add ${quoted(i.organization, "an activity")} to ${h.studentName(i.student_id)}'s Activities sheet`,
      details: (i) => changeLines(defined({ ...i, organization: undefined }), ACTIVITY_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "activities.delete", input: { activity_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "activities.update",
      kind: "write",
      risk: "auto",
      title: "Change an Activities sheet row (any of its cells).",
      doc: "{ activity_id, student_id, any create field (|null clears), uc_category?: coursework-other|educational-prep|extracurricular|volunteer|work, sort_order? 0–999 }",
      input: activityUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/activities/${seg(i.activity_id)}`, body: activityBody(i) }),
      describe: async (i, h) => {
        const a = await findRow(h, activitiesUrl(i.student_id), i.activity_id);
        return `Update ${activityName(a)} on the Activities sheet${whose(a, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, ACTIVITY_LABELS),
      snapshot: (i, h) => findRow(h, activitiesUrl(i.student_id), i.activity_id),
      undo: (i, _body, before) =>
        restore(
          "activities.update",
          activityUpdateInput,
          i,
          { activity_id: i.activity_id, student_id: i.student_id },
          {
            organization: (b) => b.organization ?? null,
            position: (b) => b.position ?? null,
            category: (b) => b.category ?? null,
            grade_levels: (b) => (Array.isArray(b.gradeLevels) ? b.gradeLevels : []),
            timing: (b) => (b.timing ? [b.timing] : []),
            hours_per_week: (b) => b.hoursPerWeek ?? null,
            weeks_per_year: (b) => b.weeksPerYear ?? null,
            continuing: (b) => b.continuing ?? null,
            description: (b) => b.description ?? null,
            uc_category: (b) => b.ucCategory ?? null,
            uc_org_description: (b) => b.ucOrgDescription ?? null,
            uc_description: (b) => b.ucDescription ?? null,
            sort_order: (b) => b.sortOrder ?? 0,
          },
          before
        ),
    }),
    op({
      name: "activities.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a row from a student's Activities sheet.",
      doc: "{ activity_id, student_id }",
      input: z.object({ activity_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/activities/${seg(i.activity_id)}` }),
      describe: async (i, h) => {
        const a = await findRow(h, activitiesUrl(i.student_id), i.activity_id);
        return `Delete ${activityName(a)} from ${a ? `${h.studentName(i.student_id)}'s ` : "the "}Activities sheet`;
      },
      warning: "The row and everything in it are deleted.",
    }),
  ],
};

// ---- Honors sheet (/application/honors; the `awards` table) ---------------------------------

const awardFields = {
  name: trimmed(300).nullable(),
  grade_levels: z.array(z.enum(GRADES)).max(5),
  recognition_levels: z.array(z.enum(RECOGNITION)).max(4),
  uc_type: z.enum(["academic", "non-academic"]).nullable(),
  uc_level: z.enum(UC_LEVELS).nullable(),
  uc_criteria: z.string().max(2000).nullable(),
  uc_earned: z.string().max(2000).nullable(),
  sort_order: sortOrder,
};
const awardOptional = Object.fromEntries(Object.entries(awardFields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof awardFields]: z.ZodOptional<(typeof awardFields)[K]>;
};

const AWARD_LABELS = {
  name: "Honor",
  grade_levels: "Grades",
  recognition_levels: "Recognition",
  uc_type: "UC type",
  uc_level: "UC level",
  uc_criteria: "UC eligibility",
  uc_earned: "UC achievement",
  sort_order: "Order",
};

const awardBody = (i: Row) => defined(Object.fromEntries(Object.keys(awardFields).map((k) => [k, i[k]])));
const honorsUrl = (studentId: string) => `/application/honors${qs({ studentId })}`;
const awardName = (a: Row | null) => (a ? quoted(a.title, "an untitled honor") : "an honor");

const awardUpdateInput = z.object({ award_id: uuid, student_id: uuid, ...awardOptional }).strict();

export const awards: OpGroup = {
  heading: "Honors sheet",
  ops: [
    op({
      name: "awards.list",
      kind: "read",
      title: "A student's Honors sheet (honors and awards) with ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: honorsUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (a) => {
            const grades = Array.isArray(a.gradeLevels) ? a.gradeLevels.join(",") : "";
            const levels = Array.isArray(a.recognitionLevels) ? a.recognitionLevels.join(",") : "";
            const facts = [grades ? `grades ${grades}` : null, levels ? `recognition ${levels}` : null].filter(Boolean);
            return `id ${str(a.id)}: ${untrusted(a.title)}${facts.length ? ` [${facts.join(", ")}]` : ""}`;
          },
          "The Honors sheet is empty."
        ),
    }),
    op({
      name: "awards.create",
      kind: "write",
      risk: "auto",
      title: "Add an honor or award to a student's Honors sheet.",
      doc: "{ student_id, name? ≤300, grade_levels? [9|10|11|12|PG], recognition_levels? [school|state-regional|national|international], uc_type?: academic|non-academic, uc_level?, uc_criteria? ≤2000, uc_earned? ≤2000, sort_order? }",
      input: z.object({ student_id: uuid, ...awardOptional }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/application/honors", body: { studentId: i.student_id, ...awardBody(i) } }),
      describe: (i, h) => `Add ${quoted(i.name, "an honor")} to ${h.studentName(i.student_id)}'s Honors sheet`,
      details: (i) => changeLines(defined({ ...i, name: undefined }), AWARD_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "awards.delete", input: { award_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "awards.update",
      kind: "write",
      risk: "auto",
      title: "Change an Honors sheet row.",
      doc: "{ award_id, student_id, name?, grade_levels?, recognition_levels?, uc_type?, uc_level?: school|city-community|state|regional|national|international, uc_criteria?, uc_earned?, sort_order? (each |null to clear) }",
      input: awardUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/application/honors/${seg(i.award_id)}`, body: awardBody(i) }),
      describe: async (i, h) => {
        const a = await findRow(h, honorsUrl(i.student_id), i.award_id);
        return `Update ${awardName(a)} on the Honors sheet${whose(a, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, AWARD_LABELS),
      snapshot: (i, h) => findRow(h, honorsUrl(i.student_id), i.award_id),
      undo: (i, _body, before) =>
        restore(
          "awards.update",
          awardUpdateInput,
          i,
          { award_id: i.award_id, student_id: i.student_id },
          {
            name: (b) => b.title ?? null,
            grade_levels: (b) => (Array.isArray(b.gradeLevels) ? b.gradeLevels : []),
            recognition_levels: (b) => (Array.isArray(b.recognitionLevels) ? b.recognitionLevels : []),
            uc_type: (b) => b.ucType ?? null,
            uc_level: (b) => b.ucLevel ?? null,
            uc_criteria: (b) => b.ucEligibility ?? null,
            uc_earned: (b) => b.ucAchievement ?? null,
            sort_order: (b) => b.sortOrder ?? 0,
          },
          before
        ),
    }),
    op({
      name: "awards.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a row from a student's Honors sheet.",
      doc: "{ award_id, student_id }",
      input: z.object({ award_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/application/honors/${seg(i.award_id)}` }),
      describe: async (i, h) => {
        const a = await findRow(h, honorsUrl(i.student_id), i.award_id);
        return `Delete ${awardName(a)} from ${a ? `${h.studentName(i.student_id)}'s ` : "the "}Honors sheet`;
      },
      warning: "The row and everything in it are deleted.",
    }),
  ],
};

// ---- Courses (/courses) ---------------------------------------------------------------

const COURSE_TYPES = ["ap", "ib", "honors", "dual-enrollment", "college", "other"] as const;
const COURSE_STATUSES = ["planned", "in-progress", "completed"] as const;

const courseFields = {
  // The route's schema leaves name optional for PATCH; the table refuses an empty one.
  name: trimmed(300).min(1),
  type: z.enum(COURSE_TYPES),
  grade: trimmed(20),
  status: z.enum(COURSE_STATUSES),
  school_year: trimmed(20),
  sort_order: sortOrder,
};

const COURSE_LABELS = { name: "Course", type: "Type", grade: "Grade", status: "Status", school_year: "School year", sort_order: "Order" };

const courseBody = (i: Row) => defined({ name: i.name, type: i.type, grade: i.grade, status: i.status, school_year: i.school_year, sort_order: i.sort_order });
const coursesUrl = (studentId: string) => `/courses${qs({ studentId })}`;

const courseUpdateInput = z
  .object({
    course_id: uuid,
    student_id: uuid,
    name: courseFields.name.optional(),
    type: courseFields.type.optional(),
    grade: courseFields.grade.optional(),
    status: courseFields.status.optional(),
    school_year: courseFields.school_year.optional(),
    sort_order: courseFields.sort_order.optional(),
  })
  .strict();

export const courses: OpGroup = {
  heading: "Courses",
  ops: [
    op({
      name: "courses.list",
      kind: "read",
      title: "A student's courses with ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: coursesUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (c) => {
            const facts = [str(c.type), str(c.status), str(c.grade) ? `grade ${untrusted(c.grade)}` : null, str(c.school_year) ? untrusted(c.school_year) : null].filter(Boolean);
            return `id ${str(c.id)}: ${untrusted(c.name)}${facts.length ? ` [${facts.join(", ")}]` : ""}`;
          },
          "No courses on file."
        ),
    }),
    op({
      name: "courses.create",
      kind: "write",
      risk: "auto",
      title: "Add a course to a student's record.",
      doc: "{ student_id, name ≤300, type?: ap|ib|honors|dual-enrollment|college|other, status?: planned|in-progress|completed, grade? ≤20, school_year? ≤20, sort_order? }",
      input: z
        .object({
          student_id: uuid,
          name: courseFields.name,
          type: courseFields.type.optional(),
          grade: courseFields.grade.optional(),
          status: courseFields.status.optional(),
          school_year: courseFields.school_year.optional(),
          sort_order: courseFields.sort_order.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/courses", body: { studentId: i.student_id, ...courseBody(i) } }),
      describe: (i, h) => `Add the course "${plainText(i.name, 80)}" for ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(defined({ ...i, name: undefined }), COURSE_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "courses.delete", input: { course_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "courses.update",
      kind: "write",
      risk: "auto",
      title: "Change a course: name, type, status, grade, school year.",
      doc: "{ course_id, student_id, name?, type?, status?, grade?, school_year?, sort_order? }",
      input: courseUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/courses/${seg(i.course_id)}`, body: courseBody(i) }),
      describe: async (i, h) => {
        const c = await findRow(h, coursesUrl(i.student_id), i.course_id);
        return `Update ${c ? quoted(c.name, "a course") : "a course"}${whose(c, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, COURSE_LABELS),
      snapshot: (i, h) => findRow(h, coursesUrl(i.student_id), i.course_id),
      undo: (i, _body, before) =>
        restore(
          "courses.update",
          courseUpdateInput,
          i,
          { course_id: i.course_id, student_id: i.student_id },
          {
            name: (b) => b.name,
            type: (b) => b.type,
            grade: (b) => b.grade ?? "",
            status: (b) => b.status,
            school_year: (b) => b.school_year ?? "",
            sort_order: (b) => b.sort_order ?? 0,
          },
          before
        ),
    }),
    op({
      name: "courses.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a course from a student's record.",
      doc: "{ course_id, student_id }",
      input: z.object({ course_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/courses/${seg(i.course_id)}` }),
      describe: async (i, h) => {
        const c = await findRow(h, coursesUrl(i.student_id), i.course_id);
        return `Delete ${c ? quoted(c.name, "a course") : "a course"}${c ? ` from ${h.studentName(i.student_id)}'s record` : ""}`;
      },
      warning: "The course is removed from the student's record.",
    }),
  ],
};

// ---- Test scores (/test-scores) -------------------------------------------------------

const SCORE_KINDS = ["ap", "sat", "act", "ib", "toefl", "ielts", "other"] as const;

const scoreFields = {
  // Optional in the route's PATCH schema; the table refuses an empty one.
  exam: trimmed(200).min(1),
  kind: z.enum(SCORE_KINDS),
  score: trimmed(20),
  taken_on: z.string().date(),
  sort_order: sortOrder,
};

const SCORE_LABELS = { exam: "Exam", kind: "Kind", score: "Score", taken_on: "Taken", sort_order: "Order" };

const scoreBody = (i: Row) => defined({ exam: i.exam, kind: i.kind, score: i.score, taken_on: i.taken_on, sort_order: i.sort_order });
const scoresUrl = (studentId: string) => `/test-scores${qs({ studentId })}`;
const scoreName = (s: Row | null) => (s ? `${quoted(s.exam, "a test score")}${str(s.score) ? ` (${plainText(s.score, 20)})` : ""}` : "a test score");

const scoreUpdateInput = z
  .object({
    score_id: uuid,
    student_id: uuid,
    exam: scoreFields.exam.optional(),
    kind: scoreFields.kind.optional(),
    score: scoreFields.score.optional(),
    taken_on: scoreFields.taken_on.optional(),
    sort_order: scoreFields.sort_order.optional(),
  })
  .strict();

export const testScores: OpGroup = {
  heading: "Test scores",
  ops: [
    op({
      name: "test_scores.list",
      kind: "read",
      title: "A student's individual test scores (AP, SAT, ACT, IB, TOEFL, IELTS…) with ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: scoresUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (s) => `id ${str(s.id)}: ${untrusted(s.exam)} [${str(s.kind)}]${str(s.score) ? ` score ${untrusted(s.score)}` : ""}${str(s.taken_on) ? ` taken ${str(s.taken_on)}` : ""}`,
          "No test scores on file."
        ),
    }),
    op({
      name: "test_scores.create",
      kind: "write",
      risk: "auto",
      title: "Add a test score to a student's record.",
      doc: "{ student_id, exam ≤200 (e.g. AP Biology), kind?: ap|sat|act|ib|toefl|ielts|other, score? ≤20, taken_on? YYYY-MM-DD, sort_order? }",
      input: z
        .object({
          student_id: uuid,
          exam: scoreFields.exam,
          kind: scoreFields.kind.optional(),
          score: scoreFields.score.optional(),
          taken_on: scoreFields.taken_on.optional(),
          sort_order: scoreFields.sort_order.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/test-scores", body: { studentId: i.student_id, ...scoreBody(i) } }),
      describe: (i, h) => `Add ${i.exam ? `"${plainText(i.exam, 60)}"` : "a test"}${i.score ? ` score ${plainText(i.score, 20)}` : ""} for ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(defined({ kind: i.kind, taken_on: i.taken_on }), SCORE_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "test_scores.delete", input: { score_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "test_scores.update",
      kind: "write",
      risk: "auto",
      title: "Change a test score: exam, kind, score or date.",
      doc: "{ score_id, student_id, exam?, kind?, score?, taken_on? YYYY-MM-DD, sort_order? }",
      input: scoreUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/test-scores/${seg(i.score_id)}`, body: scoreBody(i) }),
      describe: async (i, h) => {
        const s = await findRow(h, scoresUrl(i.student_id), i.score_id);
        return `Update ${scoreName(s)}${whose(s, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, SCORE_LABELS),
      snapshot: (i, h) => findRow(h, scoresUrl(i.student_id), i.score_id),
      undo: (i, _body, before) =>
        restore(
          "test_scores.update",
          scoreUpdateInput,
          i,
          { score_id: i.score_id, student_id: i.student_id },
          {
            exam: (b) => b.exam,
            kind: (b) => b.kind,
            score: (b) => b.score ?? "",
            taken_on: (b) => b.taken_on,
            sort_order: (b) => b.sort_order ?? 0,
          },
          before
        ),
    }),
    op({
      name: "test_scores.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a test score from a student's record.",
      doc: "{ score_id, student_id }",
      input: z.object({ score_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/test-scores/${seg(i.score_id)}` }),
      describe: async (i, h) => {
        const s = await findRow(h, scoresUrl(i.student_id), i.score_id);
        return `Delete ${scoreName(s)}${s ? ` from ${h.studentName(i.student_id)}'s record` : ""}`;
      },
      warning: "The score is removed from the student's record.",
    }),
  ],
};

// ---- Academics (/academics, one row per student) --------------------------------------

const TEST_STATUSES = ["not-started", "prepping", "scheduled", "taken", "retaking", "test-optional"] as const;

const academicsInput = z
  .object({
    student_id: uuid,
    gpa_unweighted: z.number().min(0).max(110).nullable().optional(),
    gpa_weighted: z.number().min(0).max(110).nullable().optional(),
    gpa_scale: trimmed(20).nullable().optional(),
    gpa_band: trimmed(40).nullable().optional(),
    class_rank: trimmed(40).nullable().optional(),
    class_rank_value: trimmed(40).nullable().optional(),
    rigor_count: z.number().int().min(0).max(60).nullable().optional(),
    rigor_subjects: z.array(trimmed(60)).max(30).optional(),
    rigor_context: trimmed(2000).nullable().optional(),
    test_status: z.enum(TEST_STATUSES).nullable().optional(),
    sat_ebrw: z.number().int().min(200).max(800).nullable().optional(),
    sat_math: z.number().int().min(200).max(800).nullable().optional(),
    sat_superscore: z.number().int().min(400).max(1600).nullable().optional(),
    act_composite: z.number().int().min(1).max(36).nullable().optional(),
    planned_test_date: z.string().date().nullable().optional(),
    test_prep_status: trimmed(200).nullable().optional(),
    strength_areas: z.array(trimmed(60)).max(30).optional(),
    strength_subjects: z.array(trimmed(60)).max(30).optional(),
  })
  .strict();

const ACADEMIC_LABELS = {
  gpa_unweighted: "Unweighted GPA",
  gpa_weighted: "Weighted GPA",
  gpa_scale: "GPA scale",
  gpa_band: "GPA band",
  class_rank: "Class rank",
  class_rank_value: "Class rank value",
  rigor_count: "Rigorous courses",
  rigor_subjects: "Rigor subjects",
  rigor_context: "Rigor context",
  test_status: "Testing status",
  sat_ebrw: "SAT EBRW",
  sat_math: "SAT Math",
  sat_superscore: "SAT superscore",
  act_composite: "ACT composite",
  planned_test_date: "Planned test date",
  test_prep_status: "Test prep",
  strength_areas: "Strength areas",
  strength_subjects: "Strength subjects",
};

const ARRAY_KEYS = new Set(["rigor_subjects", "strength_areas", "strength_subjects"]);
const NUMERIC_KEYS = new Set(["gpa_unweighted", "gpa_weighted"]);

export const academics: OpGroup = {
  heading: "Academics",
  ops: [
    op({
      name: "academics.update",
      kind: "write",
      risk: "auto",
      title: "Set a student's academics: GPA, class rank, rigor, testing status and SAT/ACT figures, strengths.",
      doc: "{ student_id; any of (null clears): gpa_unweighted, gpa_weighted 0–110, gpa_scale, gpa_band, class_rank, class_rank_value, rigor_count, rigor_subjects[], rigor_context, test_status: not-started|prepping|scheduled|taken|retaking|test-optional, sat_ebrw, sat_math, sat_superscore, act_composite, planned_test_date, test_prep_status, strength_areas[], strength_subjects[] }",
      input: academicsInput,
      takesStudent: true,
      request: (i) => {
        const { student_id, ...rest } = i;
        return { method: "PUT", url: "/academics", body: { studentId: student_id, ...defined(rest) } };
      },
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s academics`,
      details: (i) => changeLines(i, ACADEMIC_LABELS),
      snapshot: async (i, h) => {
        const row = asRecord(await h.get<unknown>(`/academics${qs({ studentId: i.student_id })}`));
        return row.student_id ? row : null;
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.student_id) return null;
        const prev: Row = { student_id: i.student_id };
        for (const k of Object.keys(ACADEMIC_LABELS)) {
          if (!(k in i) || (i as Row)[k] === undefined) continue;
          const v = b[k];
          // numeric columns can come back as strings; the input wants numbers.
          prev[k] = ARRAY_KEYS.has(k) ? (Array.isArray(v) ? v : []) : NUMERIC_KEYS.has(k) && typeof v === "string" ? Number(v) : (v ?? null);
        }
        if (Object.keys(prev).length === 1) return null;
        return academicsInput.safeParse(prev).success ? { op: "academics.update", input: prev } : null;
      },
    }),
  ],
};

// ---- Meeting notes (/notes) -----------------------------------------------------------

const noteUpdateInput = z
  .object({
    note_id: uuid,
    student_id: uuid,
    // Optional in the route's PATCH schema; the table refuses an empty title.
    title: trimmed(300).min(1).optional(),
    meeting_date: z.string().date().optional(),
    summary: trimmed(4000).optional(),
    tags: z.array(trimmed(40)).max(20).optional(),
    visibility: z.enum(["private", "shared"]).optional(),
  })
  .strict();

const NOTE_LABELS = { title: "Title", meeting_date: "Meeting date", summary: "Summary", tags: "Tags", visibility: "Visibility" };
const notesUrl = (studentId: string) => `/notes${qs({ studentId })}`;
const noteName = (n: Row | null) => (n ? `the meeting note ${quoted(n.title, "(untitled)")}${str(n.date) ? ` (${dayLabel(n.date)})` : ""}` : "a meeting note");

export const meetingNotes: OpGroup = {
  heading: "Meeting notes",
  ops: [
    op({
      name: "meeting_notes.list",
      kind: "read",
      title: "A student's meeting notes with ids (newest first).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: notesUrl(i.student_id) }),
      reply: (body) =>
        listReply(
          asArray(body),
          (n) => {
            const tags = Array.isArray(n.tags) && n.tags.length ? ` tags ${untrusted(n.tags.join(", "))}` : "";
            return `id ${str(n.id)}: ${str(n.date) ?? "no date"} [${str(n.visibility) ?? "private"}] ${untrusted(n.title)}${tags}${str(n.summary) ? ` — ${untrusted(n.summary)}` : ""}`;
          },
          "No meeting notes on file.",
          40
        ),
    }),
    op({
      name: "meeting_notes.update",
      kind: "write",
      risk: (i) => (i.visibility === "shared" ? "confirm" : "auto"),
      title: "Change a meeting note: title, date, summary, tags, or share it with the student.",
      doc: "{ note_id, student_id, title? ≤300, meeting_date? YYYY-MM-DD, summary? ≤4000, tags? [≤40 each, ≤20], visibility?: private|shared }",
      input: noteUpdateInput,
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/notes/${seg(i.note_id)}`,
        body: defined({ title: i.title, meeting_date: i.meeting_date, summary: i.summary, tags: i.tags, visibility: i.visibility }),
      }),
      describe: async (i, h) => {
        const n = await findRow(h, notesUrl(i.student_id), i.note_id);
        if (i.visibility === "shared") return `Share ${noteName(n)} with ${h.studentName(i.student_id)}`;
        return `Update ${noteName(n)}${whose(n, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, NOTE_LABELS),
      warning: "A shared note can be read by the student.",
      snapshot: (i, h) => findRow(h, notesUrl(i.student_id), i.note_id),
      undo: (i, _body, before) =>
        restore(
          "meeting_notes.update",
          noteUpdateInput,
          i,
          { note_id: i.note_id, student_id: i.student_id },
          {
            title: (b) => b.title,
            meeting_date: (b) => b.date,
            summary: (b) => b.summary ?? "",
            tags: (b) => (Array.isArray(b.tags) ? b.tags : []),
            visibility: (b) => b.visibility,
          },
          before
        ),
    }),
    op({
      name: "meeting_notes.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a meeting note.",
      doc: "{ note_id, student_id }",
      input: z.object({ note_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/notes/${seg(i.note_id)}` }),
      describe: async (i, h) => {
        const n = await findRow(h, notesUrl(i.student_id), i.note_id);
        return `Delete ${noteName(n)}${whose(n, i.student_id, h)}`;
      },
      warning: "The note, including its full text, is deleted.",
    }),
  ],
};

// ---- Guardians (/accountability/guardians) ----------------------------------------------

const CHANNELS = ["email", "sms", "both"] as const;

const guardianFields = {
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).nullable(),
  phone: z.string().trim().max(40).nullable(),
  relationship: z.string().trim().max(60),
  preferred_channel: z.enum(CHANNELS),
  alerts_enabled: z.boolean(),
  receives_reports: z.boolean(),
  is_primary: z.boolean(),
};

const GUARDIAN_LABELS = {
  full_name: "Name",
  relationship: "Relationship",
  email: "Email",
  phone: "Phone",
  preferred_channel: "Prefers",
  alerts_enabled: "Parent alerts",
  receives_reports: "Family reports",
  is_primary: "Primary contact",
};

const guardianBody = (i: Row) =>
  defined({
    full_name: i.full_name,
    email: i.email,
    phone: i.phone,
    relationship: i.relationship,
    preferred_channel: i.preferred_channel,
    alerts_enabled: i.alerts_enabled,
    receives_reports: i.receives_reports,
    is_primary: i.is_primary,
  });

const guardiansUrl = (studentId: string) => `/accountability/guardians${qs({ studentId })}`;
const firstName = (v: unknown) => (str(v) ?? "").split(/\s+/)[0] ?? "";
const guardianName = (g: Row | null) =>
  g ? `${plainText(g.full_name, 80) || "a guardian"}${str(g.relationship) ? ` (${plainText(g.relationship, 40)})` : ""}` : "a guardian";

const guardianUpdateInput = z
  .object({
    guardian_id: uuid,
    student_id: uuid,
    full_name: guardianFields.full_name.optional(),
    email: guardianFields.email.optional(),
    phone: guardianFields.phone.optional(),
    relationship: guardianFields.relationship.optional(),
    preferred_channel: guardianFields.preferred_channel.optional(),
    alerts_enabled: guardianFields.alerts_enabled.optional(),
    receives_reports: guardianFields.receives_reports.optional(),
    is_primary: guardianFields.is_primary.optional(),
  })
  .strict();

export const guardians: OpGroup = {
  heading: "Guardians",
  ops: [
    op({
      name: "guardians.list",
      kind: "read",
      title: "A student's parents and guardians: id, first name and relationship only.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: guardiansUrl(i.student_id) }),
      // Never email, phone or anything else: a guardian's contact details are off the AI allowlist.
      reply: (body) =>
        listReply(
          asArray(body),
          (g) => `id ${str(g.id)}: ${untrusted(firstName(g.full_name), "guardian")}${str(g.relationship) ? ` (${untrusted(g.relationship, "guardian")})` : ""}`,
          "No guardians on file."
        ),
    }),
    op({
      name: "guardians.create",
      kind: "write",
      risk: "confirm",
      title: "Add a parent or guardian to a student, with how they're reached and which messages they get.",
      doc: "{ student_id, full_name ≤200, relationship? ≤60, email?, phone? ≤40, preferred_channel?: email|sms|both, alerts_enabled? bool, receives_reports? bool, is_primary? bool }",
      input: z
        .object({
          student_id: uuid,
          full_name: guardianFields.full_name,
          relationship: guardianFields.relationship.optional(),
          email: guardianFields.email.optional(),
          phone: guardianFields.phone.optional(),
          preferred_channel: guardianFields.preferred_channel.optional(),
          alerts_enabled: guardianFields.alerts_enabled.optional(),
          receives_reports: guardianFields.receives_reports.optional(),
          is_primary: guardianFields.is_primary.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/accountability/guardians", body: { studentId: i.student_id, ...guardianBody(i) } }),
      describe: (i, h) => `Add ${guardianName({ full_name: i.full_name, relationship: i.relationship })} as a guardian of ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(defined({ ...i, full_name: undefined, relationship: undefined }), GUARDIAN_LABELS),
      warning: "Unless parent alerts are switched off, they can receive the alerts and family reports you send about this student.",
      reply: (body) => `Added the guardian (id ${idOf(body) ?? "unknown"}).`,
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "guardians.delete", input: { guardian_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "guardians.update",
      kind: "write",
      risk: "confirm",
      title: "Change a guardian: name, relationship, contact details, preferred channel, or switch their alerts and reports on or off.",
      doc: "{ guardian_id, student_id, full_name?, relationship?, email?|null, phone?|null, preferred_channel?: email|sms|both, alerts_enabled?, receives_reports?, is_primary? }",
      input: guardianUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/accountability/guardians/${seg(i.guardian_id)}`, body: guardianBody(i) }),
      describe: async (i, h) => {
        const g = await findRow(h, guardiansUrl(i.student_id), i.guardian_id);
        return `Update ${guardianName(g)}${whose(g, i.student_id, h)}`;
      },
      details: (i) => changeLines(i, GUARDIAN_LABELS),
      warning: "It changes who receives parent alerts and family reports about this student, and where.",
      reply: () => "Updated the guardian.",
      snapshot: (i, h) => findRow(h, guardiansUrl(i.student_id), i.guardian_id),
      undo: (i, _body, before) => {
        // An old address or number would ride along in the undo step; contact details stay out of it.
        if ("email" in i || "phone" in i) return null;
        return restore(
          "guardians.update",
          guardianUpdateInput,
          i,
          { guardian_id: i.guardian_id, student_id: i.student_id },
          {
            full_name: (b) => b.full_name,
            relationship: (b) => b.relationship ?? "",
            preferred_channel: (b) => b.preferred_channel,
            alerts_enabled: (b) => b.alerts_enabled,
            receives_reports: (b) => b.receives_reports,
            is_primary: (b) => b.is_primary,
          },
          before
        );
      },
    }),
    op({
      name: "guardians.delete",
      kind: "write",
      risk: "confirm",
      title: "Remove a parent or guardian from a student.",
      doc: "{ guardian_id, student_id }",
      input: z.object({ guardian_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/accountability/guardians/${seg(i.guardian_id)}` }),
      describe: async (i, h) => {
        const g = await findRow(h, guardiansUrl(i.student_id), i.guardian_id);
        return `Remove ${guardianName(g)}${g ? ` from ${h.studentName(i.student_id)}'s guardians` : ""}`;
      },
      warning: "They stop receiving parent alerts and family reports, and their contact details are deleted.",
    }),
  ],
};
