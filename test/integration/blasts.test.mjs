// Email blast (migration 20261030000001): filters that combine, the ticked
// students, parents, scheduling, the Queued list, the dispatcher and a yearly
// repeat. Mail goes to the local catcher only.
//
//   C   a counselor with students A (2027, Brown in-progress, parent), B (2027,
//       Yale submitted, parent with alerts off) and Z (2028, Brown submitted)
//   X   a counselor elsewhere
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
const C = await user("blast-c");
const X = await user("blast-x");
const a = await studentOf(C, "blast-a");
const b = await studentOf(C, "blast-b");
const z = await studentOf(C, "blast-z");
await sql(`update public.profiles set grad_year = '2027' where id in ('${a.id}', '${b.id}')`);
await sql(`update public.profiles set grad_year = '2028' where id = '${z.id}'`);
await sql(`insert into public.student_colleges (student_id, name, status) values
  ('${a.id}', 'Brown University', 'in-progress'),
  ('${b.id}', 'Yale University', 'submitted'),
  ('${z.id}', 'brown university', 'submitted')`);
await sql(`insert into public.guardians (student_id, full_name, email) values ('${a.id}', 'Pat Parent', 'pat-${tag}@families.test')`);
await sql(`insert into public.guardians (student_id, full_name, email, alerts_enabled) values ('${b.id}', 'Off Parent', 'off-${tag}@families.test', false)`);

const dispatch = async (secret = CRON_SECRET) => {
  const r = await fetch(`${API}/internal/blasts/dispatch`, {
    method: "POST",
    headers: { ...CLIENT, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};
const preview = (over) => call(C.token, "POST", "/blasts/preview", over);
const names = (r) => (r.body.students ?? []).map((s) => s.id).sort().join(",");
const ids = (...u) => u.map((s) => s.id).sort().join(",");
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------
const aud = await call(C.token, "GET", "/blasts/audiences");
check("audiences list class years, colleges and statuses", aud.body.classYears?.length === 2 && aud.body.statuses?.length === 2, JSON.stringify(aud.body));
check("a college typed in two cases is one college", aud.body.schools.find((s) => /brown/i.test(s.value))?.count === 2, JSON.stringify(aud.body.schools));

check("no filter is the whole roster", names(await preview({})) === ids(a, b, z));
check("a class year narrows", names(await preview({ classYears: ["2027"] })) === ids(a, b));
check("two class years widen within it", names(await preview({ classYears: ["2027", "2028"] })) === ids(a, b, z));
check("a college narrows, in any case", names(await preview({ colleges: ["Brown University"] })) === ids(a, z));
check("class year and college combine", names(await preview({ classYears: ["2027"], colleges: ["Brown University"] })) === ids(a));
check("college and status are read from the same list row", names(await preview({ colleges: ["Brown University"], statuses: ["submitted"] })) === ids(z));
check("a combination nobody matches is empty", names(await preview({ classYears: ["2027"], colleges: ["Brown University"], statuses: ["submitted"] })) === "");

const ticked = await preview({ classYears: ["2027"], studentIds: [a.id] });
check("the ticked students set the count; the list keeps every match", ticked.body.count === 1 && names(ticked) === ids(a, b), JSON.stringify(ticked.body));
const foreign = await call(X.token, "POST", "/blasts/preview", { studentIds: [a.id] });
check("another counselor's student is refused", foreign.status === 400, `${foreign.status}`);
check("the old audience shape is refused", (await preview({ audienceKind: "roster" })).status === 400);

// ---------------------------------------------------------------------------
// Parents
// ---------------------------------------------------------------------------
const parents = await preview({ recipientType: "parents", classYears: ["2027"] });
check("parents: only a guardian with an address and alerts on is reached", parents.body.deliverable === 1 && parents.body.missingEmail?.length === 1, JSON.stringify(parents.body));
check("parents: the list says which students can't be reached", parents.body.students.find((s) => s.id === a.id)?.reachable === true && parents.body.students.find((s) => s.id === b.id)?.reachable === false);

// ---------------------------------------------------------------------------
// Sending now
// ---------------------------------------------------------------------------
const sentNow = await call(C.token, "POST", "/blasts", { recipientType: "parents", classYears: ["2027"], studentIds: [a.id], subject: `Now ${tag}`, body: "Hi {first},\n\nA note from {me}." });
check("a blast to parents goes now", sentNow.status === 201 && sentNow.body.status === "sent" && sentNow.body.recipientType === "parents", JSON.stringify(sentNow.body));
const mail = await sql(`select count(*) from public.message_deliveries where blast_id = '${sentNow.body.id}' and to_email = 'pat-${tag}@families.test' and recipient_kind = 'guardian' and body like 'Hi Pat,%'`);
check("it reached the parent, greeted by the parent's first name", mail === "1", mail);

const empty = await call(C.token, "POST", "/blasts", { classYears: ["2027"], colleges: ["Nowhere U"], subject: "x", body: "y" });
check("an empty audience is refused", empty.status === 400, `${empty.status}`);

// ---------------------------------------------------------------------------
// Scheduling and the queue
// ---------------------------------------------------------------------------
const past = await call(C.token, "POST", "/blasts", { subject: "x", body: "y", scheduledFor: day(-1) });
check("a time in the past is refused", past.status === 400, `${past.status}`);
const noDate = await call(C.token, "POST", "/blasts", { subject: "x", body: "y", repeatYearly: true });
check("repeating needs a date", noDate.status === 400, `${noDate.status}`);

const queued = await call(C.token, "POST", "/blasts", { classYears: ["2027"], subject: `Later ${tag}`, body: "Later.", scheduledFor: day(2) });
check("a blast can be scheduled", queued.status === 201 && queued.body.status === "scheduled" && queued.body.scheduledFor, JSON.stringify(queued.body));
const yearly = await call(C.token, "POST", "/blasts", { classYears: ["2028"], subject: `Yearly ${tag}`, body: "Every year.", scheduledFor: day(3), repeatYearly: true });
check("a yearly blast can be scheduled", yearly.status === 201 && yearly.body.repeatYearly === true, JSON.stringify(yearly.body));

const sentCount = (id) => sql(`select count(*) from public.message_deliveries where blast_id = '${id}'`);
check("scheduling sends nothing", (await sentCount(queued.body.id)) === "0");

const list = await call(C.token, "GET", "/blasts?status=scheduled");
check("the Queued list shows both, soonest first", list.body.length === 2 && list.body[0].id === queued.body.id && list.body[1].repeatYearly === true, JSON.stringify(list.body.map((r) => r.subject)));
check("another counselor's queue is empty", (await call(X.token, "GET", "/blasts?status=scheduled")).body.length === 0);

const forged = await call(X.token, "POST", `/blasts/${queued.body.id}/cancel`);
check("another counselor can't cancel it", forged.status === 404, `${forged.status}`);

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------
check("the dispatcher refuses a stranger", (await dispatch("wrong")).status === 401);
check("a blast that isn't due yet isn't sent", (await sentCount(queued.body.id)) === "0");

const dueNow = (id) => sql(`update public.email_blasts set scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${id}'`);
await dueNow(queued.body.id);
const ran = await dispatch();
check("a due blast is sent by the cron", ran.status === 200 && ran.body.ran === true && ran.body.sent >= 1, JSON.stringify(ran.body));
const done = await call(C.token, "GET", `/blasts/${queued.body.id}`);
check("it is recorded as sent, to the students the filters matched", done.body.status === "sent" && done.body.recipients.length === 2, JSON.stringify([done.body.status, done.body.recipients?.length]));
const again = await dispatch();
check("a second run doesn't send it again", (await sentCount(queued.body.id)) === "2" && again.body.ran === true);
check("a sent blast leaves the queue", (await call(C.token, "GET", "/blasts?status=scheduled")).body.every((r) => r.id !== queued.body.id));

// A blast whose filters match nobody by send time ends as failed, not silently.
const ghost = await call(C.token, "POST", "/blasts", { colleges: ["Yale University"], statuses: ["submitted"], subject: `Ghost ${tag}`, body: "Hi", scheduledFor: day(1) });
await sql(`delete from public.student_colleges where student_id = '${b.id}'`);
await dueNow(ghost.body.id);
await dispatch();
check("an audience that emptied by send time ends as failed", (await sql(`select status from public.email_blasts where id = '${ghost.body.id}'`)) === "failed");

// A yearly blast writes each run as its own row and moves itself a year on.
const before = await sql(`select scheduled_for from public.email_blasts where id = '${yearly.body.id}'`);
await dueNow(yearly.body.id);
await dispatch();
const run = await sql(`select count(*) from public.email_blasts where subject = 'Yearly ${tag}' and status = 'sent' and repeat_yearly = false`);
const next = JSON.parse(await sql(`select row_to_json(e) from public.email_blasts e where id = '${yearly.body.id}'`));
check("each yearly run is a row of its own", run === "1", run);
const days = (Date.parse(next.scheduled_for) - Date.now()) / 86_400_000;
check("the yearly blast stays queued a year on", next.status === "scheduled" && days > 360 && days < 367 && next.claimed_at === null, JSON.stringify(next));
check("and its last send is on it", Boolean(next.sent_at) && before !== next.scheduled_for);

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------
const cancel = await call(C.token, "POST", `/blasts/${yearly.body.id}/cancel`);
check("a queued blast can be cancelled", cancel.status === 200 && cancel.body.status === "cancelled" && cancel.body.repeatYearly === false, JSON.stringify(cancel.body));
await dueNow(yearly.body.id);
await dispatch();
check("a cancelled blast is never sent", (await sql(`select count(*) from public.email_blasts where subject = 'Yearly ${tag}' and status = 'sent'`)) === "1");
const resent = await call(C.token, "POST", `/blasts/${queued.body.id}/cancel`);
check("a blast that was sent can't be cancelled", resent.status === 409, `${resent.status}`);
