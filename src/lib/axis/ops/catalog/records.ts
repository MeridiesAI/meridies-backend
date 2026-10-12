/**
 * The student record (routes/records.ts, registered at the root): courses,
 * test scores, the academics row and meeting notes. Each is data the
 * counselor and the student already keep; nothing is sent when one changes,
 * so adding and editing run at once with an Undo. Deleting asks, and so does
 * a meeting note shared with the student (on create or update): the student
 * can then read it.
 *
 * A meeting note's full text (`body`) is not on the AI allowlist, so no op
 * writes or reads it; replies carry only the date, title, summary and tags.
 *
 * The update and delete routes act on the row's real student whatever
 * `student_id` says; it is only how the card finds the row to name it. A row
 * that isn't on that student's list is named as such, never guessed.
 *
 * Not here, on purpose: the Activities and Honors sheets are the
 * application catalog's (the /application routes, with the sheet's row cap);
 * guardians are the accountability catalog's (in tasks.ts); GPA, class rank,
 * the SAT total, the ACT and rigor are the info card's (students.update_academics),
 * so `academics.update_details` sets only what the card doesn't hold.
 */
import { z } from "zod";
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

/** Card name for a student once the row was found on that student's list; otherwise says it wasn't. */
const whose = (row: Row | null, studentId: string, h: { studentName(id: string): string }) =>
  row ? ` for ${h.studentName(studentId)}` : ` (not found on ${h.studentName(studentId)}'s record; check the id)`;

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
        return `Delete ${c ? quoted(c.name, "a course") : "a course"}${c ? ` from ${h.studentName(i.student_id)}'s record` : whose(c, i.student_id, h)}`;
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
        return `Delete ${scoreName(s)}${s ? ` from ${h.studentName(i.student_id)}'s record` : whose(s, i.student_id, h)}`;
      },
      warning: "The score is removed from the student's record.",
    }),
  ],
};

// ---- Academics (/academics, one row per student) --------------------------------------
// GPA, class rank, the SAT total, the ACT and rigor (rigor_context) are the info
// card's (students.update_academics, PATCH /student-page/:id/info), which writes the
// same row; this op takes only the rest of PUT /academics, so each value has one op.

const TEST_STATUSES = ["not-started", "prepping", "scheduled", "taken", "retaking", "test-optional"] as const;

const academicsInput = z
  .object({
    student_id: uuid,
    test_status: z.enum(TEST_STATUSES).nullable().optional(),
    planned_test_date: z.string().date().nullable().optional(),
    test_prep_status: trimmed(200).nullable().optional(),
    sat_ebrw: z.number().int().min(200).max(800).nullable().optional(),
    sat_math: z.number().int().min(200).max(800).nullable().optional(),
    gpa_scale: trimmed(20).nullable().optional(),
    gpa_band: trimmed(40).nullable().optional(),
    class_rank_value: trimmed(40).nullable().optional(),
    rigor_count: z.number().int().min(0).max(60).nullable().optional(),
    rigor_subjects: z.array(trimmed(60)).max(30).optional(),
    strength_areas: z.array(trimmed(60)).max(30).optional(),
    strength_subjects: z.array(trimmed(60)).max(30).optional(),
  })
  .strict();

const ACADEMIC_LABELS = {
  test_status: "Testing status",
  planned_test_date: "Planned test date",
  test_prep_status: "Test prep",
  sat_ebrw: "SAT EBRW",
  sat_math: "SAT Math",
  gpa_scale: "GPA scale",
  gpa_band: "GPA band",
  class_rank_value: "Class rank value",
  rigor_count: "Rigorous courses",
  rigor_subjects: "Rigor subjects",
  strength_areas: "Strength areas",
  strength_subjects: "Strength subjects",
};

const ARRAY_KEYS = new Set(["rigor_subjects", "strength_areas", "strength_subjects"]);

export const academics: OpGroup = {
  heading: "Academics",
  ops: [
    op({
      name: "academics.update_details",
      kind: "write",
      risk: "auto",
      title: "Set academic details beyond the info card: testing status and plan, SAT section scores, GPA scale, rigor, strengths.",
      doc: "{ student_id; any of (null clears): test_status: not-started|prepping|scheduled|taken|retaking|test-optional, planned_test_date YYYY-MM-DD, test_prep_status ≤200, sat_ebrw, sat_math 200–800, gpa_scale ≤20, gpa_band, class_rank_value, rigor_count 0–60, rigor_subjects[], strength_areas[], strength_subjects[] }",
      input: academicsInput,
      takesStudent: true,
      request: (i) => {
        const { student_id, ...rest } = i;
        return { method: "PUT", url: "/academics", body: { studentId: student_id, ...defined(rest) } };
      },
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s academic details`,
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
          prev[k] = ARRAY_KEYS.has(k) ? (Array.isArray(v) ? v : []) : (v ?? null);
        }
        if (Object.keys(prev).length === 1) return null;
        return academicsInput.safeParse(prev).success ? { op: "academics.update_details", input: prev } : null;
      },
    }),
  ],
};

// ---- Meeting notes (/notes) -----------------------------------------------------------

const noteFields = {
  // Optional in the route's schema; the table refuses an empty title.
  title: trimmed(300).min(1),
  meeting_date: z.string().date(),
  summary: trimmed(4000),
  tags: z.array(trimmed(40)).max(20),
  visibility: z.enum(["private", "shared"]),
};

const noteUpdateInput = z
  .object({
    note_id: uuid,
    student_id: uuid,
    title: noteFields.title.optional(),
    meeting_date: noteFields.meeting_date.optional(),
    summary: noteFields.summary.optional(),
    tags: noteFields.tags.optional(),
    visibility: noteFields.visibility.optional(),
  })
  .strict();

/** The route's body (snake_case, like the table). Never `body`: the note's full text stays off AI. */
const noteBody = (i: Row) => defined({ title: i.title, meeting_date: i.meeting_date, summary: i.summary, tags: i.tags, visibility: i.visibility });

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
      name: "meeting_notes.create",
      kind: "write",
      risk: (i) => (i.visibility === "shared" ? "confirm" : "auto"),
      title: "Log a meeting note for a student: title, date, summary, tags (private unless shared with the student).",
      doc: "{ student_id, title ≤300, meeting_date? YYYY-MM-DD (default today), summary? ≤4000, tags? [≤40 each, ≤20], visibility?: private|shared }",
      input: z
        .object({
          student_id: uuid,
          title: noteFields.title,
          meeting_date: noteFields.meeting_date.optional(),
          summary: noteFields.summary.optional(),
          tags: noteFields.tags.optional(),
          visibility: noteFields.visibility.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/notes", body: { studentId: i.student_id, ...noteBody(i) } }),
      describe: (i, h) =>
        `${i.visibility === "shared" ? "Share" : "Add"} the meeting note "${plainText(i.title, 80)}"${i.meeting_date ? ` (${dayLabel(i.meeting_date)})` : ""} ${i.visibility === "shared" ? "with" : "for"} ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(defined({ summary: i.summary, tags: i.tags, visibility: i.visibility }), NOTE_LABELS),
      warning: "The student can read a shared note.",
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "meeting_notes.delete", input: { note_id: id, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "meeting_notes.update",
      kind: "write",
      risk: (i) => (i.visibility === "shared" ? "confirm" : "auto"),
      title: "Change a meeting note: title, date, summary, tags, or share it with the student.",
      doc: "{ note_id, student_id, title? ≤300, meeting_date? YYYY-MM-DD, summary? ≤4000, tags? [≤40 each, ≤20], visibility?: private|shared }",
      input: noteUpdateInput,
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: `/notes/${seg(i.note_id)}`, body: noteBody(i) }),
      describe: async (i, h) => {
        const n = await findRow(h, notesUrl(i.student_id), i.note_id);
        // Name the student only when the note is theirs: the share goes to whoever the note is about.
        if (i.visibility === "shared") return `Share ${noteName(n)} with ${n ? h.studentName(i.student_id) : "the student it's about"}${n ? "" : whose(n, i.student_id, h)}`;
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
