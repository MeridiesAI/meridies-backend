// Seasonal stage emails (migration 20261110000003, lib/stageTemplates.ts): nine drafts seeded with the
// everyday templates, edited and restored, queued from Email Blast without ever repeating, and a queued
// blast's subject, text and time changeable until its cron claims it. Mail goes to the local catcher only.
//
//   C   a counselor with students A (2027, guardian Pat), L and M (2028, siblings sharing one parent address)
//   X   a counselor elsewhere
import { API, CLIENT, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
const C = await user("stage-c");
const X = await user("stage-x");
const a = await studentOf(C, "stage-ana");
const l = await studentOf(C, "stage-luis");
const m = await studentOf(C, "stage-maya");
// Real first names: the harness names an account by its tag, and {student} reads the first word of a name.
await sql(`update public.profiles set full_name = 'Ana Lopez' where id = '${a.id}'`);
await sql(`update public.profiles set full_name = 'Luis Lopez' where id = '${l.id}'`);
await sql(`update public.profiles set full_name = 'Maya Lopez' where id = '${m.id}'`);
await sql(`update public.profiles set grad_year = '2027' where id = '${a.id}'`);
await sql(`update public.profiles set grad_year = '2028' where id in ('${l.id}', '${m.id}')`);
await sql(`insert into public.guardians (student_id, full_name, email) values ('${a.id}', 'Pat Parent', 'pat-${tag}@families.test')`);
// Two siblings, one parent address: one email that names both.
await sql(`insert into public.guardians (student_id, full_name, email) values ('${l.id}', 'Sam Sibling', 'sam-${tag}@families.test')`);
await sql(`insert into public.guardians (student_id, full_name, email) values ('${m.id}', 'Sam Sibling', 'sam-${tag}@families.test')`);

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const families = async (token = C.token) => (await call(token, "GET", "/email-templates?set=families")).body;
const staged = (list) => list.filter((t) => t.stage !== null);
const dispatch = async () => {
  const r = await fetch(`${API}/internal/blasts/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const dueNow = (id) => sql(`update public.email_blasts set scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${id}'`);

// The nine drafts as the plan names them: slug -> stage, month, day, class.
const EXPECTED = {
  "stage-jr-search-kickoff": ["Ideation", 1, 12, 1],
  "stage-jr-essay-ideas": ["Ideation", 4, 6, 1],
  "stage-jr-summer-plan": ["Summer plan", 6, 1, 1],
  "stage-sr-essay-planning": ["Planning essays", 8, 17, 0],
  "stage-sr-first-drafts": ["First drafts", 9, 14, 0],
  "stage-sr-revisions": ["Revisions", 10, 12, 0],
  "stage-sr-regular-deadlines": ["Final checks", 11, 16, 0],
  "stage-sr-wrapup-aid": ["Wrap-up and aid", 1, 5, 0],
  "stage-sr-decisions": ["Decisions", 3, 8, 0],
};

// ---------------------------------------------------------------------------
// Seeding: a new counselor gets the drafts with the everyday templates
// ---------------------------------------------------------------------------
const first = await families();
check("a new counselor's families list is the four everyday templates and nine drafts", first.length === 13 && staged(first).length === 9, `${first.length}`);
check("the everyday four are unchanged and carry no stage", first.filter((t) => t.stage === null).map((t) => t.slug).sort().join() === "contract-proposal,follow-up,reminders,welcoming");
const bySlug = Object.fromEntries(staged(first).map((t) => [t.slug, t]));
for (const [slug, [stage, month, dayOf, cls]] of Object.entries(EXPECTED)) {
  const t = bySlug[slug];
  check(`${slug}: ${stage}, ${month}/${dayOf}, class ${cls}`, t?.stage === stage && t.sendMonth === month && t.sendDay === dayOf && t.classOffset === cls && t.audience === "parents" && t.set === "families", JSON.stringify(t && [t.stage, t.sendMonth, t.sendDay, t.classOffset]));
}
check("every draft greets the parent and names the student", staged(first).every((t) => t.body.startsWith("Hi {first},") && t.body.includes("{student}") && t.body.includes("{me}")));
check("the staff set has no drafts", (await call(C.token, "GET", "/email-templates?set=staff")).body.every((t) => t.stage === null));
check("another counselor has their own, separate", (await families(X.token)).length === 13 && !(await families(X.token)).some((t) => first.some((f) => f.id === t.id)));

// ---------------------------------------------------------------------------
// Editing a draft's date, class and audience
// ---------------------------------------------------------------------------
const draft = bySlug["stage-sr-revisions"];
const moved = await call(C.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 11, sendDay: 2, classOffset: 1, audience: "students" });
check("a draft's month, day, class and audience can be changed", moved.status === 200 && moved.body.sendMonth === 11 && moved.body.sendDay === 2 && moved.body.classOffset === 1 && moved.body.audience === "students", JSON.stringify(moved.body));
check("its text didn't move", moved.body.subject === draft.subject && moved.body.body === draft.body);
const reworded = await call(C.token, "PATCH", `/email-templates/${draft.id}`, { body: "Hi {first},\n\nMy own words about {student}.\n\n{me}", name: "Revisions, my way" });
check("its text can be rewritten, keeping its date", reworded.status === 200 && reworded.body.name === "Revisions, my way" && reworded.body.sendDay === 2 && reworded.body.stage === "Revisions");

const bad = async (body, label, id = draft.id, token = C.token) => {
  const r = await call(token, "PATCH", `/email-templates/${id}`, body);
  check(label, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
};
await bad({ sendMonth: 2, sendDay: 30 }, "Feb 30 is refused");
check("a month alone is fine when the day it already has exists in it (Nov 2 -> Apr 2)", (await call(C.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 4 })).status === 200);
await call(C.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 11 });
// The month alone is checked against the day it has: move the day to 31, then ask for April.
await call(C.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 1, sendDay: 31 });
await bad({ sendMonth: 4 }, "a month alone is checked against the day the draft already has (Jan 31 -> Apr 31)");
await bad({ sendDay: 32 }, "day 32 is refused");
await bad({ sendMonth: 13 }, "month 13 is refused");
await bad({ classOffset: 4 }, "class 4 is refused");
await bad({ classOffset: -1 }, "class -1 is refused");
await bad({ audience: "everyone" }, "an audience that isn't parents or students is refused");
await bad({ stage: "Hacked" }, "the stage's name isn't editable here");
await bad({}, "an empty change is refused");
const everyday = first.find((t) => t.slug === "welcoming");
await bad({ sendMonth: 3 }, "only a seasonal draft has a date and a class", everyday.id);
const foreignPatch = await call(X.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 3 });
check("another counselor can't edit it", foreignPatch.status === 404, `${foreignPatch.status}`);
// Straight at the database as the counselor, past the API: the table's own checks hold.
const direct = async (patch) => rest(C.token, "PATCH", `/rest/v1/email_templates?id=eq.${draft.id}`, patch, { Prefer: "return=representation" });
check("the table refuses a half-set stage", (await direct({ stage: null })).status >= 400);
check("the table refuses Apr 31", (await direct({ send_month: 4, send_day: 31 })).status >= 400);
check("the table refuses a class past 3", (await direct({ class_offset: 7 })).status >= 400);
const staffStage = await sql(
  `insert into public.email_templates (counselor_id, template_set, slug, name, subject, body, stage, send_month, send_day, class_offset)
   values ('${C.id}', 'staff', 'stage-x', 'x', 'x', 'x', 'Ideation', 1, 1, 0)`
).then(() => "inserted", () => "refused");
check("the table refuses a seasonal draft in the staff set", staffStage === "refused", staffStage);
check("none of those attempts changed the draft", (await families()).find((t) => t.id === draft.id).sendDay === 31);
await call(C.token, "PATCH", `/email-templates/${draft.id}`, { sendMonth: 11, sendDay: 2 });

// ---------------------------------------------------------------------------
// Deleting and restoring: a deleted draft stays deleted; restore brings back only what is missing
// ---------------------------------------------------------------------------
const gone = bySlug["stage-sr-decisions"];
const gone2 = bySlug["stage-jr-summer-plan"];
check("a draft can be deleted", (await call(C.token, "DELETE", `/email-templates/${gone.id}`)).status === 204 && (await call(C.token, "DELETE", `/email-templates/${gone2.id}`)).status === 204);
const afterDelete = await families();
check("opening the list again doesn't bring it back", afterDelete.length === 11 && !afterDelete.some((t) => t.slug === "stage-sr-decisions"), `${afterDelete.length}`);
const restored = await call(C.token, "POST", "/email-templates/stages/restore", {});
check("restore says how many came back", restored.status === 200 && restored.body.restored === 2, JSON.stringify(restored.body));
const afterRestore = await families();
check("both are back, with their original text and date", afterRestore.length === 13 && afterRestore.find((t) => t.slug === "stage-sr-decisions")?.body === gone.body && afterRestore.find((t) => t.slug === "stage-jr-summer-plan")?.sendMonth === 6);
const kept = afterRestore.find((t) => t.slug === "stage-sr-revisions");
check("a draft that was there keeps every edit I made", kept.name === "Revisions, my way" && kept.sendMonth === 11 && kept.sendDay === 2 && kept.classOffset === 1 && kept.audience === "students" && kept.body.includes("My own words"));
check("restoring again does nothing", (await call(C.token, "POST", "/email-templates/stages/restore", {})).body.restored === 0);
check("restore can't be aimed at someone else: it adds only to the caller", (await call(X.token, "POST", "/email-templates/stages/restore", {})).body.restored === 0 && (await families(X.token)).length === 13);
check("restore takes no body", (await call(C.token, "POST", "/email-templates/stages/restore", { counselorId: X.id })).status === 400);

// An account that has templates but no drafts (every account before this migration) gets them from restore.
const Y = await user("stage-old");
await sql(`insert into public.email_templates (counselor_id, template_set, slug, name, subject, body)
  values ('${Y.id}', 'families', 'welcoming', 'Welcoming', 'Welcome', 'Hi {first}')`);
const oldList = await families(Y.token);
check("an older account (templates, no drafts) isn't re-seeded just by opening the list", oldList.length === 1 && staged(oldList).length === 0, `${oldList.length}`);
check("restore gives it the nine", (await call(Y.token, "POST", "/email-templates/stages/restore", {})).body.restored === 9 && (await families(Y.token)).length === 10);
// The migration's backfill and the seed share one function, which never adds a draft twice.
check("the insert function is idempotent", (await sql(`select private.insert_stage_templates('${Y.id}')`)) === "0");
const Z = await user("stage-backfill");
await sql(`insert into public.email_templates (counselor_id, template_set, slug, name, subject, body)
  values ('${Z.id}', 'families', 'follow-up', 'Follow-up', 'Following up', 'Hi {first}')`);
check("and adds all nine to an account that has none", (await sql(`select private.insert_stage_templates('${Z.id}')`)) === "9");

// ---------------------------------------------------------------------------
// Queueing from a draft: remembered, classes reported, never twice
// ---------------------------------------------------------------------------
const senior = afterRestore.find((t) => t.slug === "stage-sr-essay-planning");
const junior = afterRestore.find((t) => t.slug === "stage-jr-search-kickoff");
const season = (t, classYears, over = {}) =>
  call(C.token, "POST", "/blasts", { recipientType: "parents", classYears, subject: t.subject, body: t.body, templateId: t.id, scheduledFor: day(5), ...over });

const q1 = await season(senior, ["2027"]);
check("a seasonal draft can be queued", q1.status === 201 && q1.body.status === "scheduled" && q1.body.recipientType === "parents", JSON.stringify(q1.body).slice(0, 200));
check("it remembers the draft and who it is for", q1.body.templateId === senior.id && q1.body.classYears.join() === "2027");
check("and queues nothing to send yet", (await sql(`select count(*) from public.message_deliveries where blast_id = '${q1.body.id}'`)) === "0");
const dup = await season(senior, ["2027"], { scheduledFor: day(9) });
check("the same draft for the same class is refused: already queued", dup.status === 409 && dup.body.code === "already_queued", JSON.stringify(dup.body));
check("however the class years are written", (await season(senior, [" 2027 "], { scheduledFor: day(9) })).status === 409);
const other = await season(senior, ["2028"], { scheduledFor: day(9) });
check("the same draft for another class is fine", other.status === 201 && other.body.classYears.join() === "2028", JSON.stringify(other.body).slice(0, 120));
const j1 = await season(junior, ["2028"]);
check("a different draft for the same class is fine", j1.status === 201);
const foreignTpl = await call(X.token, "POST", "/blasts", { classYears: ["2027"], subject: "x", body: "y", templateId: senior.id, scheduledFor: day(4) });
check("someone else's draft can't be named", foreignTpl.status === 400, `${foreignTpl.status}`);
const notUuid = await call(C.token, "POST", "/blasts", { classYears: ["2027"], subject: "x", body: "y", templateId: "stage-sr-essay-planning", scheduledFor: day(4) });
check("a template id must be an id", notUuid.status === 400);
const queue = await call(C.token, "GET", "/blasts?status=scheduled");
check("the Queued list carries each blast's draft and classes", queue.body.filter((b) => b.templateId).length === 3 && queue.body.find((b) => b.id === q1.body.id)?.classYears.join() === "2027");
const cancelled = await call(C.token, "POST", `/blasts/${q1.body.id}/cancel`);
check("a cancelled blast frees its draft to be queued again", cancelled.status === 200 && (await season(senior, ["2027"], { scheduledFor: day(6) })).status === 201);
const noOne = await season(junior, ["2040"], { scheduledFor: day(6) });
check("a class with no students is refused, as before", noOne.status === 400, `${noOne.status}`);
check("sending one now (no date) doesn't count as queued", (await call(C.token, "POST", "/blasts", { recipientType: "parents", classYears: ["2027"], subject: "Now", body: "Hi {first}, about {student}", templateId: senior.id })).status === 201);

// ---------------------------------------------------------------------------
// A season is a run of blasts: scheduling has its own, higher limit than sending now
// ---------------------------------------------------------------------------
let queued = 0;
for (let i = 0; i < 13; i++) {
  if ((await call(C.token, "POST", "/blasts", { classYears: ["2027"], subject: `Run ${i} ${tag}`, body: "x", scheduledFor: day(20 + i) })).status === 201) queued += 1;
}
check("thirteen more can be queued in a row", queued === 13, `${queued}`);

// ---------------------------------------------------------------------------
// Editing a queued blast
// ---------------------------------------------------------------------------
const edit = await call(C.token, "PATCH", `/blasts/${other.body.id}`, { subject: "Planning, edited", body: "Hi {first},\n\nEdited: about {student}.\n\nWarmly,\n{me}", scheduledFor: day(30) });
check("a queued blast's subject, text and time can be changed", edit.status === 200 && edit.body.subject === "Planning, edited" && edit.body.body.includes("Edited:") && Math.abs(Date.parse(edit.body.scheduledFor) - Date.parse(day(30))) < 5_000, JSON.stringify(edit.body).slice(0, 200));
check("it is still queued, for the same draft and class", edit.body.status === "scheduled" && edit.body.templateId === senior.id && edit.body.classYears.join() === "2028");
check("one field alone is fine", (await call(C.token, "PATCH", `/blasts/${other.body.id}`, { subject: "Planning, again" })).body.subject === "Planning, again");
const patchBad = async (body, label) => {
  const r = await call(C.token, "PATCH", `/blasts/${other.body.id}`, body);
  check(label, r.status === 400, `${r.status}`);
};
await patchBad({ scheduledFor: day(-1) }, "a time in the past is refused");
await patchBad({ scheduledFor: new Date(Date.now() + 6 * 365 * 86_400_000).toISOString() }, "a time over five years ahead is refused");
await patchBad({ subject: "   " }, "an empty subject is refused");
await patchBad({ body: "" }, "an empty text is refused");
await patchBad({}, "an empty change is refused");
await patchBad({ recipientType: "students" }, "who it goes to can't be changed here");
await patchBad({ classYears: ["2027"] }, "nor can its classes");
await patchBad({ status: "sent" }, "nor its status");
check("another counselor can't edit it", (await call(X.token, "PATCH", `/blasts/${other.body.id}`, { subject: "Hijacked" })).status === 404);
check("a blast that isn't there is 404", (await call(C.token, "PATCH", "/blasts/00000000-0000-4000-8000-000000000000", { subject: "x" })).status === 404);
check("none of those changed it", (await call(C.token, "GET", `/blasts/${other.body.id}`)).body.subject === "Planning, again");
const frozen = await call(C.token, "PATCH", `/email-templates/${senior.id}`, { body: "Hi {first},\n\nThe draft changed later." });
check("editing the draft later doesn't change what is queued", frozen.status === 200 && (await call(C.token, "GET", `/blasts/${other.body.id}`)).body.body.includes("Edited:"));

// claimed, sent and cancelled blasts can't be changed
await sql(`update public.email_blasts set claimed_at = now() where id = '${j1.body.id}'`);
const claimed = await call(C.token, "PATCH", `/blasts/${j1.body.id}`, { subject: "Too late" });
check("a blast a run has claimed can't be changed", claimed.status === 409, `${claimed.status}`);
check("the claimed blast is as it was", (await call(C.token, "GET", `/blasts/${j1.body.id}`)).body.subject === junior.subject);
check("a cancelled blast can't be changed", (await call(C.token, "PATCH", `/blasts/${q1.body.id}`, { subject: "x" })).status === 409);
await sql(`update public.email_blasts set claimed_at = null where id = '${j1.body.id}'`);

// ---------------------------------------------------------------------------
// The cron sends what the blast says now: edited text, {student} filled, siblings named together
// ---------------------------------------------------------------------------
await dueNow(other.body.id);
const ran = await dispatch();
check("the cron sends the edited blast", ran.status === 200 && ran.body.ran === true && ran.body.sent >= 1, JSON.stringify(ran.body));
const sent = await call(C.token, "GET", `/blasts/${other.body.id}`);
check("one email goes to the parent of two students, not two", sent.body.status === "sent" && sent.body.recipients.filter((r) => r.toEmail === `sam-${tag}@families.test`).length === 1, JSON.stringify(sent.body.recipients?.map((r) => [r.fullName, r.status])));
const mail = await sql(`select body from public.message_deliveries where blast_id = '${other.body.id}' and to_email = 'sam-${tag}@families.test' limit 1`);
check("it greets the parent by name", /Hi Sam,/.test(mail), mail.slice(0, 80));
check("it carries the edited text, not the original", /Edited: about/.test(mail) && !/My own words|The draft changed later/.test(mail));
check("and names both students, filled in for this family", /about Luis and Maya\./.test(mail), mail.slice(0, 160));
check("with no braces left in it", !/[{}]/.test(mail), mail.slice(0, 160));
const subjectLine = await sql(`select subject from public.message_deliveries where blast_id = '${other.body.id}' and to_email = 'sam-${tag}@families.test' limit 1`);
check("the subject is the edited one", subjectLine === "Planning, again", subjectLine);

// One student, one parent: the student's own name, from the draft as it was when it was queued.
const q2 = (await call(C.token, "GET", "/blasts?status=scheduled")).body.find((b) => b.templateId === senior.id && b.classYears.join() === "2027");
await dueNow(q2.id);
await dispatch();
const patMail = await sql(`select body from public.message_deliveries where blast_id = '${q2.id}' and to_email = 'pat-${tag}@families.test' limit 1`);
check("a parent of one student is greeted by name", /Hi Pat,/.test(patMail), patMail.slice(0, 80));
check("and told that student's name, filled in", /Ana chooses a main essay topic by September 1/.test(patMail), patMail.slice(0, 300));
check("from the frozen copy: the draft edited later didn't reach it", /Application season starts now/.test(patMail) && !/The draft changed later/.test(patMail));
check("with no braces left", !/[{}]/.test(patMail));

console.log("\nstage templates suite done");
