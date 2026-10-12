/**
 * Admission outcomes and alumni (routes/outcomes.ts), referrals
 * (routes/referrals.ts) and research recommendations (routes/research.ts,
 * the non-AI half). Outcomes are practice data no student or family sees,
 * so recording and correcting one runs at once; deleting asks, and so does
 * Close cycle, which turns every senior into an alum and locks the cycle's
 * rows for good. A referral is the counselor's own record until it is
 * invited: sending the family an intake invitation emails them, so it asks.
 * Naming the referred family on an existing referral asks too: it can't be
 * put back to "asked", and on an invited referral it drops the invitation
 * link. The referred family's email goes to the card, never to the model.
 * A research recommendation's status can't be put back once it is accepted
 * or dismissed (and accepting a college puts it on the list the student
 * sees), so both ask. Running research calls a model and is not here.
 */
import { z } from "zod";
import { HOOKS, RESULTS, ROUNDS } from "../../../outcomes.js";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = Pick<OpHelpers, "get">;

// ---- Admission outcomes and alumni -----------------------------------------------

/** "2026-2027": the route checks the shape; close_admission_cycle also wants consecutive years. */
const cycle = z
  .string()
  .regex(/^\d{4}-\d{4}$/, "A cycle reads like 2026-2027")
  .refine((c) => Number(c.slice(5)) === Number(c.slice(0, 4)) + 1, "A cycle is two consecutive years, like 2026-2027");

const fields = {
  student_id: uuid.nullable(),
  student_name: z.string().trim().min(1).max(200).nullable(),
  high_school_name: z.string().trim().min(1).max(200),
  cycle,
  college_id: uuid.nullable(),
  college_name: z.string().trim().min(1).max(300),
  round: z.enum(ROUNDS),
  result: z.enum(RESULTS),
  enrolled: z.boolean(),
  gpa_unweighted: z.number().min(0).max(10).nullable(),
  gpa_weighted: z.number().min(0).max(10).nullable(),
  sat: z.number().int().min(400).max(1600).nullable(),
  act: z.number().int().min(1).max(36).nullable(),
  hooks: z.array(z.enum(HOOKS)).max(5),
  intended_major: z.string().trim().max(200).nullable(),
};

const OUTCOME_LABELS = {
  student_name: "Student name",
  high_school_name: "High school",
  cycle: "Cycle",
  college_name: "College",
  round: "Round",
  result: "Result",
  enrolled: "Enrolled",
  gpa_unweighted: "Unweighted GPA",
  gpa_weighted: "Weighted GPA",
  sat: "SAT",
  act: "ACT",
  hooks: "Hooks",
  intended_major: "Intended major",
};

/** Snake-case input key -> the DTO's camelCase key (the route's body uses the same names). */
const OUTCOME_DTO: Record<string, string> = {
  student_id: "studentId",
  student_name: "studentName",
  high_school_name: "highSchoolName",
  cycle: "cycle",
  college_id: "collegeId",
  college_name: "collegeName",
  round: "round",
  result: "result",
  enrolled: "enrolled",
  gpa_unweighted: "gpaUnweighted",
  gpa_weighted: "gpaWeighted",
  sat: "sat",
  act: "act",
  hooks: "hooks",
  intended_major: "intendedMajor",
};

const outcomeBody = (i: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, dto] of Object.entries(OUTCOME_DTO)) if (i[k] !== undefined) out[dto] = i[k];
  return out;
};

type Outcome = { id?: string; studentId?: string | null; studentName?: string | null; collegeName?: string; cycle?: string; round?: string; result?: string; locked?: boolean };

const findOutcome = async (h: Get, id: string): Promise<Outcome | null> => {
  const hit = asArray(await h.get<unknown[]>("/outcomes")).find((r) => r.id === id);
  return hit ? (hit as Outcome) : null;
};

const whoOf = (o: { studentId?: string | null; studentName?: string | null }, h: OpHelpers) =>
  o.studentId ? h.studentName(o.studentId) : o.studentName ? plainText(o.studentName, 80) : "a student";
const outcomeLabel = (o: Outcome | null, h: OpHelpers) =>
  o ? `${whoOf(o, h)}'s result at ${plainText(o.collegeName, 80)} (${plainText(o.result, 20)}, ${plainText(o.round, 10)}, ${plainText(o.cycle, 12)})` : "an admission outcome";

function outcomeIdLines(i: { student_id?: string | null; college_id?: string | null }, h: OpHelpers): string[] {
  const out: string[] = [];
  if ("student_id" in i) out.push(`Student: ${i.student_id ? h.studentName(i.student_id) : "not on the roster"}`);
  if ("college_id" in i) out.push(`Catalog college: ${i.college_id ? "linked" : "not linked"}`);
  return out;
}

type Alum = { studentId?: string; name?: string | null; institution?: { collegeId?: string | null; name?: string } | null; program?: string | null };

export const outcomes: OpGroup = {
  heading: "Admission outcomes & alumni",
  ops: [
    op({
      name: "outcomes.list",
      kind: "read",
      title: "Admission outcomes on file with ids (optionally one student's or one cycle's).",
      doc: "{ student_id?, cycle? YYYY-YYYY }",
      input: z.object({ student_id: uuid.optional(), cycle: cycle.optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/outcomes${qs({ studentId: i.student_id, cycle: i.cycle })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (o) =>
            `id ${str(o.id)}: ${str(o.cycle)} ${untrusted(o.collegeName)} [${str(o.round)}, ${str(o.result)}${o.enrolled ? ", enrolled" : ""}${o.locked ? ", locked" : ""}]${o.studentName ? ` · ${untrusted(o.studentName, "roster")}` : ""}${o.studentId ? ` (student ${str(o.studentId)})` : ""}`,
          "No admission outcomes on file."
        ),
    }),
    op({
      name: "outcomes.cycles",
      kind: "read",
      title: "The current admission cycle, whether it is closed, and how many seniors closing it would make alumni.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/outcomes/cycles" }),
      reply: (body) => {
        const b = asRecord(body);
        const closed = asArray(b.closed).map((c) => `${str(c.cycle)} (${str(c.alumniCount) ?? "0"} alumni)`);
        return `Current cycle ${str(b.current)} (class of ${str(b.classOf)}): ${b.currentClosed ? "closed" : "open"}, ${str(b.seniors) ?? "0"} seniors not yet alumni. Closed cycles: ${closed.length ? closed.join(", ") : "none"}.`;
      },
    }),
    op({
      name: "alumni.list",
      kind: "read",
      title: "The counselor's alumni with ids (each id is the alum's student id) and where they enrolled.",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/alumni" }),
      reply: (body) =>
        listReply(
          asArray(body),
          (a) => {
            const inst = asRecord(a.institution);
            return `id ${str(a.studentId)}: ${untrusted(a.name, "roster")}${a.gradYear ? ` · class of ${str(a.gradYear)}` : ""} · cycle ${str(a.cycle)} · ${inst.name ? `enrolled at ${untrusted(inst.name)}` : "undecided"}${a.program ? ` · program ${untrusted(a.program)}` : ""}`;
          },
          "No alumni yet."
        ),
    }),
    op({
      name: "outcomes.create",
      kind: "write",
      risk: "auto",
      title: "Record an admission result. With student_id, name, school, GPA and scores fill from the record.",
      doc: "{ college_name, result: admitted|denied|waitlisted|deferred|withdrawn, student_id?, round?: ED|ED2|EA|REA|SCEA|RD|rolling|priority, cycle? YYYY-YYYY, enrolled?, college_id?, student_name?, high_school_name?, intended_major?, hooks?, gpa_unweighted?, gpa_weighted?, sat?, act? }",
      input: z
        .object({
          student_id: fields.student_id.optional(),
          student_name: fields.student_name.optional(),
          high_school_name: fields.high_school_name.optional(),
          cycle: fields.cycle.optional(),
          college_id: fields.college_id.optional(),
          college_name: fields.college_name,
          round: fields.round.optional(),
          result: fields.result,
          enrolled: fields.enrolled.optional(),
          gpa_unweighted: fields.gpa_unweighted.optional(),
          gpa_weighted: fields.gpa_weighted.optional(),
          sat: fields.sat.optional(),
          act: fields.act.optional(),
          hooks: fields.hooks.optional(),
          intended_major: fields.intended_major.optional(),
        })
        .strict()
        .refine((x) => !x.enrolled || x.result === "admitted", { path: ["enrolled"], message: "Only an admission can be marked enrolled" }),
      request: (i) => ({ method: "POST", url: "/outcomes", body: outcomeBody(i) }),
      describe: (i, h) =>
        `Record ${whoOf({ studentId: i.student_id, studentName: i.student_name }, h)}: ${i.result}${i.enrolled ? " and enrolled" : ""} at ${plainText(i.college_name, 80)} (${i.round ?? "RD"}${i.cycle ? `, ${i.cycle}` : ""})`,
      details: (i) => changeLines(i, { high_school_name: "High school", intended_major: "Intended major", gpa_unweighted: "Unweighted GPA", gpa_weighted: "Weighted GPA", sat: "SAT", act: "ACT", hooks: "Hooks" }),
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "outcomes.delete", input: { outcome_id: id } } : null;
      },
    }),
    op({
      name: "outcomes.update",
      kind: "write",
      risk: "auto",
      title: "Correct an admission outcome (a closed cycle's rows are locked).",
      doc: "{ outcome_id, then any outcomes.create field to change; null clears student_id, student_name, college_id, gpa_*, sat, act, intended_major }",
      input: z
        .object({
          outcome_id: uuid,
          student_id: fields.student_id.optional(),
          student_name: fields.student_name.optional(),
          high_school_name: fields.high_school_name.optional(),
          cycle: fields.cycle.optional(),
          college_id: fields.college_id.optional(),
          college_name: fields.college_name.optional(),
          round: fields.round.optional(),
          result: fields.result.optional(),
          enrolled: fields.enrolled.optional(),
          gpa_unweighted: fields.gpa_unweighted.optional(),
          gpa_weighted: fields.gpa_weighted.optional(),
          sat: fields.sat.optional(),
          act: fields.act.optional(),
          hooks: fields.hooks.optional(),
          intended_major: fields.intended_major.optional(),
        })
        .strict()
        .refine((x) => Object.keys(outcomeBody(x)).length > 0, "Give at least one field to change")
        .refine((x) => !(x.enrolled && x.result !== undefined && x.result !== "admitted"), { path: ["enrolled"], message: "Only an admission can be marked enrolled" }),
      request: (i) => ({ method: "PATCH", url: `/outcomes/${seg(i.outcome_id)}`, body: outcomeBody(i) }),
      describe: async (i, h) => `Update ${outcomeLabel(await findOutcome(h, i.outcome_id), h)}`,
      details: (i, h) => [...outcomeIdLines(i, h), ...changeLines(i, OUTCOME_LABELS)],
      snapshot: (i, h) => findOutcome(h, i.outcome_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { outcome_id: i.outcome_id };
        for (const [k, dto] of Object.entries(OUTCOME_DTO)) if (k in i) prev[k] = b[dto] ?? null;
        for (const k of ["high_school_name", "cycle", "college_name", "round", "result"]) if (k in prev && !prev[k]) return null;
        if ("enrolled" in prev) prev.enrolled = prev.enrolled === true;
        if ("hooks" in prev && !Array.isArray(prev.hooks)) prev.hooks = [];
        return { op: "outcomes.update", input: prev };
      },
    }),
    op({
      name: "outcomes.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete an admission outcome (a closed cycle's rows are locked).",
      doc: "{ outcome_id }",
      input: z.object({ outcome_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/outcomes/${seg(i.outcome_id)}` }),
      describe: async (i, h) => `Delete ${outcomeLabel(await findOutcome(h, i.outcome_id), h)}`,
      warning: "The result is removed from the practice's outcome history.",
    }),
    op({
      name: "outcomes.close_cycle",
      kind: "write",
      risk: "confirm",
      title: "Close an admission cycle: record the seniors' decisions, lock the cycle and make the seniors alumni. Only when asked.",
      doc: "{ cycle YYYY-YYYY (use the current one from outcomes.cycles unless the counselor names another) }",
      input: z.object({ cycle }).strict(),
      request: (i) => ({ method: "POST", url: "/outcomes/close-cycle", body: { cycle: i.cycle } }),
      describe: async (i, h) => {
        const c = asRecord(await h.get("/outcomes/cycles"));
        const classOf = i.cycle.slice(5);
        if (str(c.current) && c.current !== i.cycle) {
          // Not the cycle the app offers to close: say so, because it turns a whole other class into alumni.
          return `Close the ${i.cycle} cycle, NOT the current ${str(c.current)} one: every student in the class of ${classOf} on your roster becomes an alum`;
        }
        const n = typeof c.seniors === "number" ? c.seniors : null;
        const who = n === null ? `every senior in the class of ${classOf} becomes an alum` : `${n} senior${n === 1 ? "" : "s"} in the class of ${classOf} become${n === 1 ? "s an alum" : " alumni"}`;
        return `Close the ${i.cycle} cycle: ${who}`;
      },
      details: (i) => [
        `Takes every student on your roster in the class of ${i.cycle.slice(5)} who isn't an alum yet`,
        "Records every decision on their college lists as an admission outcome",
        "Locks your outcomes for the cycle so they can't be edited or deleted",
        "Moves each of them to Alumni, with where they enrolled",
      ],
      warning: "This changes a whole class at once, and a closed cycle can't be reopened or its outcomes edited.",
    }),
    op({
      name: "alumni.update",
      kind: "write",
      risk: "auto",
      title: "Correct where an alum enrolled, or their program.",
      doc: "{ student_id, institution_name? ≤300|null (null = undecided), college_id?|null, program? ≤200|null }",
      input: z
        .object({
          student_id: uuid,
          college_id: uuid.nullable().optional(),
          institution_name: z.string().trim().min(1).max(300).nullable().optional(),
          program: z.string().trim().max(200).nullable().optional(),
        })
        .strict()
        .refine((x) => x.college_id !== undefined || x.institution_name !== undefined || x.program !== undefined, "Give at least one field to change"),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/alumni/${seg(i.student_id)}`,
        body: defined({ collegeId: i.college_id, institutionName: i.institution_name, program: i.program }),
      }),
      describe: (i, h) => `Update where ${h.studentName(i.student_id)} enrolled`,
      details: (i) => [
        ...changeLines(i, { institution_name: "Enrolled at", program: "Program" }),
        ...("college_id" in i ? [`Catalog college: ${i.college_id ? "linked" : "not linked"}`] : []),
      ],
      snapshot: (i, h) => h.get<Alum>(`/alumni/${seg(i.student_id)}`),
      undo: (i, _body, before) => {
        const b = asRecord(before) as Alum;
        if (!b.studentId) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id };
        if ("college_id" in i) prev.college_id = b.institution?.collegeId ?? null;
        if ("institution_name" in i) prev.institution_name = b.institution?.name ?? null;
        if ("program" in i) prev.program = b.program ?? null;
        return { op: "alumni.update", input: prev };
      },
    }),
  ],
};

// ---- Referrals ------------------------------------------------------------------

type Referral = { id?: string; fromStudentId?: string; referrerLabel?: string; familyName?: string | null; contactEmail?: string | null; status?: string };

const findReferral = async (h: Get, id: string): Promise<Referral | null> => {
  const hit = asArray(await h.get<unknown[]>("/referrals")).find((r) => r.id === id);
  return hit ? (hit as Referral) : null;
};
/**
 * The referred family, as routes/referrals.ts cleans it: the surname without a trailing
 * "family", and an email it would accept. Checked here so a bad one is named before the
 * card is filed.
 */
const familyName = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v.replace(/\s+family$/i, "").trim().length > 0, "Give the family's surname");
const familyEmail = z.string().trim().max(320).email("Give a valid email address");

const familyOf = (r: Referral | null) => (r?.familyName ? `the ${plainText(r.familyName, 60)} family` : "the referred family");
const referrerOf = (r: Referral | null) => (r?.referrerLabel ? `the ${plainText(r.referrerLabel, 60)}` : "a family");

export const referrals: OpGroup = {
  heading: "Referrals",
  ops: [
    op({
      name: "referrals.list",
      kind: "read",
      title: "Referrals with ids: who referred whom and where each stands (asked, introduced, invited, signed).",
      doc: "{ student_id? (the referring family's student) }",
      input: z.object({ student_id: uuid.optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/referrals${qs({ studentId: i.student_id })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          // The referred family's email is never shown here: only whether there is one.
          (r) =>
            `id ${str(r.id)}: [${str(r.status)}] from ${untrusted(r.referrerLabel, "roster")} (student ${str(r.fromStudentId)})${r.familyName ? ` → ${untrusted(r.familyName)} family` : " → nobody named yet"}${r.contactEmail ? " (email on file)" : ""}`,
          "No referrals."
        ),
    }),
    op({
      name: "referrals.ask",
      kind: "write",
      risk: "auto",
      title: "Record that a student's family was asked for a referral; with family_name and contact_email, a new referral of who they named.",
      doc: "{ student_id, family_name? ≤200, contact_email? (give both or neither), ask_message_id? (from messages.list) }",
      input: z
        .object({
          student_id: uuid,
          family_name: familyName.optional(),
          contact_email: familyEmail.optional(),
          ask_message_id: uuid.optional(),
        })
        .strict()
        .refine((x) => (x.family_name === undefined) === (x.contact_email === undefined), "Give family_name and contact_email together, or neither"),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/referrals",
        body: defined({ studentId: i.student_id, familyName: i.family_name, contactEmail: i.contact_email, askMessageId: i.ask_message_id }),
      }),
      describe: (i, h) =>
        i.family_name
          ? `Record that ${h.studentName(i.student_id)}'s family referred the ${plainText(i.family_name.replace(/\s+family$/i, ""), 60)} family`
          : `Record that ${h.studentName(i.student_id)}'s family was asked for a referral`,
      details: (i) => (i.contact_email ? [`Email: ${plainText(i.contact_email, 320)}`] : []),
      reply: (body) => (idOf(body) ? `Referral id ${idOf(body)}.` : ""),
      // A second plain ask refreshes the open one instead of adding a row: undo only removes a row this ask created.
      snapshot: async (i, h) => asArray(await h.get<unknown[]>(`/referrals${qs({ studentId: i.student_id })}`)).map((r) => str(r.id)),
      undo: (_i, body, before) => {
        const id = idOf(body);
        if (!id || !Array.isArray(before) || before.includes(id)) return null;
        return { op: "referrals.delete", input: { referral_id: id } };
      },
    }),
    op({
      name: "referrals.introduce",
      kind: "write",
      // An asked referral can't go back to "asked", and an invited one loses its invitation link.
      risk: "confirm",
      title: "On an existing referral (from referrals.list), record who the family named: surname and email.",
      doc: "{ referral_id, family_name ≤200, contact_email }",
      input: z.object({ referral_id: uuid, family_name: familyName, contact_email: familyEmail }).strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/referrals/${seg(i.referral_id)}`,
        body: { familyName: i.family_name, contactEmail: i.contact_email },
      }),
      describe: async (i, h) => {
        const r = await findReferral(h, i.referral_id);
        const invited = r?.status === "invited" || r?.status === "signed";
        const was = r?.familyName ? ` (was ${familyOf(r)}${invited ? `, already ${r.status}` : ""})` : "";
        return `Record the ${plainText(i.family_name.replace(/\s+family$/i, ""), 60)} family as referred by ${referrerOf(r)}${was}`;
      },
      details: (i) => [`Email: ${plainText(i.contact_email, 320)}`],
      warning: "The referral can't go back to asked; if the family was already invited, it is detached from that invitation.",
      snapshot: (i, h) => findReferral(h, i.referral_id),
      // Only an introduced referral goes back exactly: this clears an invitation link and can't restore an ask.
      undo: (i, _body, before) => {
        const b = asRecord(before) as Referral;
        if (b.status !== "introduced" || !b.familyName || !b.contactEmail) return null;
        return { op: "referrals.introduce", input: { referral_id: i.referral_id, family_name: b.familyName, contact_email: b.contactEmail } };
      },
    }),
    op({
      name: "referrals.invite",
      kind: "write",
      risk: "confirm",
      title: "Email the referred family an intake invitation.",
      doc: "{ referral_id }",
      input: z.object({ referral_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/referrals/${seg(i.referral_id)}/invite` }),
      describe: async (i, h) => {
        const r = await findReferral(h, i.referral_id);
        return `Send ${familyOf(r)} an intake invitation (referred by ${referrerOf(r)})`;
      },
      details: async (i, h) => {
        const r = await findReferral(h, i.referral_id);
        return r?.contactEmail ? [`To: ${plainText(r.contactEmail, 320)}`] : [];
      },
      warning: "An invitation email goes to the family now (unless they already have one from you).",
    }),
    op({
      name: "referrals.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a referral.",
      doc: "{ referral_id }",
      input: z.object({ referral_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/referrals/${seg(i.referral_id)}` }),
      describe: async (i, h) => {
        const r = await findReferral(h, i.referral_id);
        return r?.familyName ? `Delete the referral of ${familyOf(r)} (from ${referrerOf(r)})` : `Delete the referral ask to ${referrerOf(r)}`;
      },
      warning: "The referral record is deleted; an invitation already sent stays.",
    }),
  ],
};

// ---- Research recommendations -------------------------------------------------------

type Rec = { id?: string; feature?: string; title?: string; status?: string };

const findRec = async (h: Get, studentId: string, id: string): Promise<Rec | null> => {
  const hit = asArray(await h.get<unknown[]>(`/students/${seg(studentId)}/recommendations`)).find((r) => r.id === id);
  return hit ? (hit as Rec) : null;
};

/** The card names the suggestion only when it is found under that student; otherwise it says so rather than guess. */
const recLabel = (r: Rec | null, id: string, student: string) =>
  r ? `"${plainText(r.title, 80)}" for ${student}` : `research suggestion ${id} (not among ${student}'s; check the ids)`;

const recInput = z.object({ recommendation_id: uuid, student_id: uuid }).strict();

export const recommendations: OpGroup = {
  heading: "Research recommendations",
  ops: [
    op({
      name: "recommendations.list",
      kind: "read",
      title: "A student's research suggestions (colleges or activities, from Research) with ids and status.",
      doc: "{ student_id, feature?: college_list|activities }",
      input: z.object({ student_id: uuid, feature: z.enum(["college_list", "activities"]).optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/students/${seg(i.student_id)}/recommendations${qs({ feature: i.feature })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (r) => `id ${str(r.id)}: [${str(r.feature)}, ${str(r.status)}] ${untrusted(r.title, "research")}${r.why ? ` · why: ${untrusted(r.why, "research")}` : ""}`,
          "No recommendations for this student."
        ),
    }),
    op({
      name: "recommendations.accept",
      kind: "write",
      // The suggestion can't be put back once accepted, and a college lands on the list the student sees.
      risk: "confirm",
      title: "Accept a research suggestion: a college goes on the student's college list; an activity becomes a task only you see.",
      doc: "{ recommendation_id (from recommendations.list), student_id }",
      input: recInput,
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/recommendations/${seg(i.recommendation_id)}/accept` }),
      describe: async (i, h) => {
        const r = await findRec(h, i.student_id, i.recommendation_id);
        const into = r?.feature === "college_list" ? ": add it to their college list" : r?.feature === "activities" ? ": add it as a task only you see" : "";
        return `Accept ${recLabel(r, i.recommendation_id, h.studentName(i.student_id))}${into}`;
      },
      warning: "Accepted suggestions can't be put back; a college shows on the student's college list.",
      reply: (body) => {
        const a = asRecord(asRecord(body).acceptedAs);
        return a.type === "student_college"
          ? `Accepted: added to the college list (student_college_id ${str(a.id) ?? "unknown"}).`
          : `Accepted: added as a task hidden from the student (task id ${str(a.id) ?? "unknown"}).`;
      },
    }),
    op({
      name: "recommendations.dismiss",
      kind: "write",
      // A dismissed suggestion can't be brought back, and research runs are capped per practice.
      risk: "confirm",
      title: "Dismiss a research suggestion.",
      doc: "{ recommendation_id (from recommendations.list), student_id }",
      input: recInput,
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/recommendations/${seg(i.recommendation_id)}/dismiss` }),
      describe: async (i, h) => `Dismiss ${recLabel(await findRec(h, i.student_id, i.recommendation_id), i.recommendation_id, h.studentName(i.student_id))}`,
      warning: "A dismissed suggestion can't be brought back.",
    }),
  ],
};
