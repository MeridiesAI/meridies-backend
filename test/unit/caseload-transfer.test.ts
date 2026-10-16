import assert from "node:assert/strict";
import { test } from "node:test";
import { brandedEmail, brandedText } from "../../src/lib/email.js";
import {
  MAX_STUDENTS_PER_TRANSFER,
  ONE_ARG_TTL_MS,
  cleanName,
  plannedEmails,
  policyBody,
  receiverEmail,
  removeError,
  removeMember,
  resetRemoveMemberCache,
  studentEmail,
  studentsToEmail,
  toPreview,
  toTransferResponse,
  toTransferResult,
  transferArgs,
  transferBody,
  transferError,
  transferUnavailable,
} from "../../src/lib/caseloadTransfer.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const S = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

test("one_person: a receiver, defaults on, strict", () => {
  const b = transferBody.parse({ mode: "one_person", toId: A });
  assert.deepEqual(b, { mode: "one_person", toId: A, notifyStudents: true, removeAfter: false, includePracticeItems: false });
  assert.throws(() => transferBody.parse({ mode: "one_person", toId: A, extra: 1 }));
  assert.throws(() => transferBody.parse({ mode: "one_person" }));
  assert.throws(() => transferBody.parse({ mode: "one_person", toId: "not-a-uuid" }));
});

test("per_student: assignments required, strict items, no duplicates, the cap", () => {
  const ok = transferBody.parse({ mode: "per_student", assignments: [{ studentId: S(1), toId: A }] });
  assert.equal(ok.mode, "per_student");
  assert.throws(() => transferBody.parse({ mode: "per_student", assignments: [] }));
  assert.throws(() => transferBody.parse({ mode: "per_student", assignments: [{ studentId: S(1), toId: A, x: 1 }] }));
  assert.throws(
    () => transferBody.parse({ mode: "per_student", assignments: [{ studentId: S(1), toId: A }, { studentId: S(1), toId: B }] }),
    /assigned twice/
  );
  const full = Array.from({ length: MAX_STUDENTS_PER_TRANSFER }, (_, i) => ({ studentId: S(i + 1), toId: A }));
  assert.equal(MAX_STUDENTS_PER_TRANSFER, 500);
  assert.doesNotThrow(() => transferBody.parse({ mode: "per_student", assignments: full }));
  assert.throws(() =>
    transferBody.parse({ mode: "per_student", assignments: [...full, { studentId: S(9999), toId: A }] })
  );
});

test("one mode at a time: a body can't carry both shapes", () => {
  assert.throws(() => transferBody.parse({ mode: "one_person", toId: A, assignments: [{ studentId: S(1), toId: A }] }));
  assert.throws(() => transferBody.parse({ mode: "per_student", toId: A, assignments: [{ studentId: S(1), toId: A }] }));
  assert.throws(() => transferBody.parse({ mode: "everyone", toId: A }));
  assert.throws(() => transferBody.parse({ mode: "admin_assigns", toId: A }));
});

test("transferArgs: practice items ride along with removeAfter, and only one shape is sent", () => {
  const one = transferArgs(B, transferBody.parse({ mode: "one_person", toId: A, removeAfter: true }));
  assert.deepEqual(one, {
    p_from: B, p_all_to: A, p_assignments: null, p_practice_to: null, p_include_practice: true, p_remove_after: true,
  });
  const per = transferArgs(
    B,
    transferBody.parse({ mode: "per_student", assignments: [{ studentId: S(1), toId: C }], practiceToId: A, includePracticeItems: true })
  );
  assert.equal(per.p_all_to, null);
  assert.deepEqual(per.p_assignments, [{ studentId: S(1), toId: C }]);
  assert.equal(per.p_practice_to, A);
  assert.equal(per.p_include_practice, true);
  assert.equal(per.p_remove_after, false);
});

test("policy body: one vocabulary (one_person | per_student), receiver nullable, strict", () => {
  assert.deepEqual(policyBody.parse({ mode: "one_person", defaultReceiverId: A }), { mode: "one_person", defaultReceiverId: A });
  assert.deepEqual(policyBody.parse({ defaultReceiverId: null }), { defaultReceiverId: null });
  assert.throws(() => policyBody.parse({ mode: "admin_assigns" }));
  assert.throws(() => policyBody.parse({ mode: "per_student", other: true }));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("not applied yet: every missing-function/table/column code is a 503 with the code", () => {
  for (const code of ["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]) {
    const e = transferUnavailable({ code, message: "x" });
    assert.ok(e, code);
    assert.equal(e!.statusCode, 503);
    assert.equal(e!.code, "caseload_transfer_unavailable");
  }
  assert.equal(transferUnavailable({ code: "P0001", message: "x" }), null);
  assert.equal(transferUnavailable(null), null);
});

test("transferError: our refusals pass through with their status, raw ones don't", () => {
  assert.equal(transferError({ code: "42501", message: "Only a firm owner or admin can transfer students" }).statusCode, 403);
  assert.equal(transferError({ code: "P0001", message: "2 students are no longer on B's caseload. Refresh and try again" }).statusCode, 409);
  assert.equal(transferError({ code: "22023", message: "A student is assigned twice" }).statusCode, 400);
  const raw = transferError({ code: "P0001", message: 'duplicate key value violates unique constraint "x"' });
  assert.equal(raw.statusCode, 409);
  assert.doesNotMatch(raw.message, /violates/);
  assert.equal(transferError({ code: "PGRST205", message: "x" }).statusCode, 503);
});

test("removeError: the untransferred-caseload refusal is 409 caseload_not_transferred", () => {
  const e = removeError({ code: "P0001", message: "Transfer their 3 students first, or release them", hint: "caseload_not_transferred" });
  assert.equal(e.statusCode, 409);
  assert.equal(e.code, "caseload_not_transferred");
  assert.match(e.message, /Transfer their 3 students/);
  const other = removeError({ code: "P0001", message: "The owner can't leave their own firm" });
  assert.equal(other.statusCode, 409);
  assert.equal(other.code, undefined);
});

// ---------------------------------------------------------------------------
// The 1-argument fallback for removal
// ---------------------------------------------------------------------------

function fakeRpc(hasTwoArg: boolean) {
  const calls: Record<string, unknown>[] = [];
  const rpc = async (_fn: string, args: Record<string, unknown>) => {
    calls.push(args);
    if (!hasTwoArg && "p_release_students" in args) {
      return { error: { code: "PGRST202", message: "Could not find the function public.remove_firm_member(p_profile, p_release_students)" } };
    }
    return { error: null };
  };
  return { calls, rpc };
}

test("removeMember: the new function gets the flag in one call", async () => {
  resetRemoveMemberCache();
  const f = fakeRpc(true);
  await removeMember(f.rpc, A, true, 0);
  assert.deepEqual(f.calls, [{ p_profile: A, p_release_students: true }]);
});

test("removeMember: before the migration, retried once without the flag and remembered", async () => {
  resetRemoveMemberCache();
  const f = fakeRpc(false);
  await removeMember(f.rpc, A, false, 1000);
  assert.deepEqual(f.calls, [{ p_profile: A, p_release_students: false }, { p_profile: A }]);
  // Within five minutes: straight to the old call.
  await removeMember(f.rpc, B, false, 1000 + ONE_ARG_TTL_MS - 1);
  assert.deepEqual(f.calls.at(-1), { p_profile: B });
  assert.equal(f.calls.length, 3);
  // After: tries the new shape again.
  await removeMember(f.rpc, C, false, 1000 + ONE_ARG_TTL_MS + 1);
  assert.deepEqual(f.calls.slice(3), [{ p_profile: C, p_release_students: false }, { p_profile: C }]);
});

test("removeMember: the refusal surfaces as 409 caseload_not_transferred", async () => {
  resetRemoveMemberCache();
  const rpc = async () => ({ error: { code: "P0001", message: "Transfer their 1 student first, or release them", hint: "caseload_not_transferred" } });
  await assert.rejects(removeMember(rpc, A, false, 0), (e: { statusCode: number; code: string }) => e.statusCode === 409 && e.code === "caseload_not_transferred");
});

// ---------------------------------------------------------------------------
// Answers carry no address
// ---------------------------------------------------------------------------

const rawResult = {
  transferId: "t1",
  mode: "one_person",
  studentCount: 3,
  from: { id: B, name: "Bea", email: "bea@x.test" },
  firmId: "f1",
  practiceTo: A,
  practiceItemsMoved: true,
  removed: false,
  students: [
    { id: S(1), name: "Ann", toId: C, archived: false, alumni: false, email: "ann@x.test" },
    { id: S(2), name: "Old", toId: C, archived: true, alumni: false },
    { id: S(3), name: "Alum", toId: C, archived: false, alumni: true },
  ],
  receivers: [{ id: C, name: "Cal", count: 3, email: "cal@x.test" }],
  moved: { meetings: 2, email: "nope@x.test" },
  practice: { imports: 1 },
  attention: {
    calendarMeetings: [{ id: "m1", title: "Kickoff", startsAt: "2026-11-01T15:00:00Z", toId: C, email: "x@y.z" }],
    groupMeetings: [],
    supplementDocs: [],
    driveLinkedDocuments: 0,
    cancelledMessages: 1,
    cancelledAlerts: 0,
  },
};

test("the transfer response is built field by field: no email anywhere", () => {
  const r = toTransferResult(rawResult);
  const body = JSON.stringify(toTransferResponse(r, { planned: 3 }));
  assert.doesNotMatch(body, /@/);
  assert.doesNotMatch(body, /"email":"/);
  // Count maps keep their keys but only ever carry numbers.
  assert.equal(JSON.parse(body).moved.email, 0);
  assert.match(body, /"studentCount":3/);
});

test("the preview DTO names its fields: an extra key from SQL never reaches the client", () => {
  const p = toPreview({
    from: { id: B, name: "Bea", approved: false, isOwner: false, isYou: false, email: "bea@x.test" },
    students: [{ id: S(1), name: "Ann", gradYear: "2027", archived: false, alumni: false, onboarding: true, upcomingMeetings: 2, email: "a@b.c" }],
    receivers: [{ id: C, name: "Cal", seatRole: "admin", studentCount: 4, isYou: true, email: "c@d.e" }],
    counts: { students: 1 },
    attention: { supplementDocs: 0 },
    practiceItems: { movable: true, imports: 2 },
    policy: { mode: "one_person", defaultReceiverId: C },
  });
  assert.doesNotMatch(JSON.stringify(p), /@/);
  assert.equal(p.students[0]!.onboarding, true);
  assert.equal(p.policy.mode, "one_person");
  assert.equal(p.practiceItems.movable, true);
});

test("students emailed: never archived students or alumni, and none when switched off", () => {
  const r = toTransferResult(rawResult);
  assert.deepEqual(studentsToEmail(r, true).map((s) => s.name), ["Ann"]);
  assert.deepEqual(studentsToEmail(r, false), []);
  assert.equal(plannedEmails(r, true), 1 + 1 + 1);
  assert.equal(plannedEmails(r, false), 2);
});

// ---------------------------------------------------------------------------
// Email copy
// ---------------------------------------------------------------------------

test("names render as text: markup in a name is escaped, control characters dropped", () => {
  const name = cleanName("<script>alert(1)</script>\r\nBcc: x", "x");
  assert.doesNotMatch(name, /[\r\n]/);
  const m = studentEmail({ receiverName: name, firmName: "A & B <Partners>", url: "https://app.test/dashboard/student" });
  const html = brandedEmail(m.template);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &amp; B &lt;Partners&gt;/);
  assert.match(brandedText(m.template), /is now your counselor at A & B <Partners>\./);
});

test("receiver email: students listed (50, then a count), attention items said once, no em dashes", () => {
  const names = Array.from({ length: 53 }, (_, i) => `Student ${i + 1}`);
  const m = receiverEmail({
    receiverName: "Cal",
    fromName: "Bea",
    adminName: "Ada",
    firmName: "Firm",
    studentNames: names,
    calendarMeetings: [{ title: "Kickoff", startsAt: "2026-11-01T15:00:00Z" }],
    supplementDocs: 2,
    driveLinkedDocuments: 1,
    cancelledMessages: 1,
    timezone: "America/New_York",
    url: "https://app.test/dashboard/counselor",
  });
  assert.equal(m.subject, "53 students from Bea are now yours");
  assert.equal(m.template.bullets!.length, 51);
  assert.equal(m.template.bullets!.at(-1), "and 3 more");
  const text = brandedText(m.template);
  assert.match(text, /Kickoff \(Nov 1, 10:00 AM\)/);
  assert.match(text, /2 supplement Docs are still in Bea's Google Drive/);
  assert.match(text, /1 document was linked/);
  assert.match(text, /1 scheduled message was cancelled/);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(brandedText(studentEmail({ receiverName: "Cal", firmName: "F", url: "u" }).template), /—/);
});

test("keptFiles: read from the answer, 0 when an older function leaves it out", () => {
  assert.equal(toTransferResult(rawResult).attention.keptFiles, 0);
  const withKept = { ...rawResult, attention: { ...rawResult.attention, keptFiles: 2 } };
  assert.equal(toTransferResult(withKept).attention.keptFiles, 2);
  assert.equal(toTransferResponse(toTransferResult(withKept), { planned: 0 }).attention.keptFiles, 2);
  assert.equal(toTransferResult(rawResult).attention.unfiledFiles, 0);
  const withUnfiled = { ...rawResult, attention: { ...rawResult.attention, unfiledFiles: 3 } };
  assert.equal(toTransferResponse(toTransferResult(withUnfiled), { planned: 0 }).attention.unfiledFiles, 3);
});
