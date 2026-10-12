/**
 * Students (routes/students.ts, routes/studentPage.ts, routes/pins.ts,
 * routes/preferences.ts). A student's record as the counselor edits it on the
 * student page: the info card, the headline, the counselor's own status read
 * and private note, the strength profile, the preference card sort, and the
 * counselor's pins. Nothing here sends a message, so most edits run at once.
 * Contact details ask first, because messages and reminders follow them; so
 * do removing a student from the roster (archiving) and putting one back
 * (automatic reminders and parent alerts resume), clearing or deleting
 * things, and anything that replaces a note AxIS is never shown (the private
 * note, and the note on the counselor's status read). A parent's contact
 * details are the guardian ops' (accountability.*_guardian), by guardian id.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers, type UndoStep } from "../types.js";
import { asArray, asRecord, changeLines, defined, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = Pick<OpHelpers, "get">;

const studentUrl = (id: string) => `/students/${seg(id)}`;
const infoUrl = (id: string) => `/student-page/${seg(id)}/info`;
const noteUrl = (id: string) => `/student-page/${seg(id)}/note`;
const polygonUrl = (id: string) => `/student-page/${seg(id)}/polygon`;

// ---- The info card (PATCH /student-page/:id/info), in three ops by what is at stake ----

/** The route's `optionalText`: trimmed, capped, nullable ("" is stored as null). */
const optText = (max: number) => z.string().trim().max(max).nullable();

const academicFields = {
  high_school: optText(200),
  grad_year: z.string().trim().regex(/^(20\d\d)?$/, "Use a four-digit year").nullable(),
  gpa_weighted: z.number().min(0).max(110).nullable(),
  gpa_unweighted: z.number().min(0).max(110).nullable(),
  class_rank: optText(80),
  sat: z.number().int().min(400).max(1600).nullable(),
  act: z.number().int().min(1).max(36).nullable(),
  rigor: optText(300),
  intended_majors: z.array(z.string().trim().min(1).max(80)).max(10),
};

const personalFields = {
  gender: z.enum(["female", "male", "non-binary", "undisclosed"]).nullable(),
  birthday: z.string().date().nullable(),
  citizenship: z.enum(["us-citizen", "permanent-resident", "international"]).nullable(),
  first_gen: z.boolean().nullable(),
  living_with_parent: z.boolean().nullable(),
  marital_status: z.enum(["single", "married"]).nullable(),
};

// The info card's parent fields are left out on purpose: they edit "the first
// guardian on file" (and create one when there is none), which is the guardian
// ops' job by guardian id (accountability.add_guardian / update_guardian).
const contactFields = {
  email: z.union([z.string().trim().email().max(320), z.literal("")]).nullable(),
  phone: optText(40),
  address: optText(400),
};

/** Input key -> the info card's key, which the PATCH body and the GET response share. */
const INFO_KEYS: Record<string, string> = {
  high_school: "highSchool",
  grad_year: "gradYear",
  gpa_weighted: "gpaWeighted",
  gpa_unweighted: "gpaUnweighted",
  class_rank: "classRank",
  sat: "sat",
  act: "act",
  rigor: "rigor",
  intended_majors: "intendedMajors",
  gender: "gender",
  birthday: "birthday",
  citizenship: "citizenship",
  first_gen: "firstGen",
  living_with_parent: "livingWithParent",
  marital_status: "maritalStatus",
  email: "email",
  phone: "phone",
  address: "address",
};

const INFO_LABELS: Record<string, string> = {
  high_school: "High school",
  grad_year: "Class of",
  gpa_weighted: "Weighted GPA",
  gpa_unweighted: "Unweighted GPA",
  class_rank: "Class rank",
  sat: "SAT",
  act: "ACT",
  rigor: "Rigor",
  intended_majors: "Intended majors",
  gender: "Gender",
  birthday: "Birthday",
  citizenship: "Citizenship",
  first_gen: "First-gen",
  living_with_parent: "Lives with parent",
  marital_status: "Marital status",
  email: "Contact email",
  phone: "Phone",
  address: "Address",
};

const infoBody = (i: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, dto] of Object.entries(INFO_KEYS)) if (i[k] !== undefined) out[dto] = i[k];
  return out;
};

/** The info card before the write: the old value of exactly the keys the input set. */
function infoUndo(name: string, i: Record<string, unknown>, before: unknown): UndoStep | null {
  const b = asRecord(before);
  if (!b.studentId) return null;
  const prev: Record<string, unknown> = { student_id: i.student_id };
  for (const [k, dto] of Object.entries(INFO_KEYS)) {
    if (!(k in i)) continue;
    // `email` reads back as the login address when no contact address is set; "" puts that back.
    prev[k] = k === "email" ? (b.contactEmailSet === true ? b.email : "") : (b[dto] ?? null);
  }
  if ("intended_majors" in prev && !Array.isArray(prev.intended_majors)) prev.intended_majors = [];
  return Object.keys(prev).length > 1 ? { op: name, input: prev } : null;
}

const infoSnapshot = (i: { student_id: string }, h: Get) => h.get(infoUrl(i.student_id));

/** At least one value to change besides the student: the route answers 400 otherwise. */
const someField = (o: Record<string, unknown>) => Object.keys(o).some((k) => k !== "student_id" && o[k] !== undefined);
const SOME_FIELD = "Give at least one field to change";

// ---- The roster ----

/** The roster's name, or the record's for a student who isn't on it (one archived). Card text only. */
async function nameOf(h: OpHelpers, id: string): Promise<string> {
  const known = h.studentName(id);
  if (known !== "the student") return known;
  const info = await h.get<unknown>(infoUrl(id));
  return plainText(str(asRecord(info).fullName), 80) || known;
}

/** Whether the student is on the active roster (GET /students lists only those), or null when it can't be read. */
async function rosterState(h: Get, id: string): Promise<{ active: boolean } | null> {
  const rows = await h.get<unknown>("/students");
  if (!Array.isArray(rows)) return null;
  return { active: asArray(rows).some((r) => r.id === id) };
}

// ---- Status override and private note ----

const STATUSES = ["on-track", "at-risk", "ahead"] as const;
const STATUS_WORDS: Record<string, string> = { "on-track": "on track", "at-risk": "at risk", ahead: "ahead" };

/** The counselor's status override (null when none), or null when the student can't be read. */
async function statusOf(h: Get, studentId: string): Promise<{ override: Record<string, unknown> | null } | null> {
  const s = await h.get<unknown>(studentUrl(studentId));
  if (!s) return null;
  const cs = asRecord(s).counselorStatus;
  return { override: cs && typeof cs === "object" ? asRecord(cs) : null };
}

function statusUndo(studentId: string, before: unknown): UndoStep | null {
  const b = asRecord(before);
  if (!("override" in b)) return null;
  const o = b.override ? asRecord(b.override) : null;
  return o && typeof o.status === "string"
    ? { op: "students.set_status", input: { student_id: studentId, status: o.status, note: typeof o.note === "string" ? o.note : null } }
    : { op: "students.clear_status", input: { student_id: studentId } };
}

// ---- Strength profile ----

type Axis = { id?: string; label?: string; score?: number | null; manualScore?: number | null; custom?: boolean; hidden?: boolean };

/** Every axis, shown and hidden, or null when the polygon can't be read. */
async function axesOf(h: Get, studentId: string): Promise<Axis[] | null> {
  const p = await h.get<unknown>(polygonUrl(studentId));
  if (!p) return null;
  const b = asRecord(p);
  return [...asArray(b.axes), ...asArray(b.hidden)] as Axis[];
}

const axisLabel = (a: Axis | undefined) => (a?.label ? `"${plainText(a.label, 60)}"` : "an axis");
const sameLabel = (a: unknown, b: string) => String(a ?? "").toLowerCase() === b.toLowerCase();

// ---- Pins ----

async function pinState(h: Get, studentId: string): Promise<{ pinned: boolean } | null> {
  const rows = await h.get<unknown>("/pins");
  if (!Array.isArray(rows)) return null;
  return { pinned: asArray(rows).some((r) => r.studentId === studentId) };
}

// ---- Preference cards ----

const RATINGS = ["love", "good", "okay", "bad", "really-bad"] as const;
const RATING_WORDS: Record<string, string> = { love: "love it", good: "good", okay: "okay", bad: "bad", "really-bad": "really bad" };

async function cardPrompt(h: Get, cardId: string): Promise<string | null> {
  const deck = await h.get<unknown>("/preference-cards");
  const hit = asArray(deck).find((c) => c.id === cardId);
  return hit ? str(hit.prompt) : null;
}

/** The student's current rating of one card (null when unrated), or null when it can't be read. */
async function ratingOf(h: Get, studentId: string, cardId: string): Promise<{ rating: string | null } | null> {
  const r = await h.get<unknown>(`/preference-cards/ratings${qs({ studentId })}`);
  if (!r) return null;
  const hit = asArray(asRecord(r).ratings).find((x) => x.cardId === cardId);
  return { rating: hit ? str(hit.rating) : null };
}

function ratingUndo(studentId: string, cardId: string, before: unknown): UndoStep | null {
  const b = asRecord(before);
  if (!("rating" in b)) return null;
  return typeof b.rating === "string"
    ? { op: "students.rate_card", input: { student_id: studentId, card_id: cardId, rating: b.rating } }
    : { op: "students.clear_card_rating", input: { student_id: studentId, card_id: cardId } };
}

export const students: OpGroup = {
  heading: "Students",
  ops: [
    op({
      name: "students.update",
      kind: "write",
      risk: "auto",
      title: "Change a student's headline or hometown.",
      doc: "{ student_id, headline? ≤300, hometown? ≤200 }",
      input: z
        .object({ student_id: uuid, headline: z.string().trim().max(300).optional(), hometown: z.string().trim().max(200).optional() })
        .strict()
        .refine((o) => o.headline !== undefined || o.hometown !== undefined, "Give headline or hometown"),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: studentUrl(i.student_id), body: defined({ headline: i.headline, hometown: i.hometown }) }),
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s ${[i.headline !== undefined && "headline", i.hometown !== undefined && "hometown"].filter(Boolean).join(" and ")}`,
      details: (i) => changeLines(i, { headline: "Headline", hometown: "Hometown" }),
      snapshot: async (i, h) => {
        const s = await h.get<unknown>(studentUrl(i.student_id));
        return s ? { profile: asRecord(asRecord(s).profile) } : null;
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.profile) return null;
        const p = asRecord(b.profile);
        const prev: Record<string, unknown> = { student_id: i.student_id };
        if (i.headline !== undefined) prev.headline = typeof p.headline === "string" ? p.headline : "";
        if (i.hometown !== undefined) prev.hometown = typeof p.hometown === "string" ? p.hometown : "";
        return { op: "students.update", input: prev };
      },
      // The route answers with the whole profile (login email included): never echo it.
      reply: () => "Saved.",
    }),
    op({
      name: "students.update_academics",
      kind: "write",
      risk: "auto",
      title: "Change a student's high school, class year, GPA, class rank, SAT/ACT, rigor or intended majors.",
      doc: "{ student_id, high_school?|null, grad_year? \"YYYY\"|null, gpa_weighted? 0-110|null, gpa_unweighted?|null, class_rank? ≤80|null, sat? 400-1600|null, act? 1-36|null, rigor? ≤300|null, intended_majors? [≤80] ≤10 (whole list) }",
      input: z.object(academicFields).partial().extend({ student_id: uuid }).strict().refine(someField, SOME_FIELD),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: infoUrl(i.student_id), body: infoBody(i) }),
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s school and academics`,
      details: (i) => changeLines(i, INFO_LABELS),
      snapshot: infoSnapshot,
      undo: (i, _body, before) => infoUndo("students.update_academics", i, before),
      // The route answers with the whole info card (contact details, birthday): never echo it.
      reply: () => "Saved.",
    }),
    op({
      name: "students.update_personal",
      kind: "write",
      risk: "auto",
      title: "Change a student's personal details: gender, birthday, citizenship, first-gen, living with parent, marital status.",
      doc: "{ student_id, gender?: female|male|non-binary|undisclosed, birthday? YYYY-MM-DD, citizenship?: us-citizen|permanent-resident|international, first_gen? bool, living_with_parent? bool, marital_status?: single|married }, each nullable",
      input: z.object(personalFields).partial().extend({ student_id: uuid }).strict().refine(someField, SOME_FIELD),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: infoUrl(i.student_id), body: infoBody(i) }),
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s personal details`,
      details: (i) => changeLines(i, INFO_LABELS),
      snapshot: infoSnapshot,
      undo: (i, _body, before) => infoUndo("students.update_personal", i, before),
      reply: () => "Saved.",
    }),
    op({
      name: "students.update_contact",
      kind: "write",
      risk: "confirm",
      title: "Change where the student is reached: contact email, phone, address. (A parent's details: accountability.update_guardian.)",
      doc: "{ student_id, email? (\"\" or null = their login email), phone? ≤40|null, address? ≤400|null }",
      input: z.object(contactFields).partial().extend({ student_id: uuid }).strict().refine(someField, SOME_FIELD),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: infoUrl(i.student_id), body: infoBody(i) }),
      // The summary reaches the model: it names the student and nothing they can be reached at.
      describe: (i, h) => `Update ${h.studentName(i.student_id)}'s contact details`,
      details: (i) => changeLines(i, INFO_LABELS),
      warning: "Messages and reminders to the student go to these details from now on.",
      snapshot: infoSnapshot,
      undo: (i, _body, before) => infoUndo("students.update_contact", i, before),
    }),
    op({
      name: "students.set_status",
      kind: "write",
      // Always asks: the route replaces the note on the current status (a note
      // left out is cleared), and AxIS is never shown that note, so it can't keep it.
      risk: "confirm",
      title: "Set your own read on a student (on track, at risk, ahead), with an optional private note. Only counselors see it.",
      doc: "{ student_id, status: on-track|at-risk|ahead, note? ≤2000|null } (replaces the note on the current status; leaving it out clears it)",
      input: z.object({ student_id: uuid, status: z.enum(STATUSES), note: z.string().trim().max(2000).nullable().optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: `${studentUrl(i.student_id)}/status`, body: defined({ status: i.status, note: i.note }) }),
      describe: (i, h) => `Mark ${h.studentName(i.student_id)} as ${STATUS_WORDS[i.status]}`,
      details: async (i, h) => {
        const s = await statusOf(h, i.student_id);
        const was = str(s?.override?.status);
        const hadNote = !!str(s?.override?.note);
        return [
          ...(was ? [`Now: ${STATUS_WORDS[was] ?? was}${hadNote ? ", with a note" : ""}`] : []),
          i.note ? `Note: ${plainText(i.note, 600)}` : "Note: none",
          ...(hadNote ? [i.note ? "Your current note is replaced." : "Your current note is cleared."] : []),
        ];
      },
      warning: "Your current status and its note are replaced.",
      snapshot: (i, h) => statusOf(h, i.student_id),
      undo: (i, _body, before) => statusUndo(i.student_id, before),
      reply: () => "Status saved.",
    }),
    op({
      name: "students.set_note",
      kind: "write",
      risk: "confirm",
      title: "Replace your private note on a student with new text (you can't see the current note; it is overwritten).",
      doc: "{ student_id, body ≤4000 }",
      input: z.object({ student_id: uuid, body: z.string().max(4000) }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: noteUrl(i.student_id), body: { body: i.body } }),
      describe: (i, h) => `Replace your private note on ${h.studentName(i.student_id)}`,
      details: async (i, h) => {
        const cur = await h.get<unknown>(noteUrl(i.student_id));
        const had = str(asRecord(cur).body);
        return [`New note: ${plainText(i.body, 1200) || "(empty)"}`, ...(had ? [`Replaces the ${had.length}-character note there now.`] : [])];
      },
      warning: "Everything in the note now is replaced.",
      snapshot: async (i, h) => {
        const cur = await h.get<unknown>(noteUrl(i.student_id));
        if (!cur) return null;
        const body = asRecord(cur).body;
        return { body: typeof body === "string" ? body : "" };
      },
      undo: (i, _body, before) => {
        const b = asRecord(before);
        return typeof b.body === "string" ? { op: "students.set_note", input: { student_id: i.student_id, body: b.body } } : null;
      },
      reply: () => "Note saved.",
    }),
    op({
      name: "students.clear_status",
      kind: "write",
      risk: "confirm",
      title: "Drop your status read on a student (and its note); their status goes back to what their work shows.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `${studentUrl(i.student_id)}/status` }),
      // The summary reaches the model; the status being cleared stays on the card only.
      describe: (i, h) => `Clear your status on ${h.studentName(i.student_id)}`,
      details: async (i, h) => {
        const s = await statusOf(h, i.student_id);
        const was = str(s?.override?.status);
        return was ? [`Now: ${STATUS_WORDS[was] ?? was}${str(s?.override?.note) ? ", with a note" : ""}`] : ["There is no status set now."];
      },
      warning: "Your status and its note are removed.",
      snapshot: (i, h) => statusOf(h, i.student_id),
      undo: (i, _body, before) => {
        const step = statusUndo(i.student_id, before);
        return step?.op === "students.set_status" ? step : null;
      },
    }),
    op({
      name: "students.archive",
      kind: "write",
      risk: "confirm",
      title: "Remove a student from your roster (archives them: nothing is deleted, and students.unarchive restores them).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: studentUrl(i.student_id) }),
      describe: async (i, h) => `Remove ${await nameOf(h, i.student_id)} from your roster`,
      warning:
        "They leave your roster, Overview and AxIS's student list; scheduled messages to them that come due are cancelled, and automatic reminders and parent alerts stop. Their record is kept.",
      // Only a student who was on the roster goes back on it.
      snapshot: (i, h) => rosterState(h, i.student_id),
      undo: (i, _body, before) => (asRecord(before).active === true ? { op: "students.unarchive", input: { student_id: i.student_id } } : null),
      reply: () => "Removed from the roster.",
    }),
    op({
      name: "students.unarchive",
      kind: "write",
      // Back on the roster, the scheduled sweep chases them again: a red flag
      // that came due while they were off it can alert their parents.
      risk: "confirm",
      title: "Put a removed (archived) student back on your roster.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PATCH", url: studentUrl(i.student_id), body: { archived: false } }),
      describe: async (i, h) => `Put ${await nameOf(h, i.student_id)} back on your roster`,
      warning: "Automatic reminders and parent alerts resume for them; an overdue red flag can alert their parents on the next sweep.",
      snapshot: (i, h) => rosterState(h, i.student_id),
      undo: (i, _body, before) => (asRecord(before).active === false ? { op: "students.archive", input: { student_id: i.student_id } } : null),
      reply: () => "Back on the roster.",
    }),
  ],
};

export const strengthProfile: OpGroup = {
  heading: "Strength profile",
  ops: [
    op({
      name: "strength_profile.list",
      kind: "read",
      title: "A student's strength profile axes with ids, scores, and which are hidden.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: polygonUrl(i.student_id) }),
      reply: (body) => {
        const b = asRecord(body);
        const shown = asArray(b.axes);
        const hidden = asArray(b.hidden);
        const line = (a: Record<string, unknown>, isHidden: boolean) =>
          `id ${str(a.id)}: ${untrusted(a.label)} score ${typeof a.score === "number" ? a.score : "none"}${a.isManual ? " (set by hand)" : ""}${a.custom ? ", custom" : ""}${isHidden ? ", hidden" : ""}`;
        const rows = listReply([...shown, ...hidden], (a) => line(a, hidden.includes(a)), "No axes yet.");
        return `${shown.length} of ${typeof b.maxAxes === "number" ? b.maxAxes : 10} axes shown.\n${rows}`;
      },
    }),
    op({
      name: "strength_profile.add_axis",
      kind: "write",
      risk: "auto",
      title: "Add an axis to a student's strength profile (a name it already has gets the score instead).",
      doc: "{ student_id, label ≤60, score? 0-100 }",
      input: z.object({ student_id: uuid, label: z.string().trim().min(1).max(60), score: z.number().min(0).max(100).optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `${polygonUrl(i.student_id)}/axes`, body: defined({ label: i.label, score: i.score }) }),
      describe: (i, h) => `Add "${plainText(i.label, 60)}"${i.score !== undefined ? ` (${i.score})` : ""} to ${h.studentName(i.student_id)}'s strength profile`,
      snapshot: (i, h) => axesOf(h, i.student_id),
      undo: (i, body, before) => {
        if (!Array.isArray(before)) return null;
        const was = (before as Axis[]).find((a) => sameLabel(a.label, i.label));
        if (was?.id) {
          // The route scored (and showed) the axis it already had.
          const prev: Record<string, unknown> = { student_id: i.student_id, axis_id: was.id };
          if (was.hidden) prev.hidden = true;
          if (i.score !== undefined) prev.score = typeof was.manualScore === "number" ? was.manualScore : null;
          return Object.keys(prev).length > 2 ? { op: "strength_profile.update_axis", input: prev } : null;
        }
        const added = asArray(asRecord(body).axes).find((a) => sameLabel(a.label, i.label));
        const id = added ? str(added.id) : null;
        return id ? { op: "strength_profile.remove_axis", input: { student_id: i.student_id, axis_id: id } } : null;
      },
      reply: (body, i) => {
        const b = asRecord(body);
        const hit = [...asArray(b.axes), ...asArray(b.hidden)].find((a) => sameLabel(a.label, i.label));
        return hit ? `Axis saved: id ${str(hit.id)}.` : "Axis saved.";
      },
    }),
    op({
      name: "strength_profile.update_axis",
      kind: "write",
      risk: "auto",
      title: "Rename a strength profile axis, set its score (null = back to the derived score), or hide/show it.",
      doc: "{ student_id, axis_id, label? ≤60, score? 0-100|null, hidden? bool }",
      input: z
        .object({
          student_id: uuid,
          axis_id: uuid,
          label: z.string().trim().min(1).max(60).optional(),
          score: z.number().min(0).max(100).nullable().optional(),
          hidden: z.boolean().optional(),
        })
        .strict()
        .refine((o) => o.label !== undefined || o.score !== undefined || o.hidden !== undefined, "Give label, score or hidden"),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `${polygonUrl(i.student_id)}/axes/${seg(i.axis_id)}`,
        body: defined({ label: i.label, score: i.score, hidden: i.hidden }),
      }),
      describe: async (i, h) => {
        const a = (await axesOf(h, i.student_id))?.find((x) => x.id === i.axis_id);
        return `Change ${axisLabel(a)} on ${h.studentName(i.student_id)}'s strength profile`;
      },
      details: (i) => {
        const lines = changeLines(i, { label: "Name", hidden: "Hidden" });
        if ("score" in i) lines.push(`Score: ${i.score === null ? "back to the derived score" : String(i.score)}`);
        return lines;
      },
      snapshot: (i, h) => axesOf(h, i.student_id),
      undo: (i, _body, before) => {
        if (!Array.isArray(before)) return null;
        const a = (before as Axis[]).find((x) => x.id === i.axis_id);
        if (!a) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, axis_id: i.axis_id };
        if (i.label !== undefined && a.label) prev.label = a.label;
        if ("score" in i) prev.score = typeof a.manualScore === "number" ? a.manualScore : null;
        if (i.hidden !== undefined) prev.hidden = a.hidden === true;
        return Object.keys(prev).length > 2 ? { op: "strength_profile.update_axis", input: prev } : null;
      },
      reply: () => "Axis saved.",
    }),
    op({
      name: "strength_profile.remove_axis",
      kind: "write",
      risk: "confirm",
      title: "Remove an axis from a student's strength profile (a custom axis is deleted; a default one is hidden).",
      doc: "{ student_id, axis_id }",
      input: z.object({ student_id: uuid, axis_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `${polygonUrl(i.student_id)}/axes/${seg(i.axis_id)}` }),
      describe: async (i, h) => {
        const a = (await axesOf(h, i.student_id))?.find((x) => x.id === i.axis_id);
        return `Remove ${axisLabel(a)} from ${h.studentName(i.student_id)}'s strength profile`;
      },
      warning: "A custom axis is deleted; a default one is hidden and its hand-set score cleared. Recorded history stays.",
      snapshot: (i, h) => axesOf(h, i.student_id),
      undo: (i, _body, before) => {
        if (!Array.isArray(before)) return null;
        const a = (before as Axis[]).find((x) => x.id === i.axis_id);
        if (!a?.label) return null;
        if (a.custom) {
          return !a.hidden && typeof a.manualScore === "number"
            ? { op: "strength_profile.add_axis", input: { student_id: i.student_id, label: a.label, score: a.manualScore } }
            : null;
        }
        const prev: Record<string, unknown> = { student_id: i.student_id, axis_id: i.axis_id };
        if (!a.hidden) prev.hidden = false;
        if (typeof a.manualScore === "number") prev.score = a.manualScore;
        return Object.keys(prev).length > 2 ? { op: "strength_profile.update_axis", input: prev } : null;
      },
    }),
    op({
      name: "strength_profile.reset",
      kind: "write",
      risk: "confirm",
      title: "Reset a student's strength profile to the derived shape.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `${polygonUrl(i.student_id)}/reset`, body: {} }),
      describe: (i, h) => `Reset ${h.studentName(i.student_id)}'s strength profile`,
      warning: "Every hand-set score is cleared, hidden axes come back and custom axes are deleted. Recorded history stays.",
    }),
  ],
};

export const pins: OpGroup = {
  heading: "Pinned students",
  ops: [
    op({
      name: "pins.list",
      kind: "read",
      title: "The students you have pinned on Overview.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/pins" }),
      reply: (body) =>
        listReply(asArray(body), (p) => `student_id ${str(p.studentId)}: pinned ${str(p.pinnedAt)?.slice(0, 10) ?? ""}`, "No pinned students."),
    }),
    op({
      name: "pins.pin",
      kind: "write",
      risk: "auto",
      title: "Pin a student on your Overview.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "PUT", url: `/pins/${seg(i.student_id)}`, body: {} }),
      describe: (i, h) => `Pin ${h.studentName(i.student_id)} on Overview`,
      snapshot: (i, h) => pinState(h, i.student_id),
      undo: (i, _body, before) => (asRecord(before).pinned === false ? { op: "pins.unpin", input: { student_id: i.student_id } } : null),
      reply: () => "Pinned.",
    }),
    op({
      name: "pins.unpin",
      kind: "write",
      risk: "auto",
      title: "Unpin a student from your Overview.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/pins/${seg(i.student_id)}` }),
      describe: (i, h) => `Unpin ${h.studentName(i.student_id)} from Overview`,
      snapshot: (i, h) => pinState(h, i.student_id),
      undo: (i, _body, before) => (asRecord(before).pinned === true ? { op: "pins.pin", input: { student_id: i.student_id } } : null),
      reply: () => "Unpinned.",
    }),
  ],
};

export const preferenceCards: OpGroup = {
  heading: "College preference cards",
  ops: [
    op({
      name: "students.preference_cards",
      kind: "read",
      title: "The preference card deck with card ids (the card sort a student rates).",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/preference-cards" }),
      reply: (body) =>
        listReply(
          asArray(body),
          (c) => `id ${str(c.id)}: [${untrusted(str(c.categoryLabel) ?? str(c.category), "catalog")}] ${untrusted(c.prompt, "catalog")}`,
          "The deck is empty.",
          150
        ),
    }),
    op({
      name: "students.rate_card",
      kind: "write",
      risk: "auto",
      title: "Record how a student rates a preference card.",
      doc: "{ student_id, card_id, rating: love|good|okay|bad|really-bad }",
      input: z.object({ student_id: uuid, card_id: uuid, rating: z.enum(RATINGS) }).strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PUT",
        url: `/preference-cards/ratings/${seg(i.card_id)}`,
        body: { studentId: i.student_id, rating: i.rating },
      }),
      describe: async (i, h) => {
        const prompt = await cardPrompt(h, i.card_id);
        return `Rate ${prompt ? `"${plainText(prompt, 80)}"` : "a preference card"} "${RATING_WORDS[i.rating]}" for ${h.studentName(i.student_id)}`;
      },
      snapshot: (i, h) => ratingOf(h, i.student_id, i.card_id),
      undo: (i, _body, before) => ratingUndo(i.student_id, i.card_id, before),
      reply: () => "Rating saved.",
    }),
    op({
      name: "students.clear_card_rating",
      kind: "write",
      // The rating is usually the student's own answer from their card sort: removing it asks.
      risk: "confirm",
      title: "Take a student's rating off a preference card (back to unsorted).",
      doc: "{ student_id, card_id }",
      input: z.object({ student_id: uuid, card_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/preference-cards/ratings/${seg(i.card_id)}${qs({ studentId: i.student_id })}` }),
      describe: async (i, h) => {
        const prompt = await cardPrompt(h, i.card_id);
        return `Clear ${h.studentName(i.student_id)}'s rating of ${prompt ? `"${plainText(prompt, 80)}"` : "a preference card"}`;
      },
      details: async (i, h) => {
        const r = await ratingOf(h, i.student_id, i.card_id);
        return r ? [r.rating ? `Rated now: ${RATING_WORDS[r.rating] ?? r.rating}` : "This card isn't rated now."] : [];
      },
      warning: "The rating is removed; the card goes back to unsorted.",
      snapshot: (i, h) => ratingOf(h, i.student_id, i.card_id),
      undo: (i, _body, before) => {
        const step = ratingUndo(i.student_id, i.card_id, before);
        return step?.op === "students.rate_card" ? step : null;
      },
      reply: () => "Rating cleared.",
    }),
  ],
};
