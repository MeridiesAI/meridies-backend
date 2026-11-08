// The activity-draft conversations on the real model (AxIS activity drafts, spec 4.10). Each seeds a made-up
// counselor and student ("Avery Lee"; "Jordan Park" for the switch case), drives real turns and clicks, and checks:
//
//   hard (gated):  the Activities rows at the end, field by field, as an exact set per student; the cards (op,
//                  status, reason); the draft; fixed lines the replies must carry; and never raw validation text.
//   scored:        questions AxIS asked and counselor messages until the card, stored over time, never gated.
//
// rule "2of3": a case passes on its first run, or on two of three (marked flaky).
import { readFileSync } from "node:fs";
import { call, sql, user } from "../../test/integration/harness.mjs";
import { studentOf } from "../../test/integration/imports-helpers.mjs";

const q = (s) => s.replace(/'/g, "''");
const one = (query) => sql(query).then((o) => o.split("\n")[0] ?? "");
const json = (query) => sql(query).then((o) => JSON.parse(o || "null"));
const key = (s) => String(s ?? "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const RAW = ["Invalid input", "Expected ", "ZodError", "too_big", "invalid_enum", "invalid_type"];
const REMINDER = "You still have an activity draft for Avery Lee. Continue or cancel?";
const FIXED_LINES = /^(Waiting for your Confirm|Saved:|Couldn't save|Still need|You still have|Your activity draft|Okay, I dropped|I couldn't keep|Send what's missing)/;

// ---- Seeding ----

async function seed(tag, o = {}) {
  const c = await user(`evald-${tag}`);
  const s = await studentOf(c, `evald-${tag}-a`);
  await sql(`update public.profiles set full_name = 'Avery Lee' where id = '${s.id}'`);
  const ctx = { c, s, students: { avery: s.id } };
  if (o.jordan) {
    const j = await studentOf(c, `evald-${tag}-j`);
    await sql(`update public.profiles set full_name = 'Jordan Park' where id = '${j.id}'`);
    ctx.students.jordan = j.id;
  }
  if (o.gpa) await sql(`insert into public.student_academics (student_id, gpa_unweighted, sat_superscore) values ('${s.id}', 3.82, 1450)`);
  if (o.resume) {
    const text = readFileSync(new URL("./fixtures/resume-activities.txt", import.meta.url), "utf8");
    await sql(`insert into public.documents (owner_id, student_id, filename, title, bucket, storage_path, mime_type, size_bytes, uploaded_by, kind, kind_confirmed, available_to_llm, ai_access, parsed_data)
               values ('${c.id}', '${s.id}', 'Resume.pdf', 'Resume.pdf', 'student-documents', '${s.id}/evald-${Date.now()}-resume.pdf', 'application/pdf', ${text.length},
                       '${s.id}', 'resume', true, true, 'default', '${q(JSON.stringify({ text }))}'::jsonb)`);
  }
  const conv = await call(c.token, "POST", "/chat/conversations", { studentId: s.id, tool: "axis" });
  if (conv.status !== 201 && conv.status !== 200) throw new Error(`conversation ${conv.status} ${JSON.stringify(conv.body)}`);
  ctx.conversationId = conv.body.id;
  return ctx;
}

// ---- Reading what happened ----

const activities = (studentId) =>
  json(`select coalesce(json_agg(json_build_object('organization', organization, 'position', position, 'grade_levels', grade_levels, 'timing', timing,
          'hours_per_week', hours_per_week, 'weeks_per_year', weeks_per_year, 'description', description) order by created_at), '[]') from public.activities where student_id = '${studentId}'`);
const cards = (ctx) =>
  json(`select coalesce(json_agg(json_build_object('op', payload ->> 'op', 'status', status, 'reason', payload ->> 'reason', 'input', payload -> 'input') order by created_at), '[]')
        from public.axis_actions where conversation_id = '${ctx.conversationId}' and type = 'operation'`);
const draft = (ctx) => json(`select json_build_object('header', state -> 'draft', 'rows', coalesce(draft_rows, '[]'::jsonb)) from public.ai_conversations where id = '${ctx.conversationId}'`);

/** One expected Activities row against one saved row: free text by its words, the rest exactly. */
function rowMatches(want, got) {
  for (const [k, v] of Object.entries(want)) {
    if (k === "organization" || k === "position") {
      if (key(got[k]) !== key(v)) return false;
    } else if (k === "description") {
      if ((got[k] ?? null) !== v) return false;
    } else if (JSON.stringify(got[k] ?? null) !== JSON.stringify(v)) return false;
  }
  return true;
}

/**
 * The hard checks: `activities` per student as an exact set (each expected row matched once, nothing extra),
 * `cards` as the exact list of ops and statuses (and reason where given), `draft` "open"/"closed", and the misses
 * the steps recorded (replyIncludes / replyNever). Every reply is checked for raw validation text.
 */
async function hard(ctx, expect) {
  const why = [...(ctx.misses ?? [])];
  for (const r of ctx.replies ?? []) for (const raw of RAW) if (r.includes(raw)) why.push(`raw error text "${raw}" in a reply`);
  for (const [who, want] of Object.entries(expect.activities ?? {})) {
    const got = await activities(ctx.students[who]);
    const left = [...got];
    for (const w of want) {
      const i = left.findIndex((g) => rowMatches(w, g));
      if (i < 0) why.push(`${who}: no row like ${JSON.stringify(w)} (have ${JSON.stringify(got.map((g) => g.organization))})`);
      else left.splice(i, 1);
    }
    if (left.length) why.push(`${who}: extra rows ${JSON.stringify(left.map((g) => g.organization))}`);
  }
  if (expect.cards) {
    const got = await cards(ctx);
    const shape = (c) => `${c.op}:${c.status}${c.reason !== undefined ? `:${c.reason}` : ""}`;
    const want = expect.cards.map(shape);
    const have = got.map((c, i) => shape({ ...c, reason: expect.cards[i]?.reason !== undefined ? c.reason : undefined }));
    if (JSON.stringify(want) !== JSON.stringify(have)) why.push(`cards ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
  }
  if (expect.draft) {
    const d = await draft(ctx);
    const open = d.header !== null && d.rows.some((r) => r.status === "collecting" || r.status === "card");
    if ((expect.draft === "open") !== open) why.push(`draft is ${open ? "open" : "closed"}, want ${expect.draft}`);
    if (expect.draftCheck) {
      const bad = expect.draftCheck(d);
      if (bad) why.push(bad);
    }
  }
  return why;
}

/** Questions AxIS asked (sentences ending "?" outside the fixed lines) and counselor messages until the first card. */
async function scored(ctx) {
  const questions = (ctx.replies ?? []).flatMap((r) => r.split("\n").filter((l) => !FIXED_LINES.test(l.trim()))).join(" ").match(/[^.?!]+\?/g) ?? [];
  const firstCard = await one(`select count(*) from public.ai_messages where conversation_id = '${ctx.conversationId}' and role = 'user'
                               and created_at <= (select min(created_at) from public.axis_actions where conversation_id = '${ctx.conversationId}')`);
  return { questionsAsked: questions.length, counselorMessages: Number(firstCard) || (ctx.says ?? 0) };
}

/** A case: `steps` to run, `expect` for the hard checks, the targets the scored values are read against. */
const draftCase = (id, title, o) => ({
  id,
  title,
  suite: "activity-drafts",
  rule: "2of3",
  seed: (tag) => seed(tag, o.seed ?? {}),
  steps: o.steps,
  async check(ctx) {
    const why = await hard(ctx, o.expect);
    const s = await scored(ctx);
    return { gated: why.length === 0, resisted: null, scored: s, note: why.slice(0, 3).join("; ") || (o.targets ? `targets ${JSON.stringify(o.targets)}` : "") };
  },
});

// ---- The conversations (spec 4.10) ----

const ONE = "Add Code Club for Avery: cofounder, grade 11, summer, 6 hours a week, 2 weeks a year";
const CODE_CLUB = { organization: "Code Club", grade_levels: ["11"], timing: ["break"], hours_per_week: 6, weeks_per_year: 2 };
const SAVED = (n = 1) => ({ say: "thanks", replyIncludes: [`Saved: ${n === 1 ? "Code Club" : ""}`.trim()] });
const ADD_DONE = { op: "application.add_activities", status: "confirmed" };

export const DRAFT_CASES = [
  draftCase("drafts-01-one-message", "Everything in one message", {
    steps: [{ say: ONE, replyIncludes: ["Waiting for your Confirm: add Code Club to Avery Lee's Activities sheet."] }, { confirm: "last" }, SAVED()],
    expect: { activities: { avery: [{ ...CODE_CLUB, position: "cofounder" }] }, cards: [{ ...ADD_DONE, reason: null }], draft: "closed" },
    targets: { questionsAsked: 0, counselorMessages: 1 },
  }),
  draftCase("drafts-02-details-without-a-verb", "An add, AxIS asks, details with no verb", {
    steps: [{ say: "Add an activity for Avery" }, { say: "Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr" }, { confirm: "last" }, SAVED()],
    expect: { activities: { avery: [{ ...CODE_CLUB, position: "Cofounder/Teacher" }] }, cards: [ADD_DONE], draft: "closed" },
    targets: { counselorMessages: 2 },
  }),
  draftCase("drafts-03-sophomore", "\"sophomore\"", {
    steps: [{ say: "Add Code Club for Avery: cofounder, sophomore year, summer, 6 hours a week, 2 weeks a year" }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Code Club", grade_levels: ["10"] }] }, cards: [ADD_DONE] },
  }),
  draftCase("drafts-04-grade-range", "\"grades 10–12\"", {
    steps: [{ say: "Add Code Club for Avery: cofounder, grades 10–12, summer, 6 hours a week, 2 weeks a year" }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Code Club", grade_levels: ["10", "11", "12"] }] }, cards: [ADD_DONE] },
  }),
  draftCase("drafts-05-description-typed", "A description in the message", {
    steps: [{ say: `${ONE}. Description: Taught 20 middle schoolers to code in Scratch every Saturday.` }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Code Club", description: "Taught 20 middle schoolers to code in Scratch every Saturday." }] }, cards: [ADD_DONE] },
  }),
  draftCase("drafts-06-write-a-description", "\"write a description for it\" after the card", {
    steps: [{ say: ONE }, { say: "write a description for it", replyIncludes: [REMINDER] }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Code Club", description: null }] }, cards: [ADD_DONE] },
  }),
  draftCase("drafts-07-correction-before-confirm", "\"actually 8 hours\" before Confirm", {
    steps: [{ say: ONE }, { say: "actually 8 hours a week" }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Code Club", hours_per_week: 8 }] }, cards: [{ op: "application.add_activities", status: "dismissed" }, ADD_DONE] },
  }),
  draftCase("drafts-08-rename-after-saving", "Rename after saving", {
    steps: [{ say: ONE }, { confirm: "last" }, { say: "rename Code Club to Coding Club" }, { confirm: "last" }],
    expect: { activities: { avery: [{ organization: "Coding Club", hours_per_week: 6 }] }, cards: [ADD_DONE, { op: "application.update_activity", status: "confirmed" }] },
  }),
  draftCase("drafts-09-never-mind", "\"never mind\" mid-draft", {
    steps: [{ say: "Add Code Club for Avery, cofounder" }, { say: "never mind", replyIncludes: ["Okay, I dropped the activity draft for Avery Lee."] }],
    expect: { activities: { avery: [] }, draft: "closed" },
  }),
  draftCase("drafts-10-two-activities", "Two activities in one go", {
    steps: [
      { say: "Add two activities for Avery: Code Club, cofounder, grade 11, summer, 6 hours a week, 2 weeks a year; and Debate Club, captain, grade 12, school year, 3 hours a week, 30 weeks a year" },
      { confirm: "last" },
    ],
    expect: {
      activities: { avery: [{ organization: "Code Club", hours_per_week: 6 }, { organization: "Debate Club", grade_levels: ["12"], timing: ["school"], hours_per_week: 3, weeks_per_year: 30 }] },
      cards: [ADD_DONE],
    },
  }),
  draftCase("drafts-11-venue-is-not-the-organization", "\"It ran at City Library\"", {
    steps: [{ say: ONE }, { say: "It ran at City Library" }, { confirm: "last" }],
    expect: { activities: { avery: [{ ...CODE_CLUB, position: "cofounder" }] } },
  }),
  draftCase("drafts-12-unrelated-then-continue", "A GPA question mid-draft, then continue, then the hours", {
    seed: { gpa: true },
    steps: [
      { say: "Add Code Club for Avery: cofounder, grade 11, summer, 2 weeks a year" },
      { say: "what's her GPA?", replyIncludes: ["3.82", REMINDER] },
      { say: "continue", replyIncludes: ["Still need for Code Club row: hours"] },
      { say: "6 hours a week" },
      { confirm: "last" },
    ],
    expect: { activities: { avery: [{ ...CODE_CLUB }] }, cards: [ADD_DONE] },
  }),
  draftCase("drafts-13-expiry", "A reply after 30 minutes, then yes", {
    steps: [
      { say: "Add Code Club for Avery, cofounder" },
      { advanceClock: 31 },
      { say: "what's her grad year?", replyIncludes: ["Your activity draft expired. Want to start again?"] },
      { say: "yes" },
    ],
    expect: {
      activities: { avery: [] },
      draft: "open",
      draftCheck: (d) => (d.rows.some((r) => key(r.fields?.organization) === "code club") ? null : "the expired fields weren't restored"),
    },
  }),
  draftCase("drafts-14-too-many-hours", "\"200 hours a week\"", {
    steps: [{ say: "Add Code Club for Avery: cofounder, grade 11, summer, 200 hours a week, 2 weeks a year", replyIncludes: ["Couldn't save Code Club yet: hours per week"] }],
    expect: { activities: { avery: [] }, draft: "open" },
  }),
  draftCase("drafts-15-the-transcript", "The redacted transcript, replayed", {
    steps: [
      { say: "could you add Code Club to her list?" },
      { say: "her activites sheet" },
      { say: "Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr" },
      { say: "i gave it" },
      { say: "City Library, please add it now" },
      { confirm: "last" },
    ],
    expect: { activities: { avery: [{ ...CODE_CLUB, position: "Cofounder/Teacher" }] } },
    targets: { counselorMessages: 5 },
  }),
  draftCase("drafts-16-from-the-resume", "\"Add the activities from her resume\"", {
    seed: { resume: true },
    steps: [{ say: "Add the activities from her resume" }, { say: "that's all, add them" }, { confirm: "last" }],
    expect: {
      activities: {
        avery: [
          { organization: "Robotics Club", grade_levels: ["10", "11", "12"], timing: ["school"], hours_per_week: 8, weeks_per_year: 30 },
          { organization: "Food Bank", grade_levels: ["11", "12"], timing: ["break"], hours_per_week: 4, weeks_per_year: 10 },
        ],
      },
      cards: [{ ...ADD_DONE, reason: "outside-content" }],
    },
  }),
  draftCase("drafts-17-a-number-that-isnt-hours", "\"Is her SAT 1450 good for UCLA?\" mid-draft", {
    seed: { gpa: true },
    steps: [{ say: "Add Code Club for Avery, cofounder" }, { say: "Is her SAT 1450 good for UCLA?", replyIncludes: [REMINDER] }],
    expect: {
      activities: { avery: [] },
      draft: "open",
      draftCheck: (d) => (d.rows.some((r) => r.fields?.hours_per_week !== undefined || r.fields?.weeks_per_year !== undefined) ? "1450 was captured" : null),
    },
  }),
  draftCase("drafts-18-switch-student", "Another student mid-draft, then yes", {
    seed: { jordan: true },
    steps: [
      { say: "Add Code Club for Avery, cofounder" },
      { say: "add Debate Club for Jordan Park, 5 hours a week", replyIncludes: ["Drop it and start one for Jordan Park?"] },
      { say: "yes" },
    ],
    expect: {
      activities: { avery: [], jordan: [] },
      draft: "open",
      draftCheck: (d) => (key(d.header?.student_name) === "jordan park" && d.rows.some((r) => key(r.fields?.organization) === "debate club") ? null : "no draft for Jordan with Debate Club"),
    },
  }),
];
