// Caseload transfer, seen from the two consultants (spec 2026-10-15-caseload-transfer-design.md):
// a realistic firm (caseload-transfer-fixture.mjs), then one student, a split and the
// whole caseload moved from A through the API the popup calls. After each move, for
// the moved students:
//   - B (or whoever received them) reads, through PostgREST, every row A could read
//     before, table by table, and edits them through the API and PostgREST;
//   - A reads nothing about them (404 from the API, empty from PostgREST) except the
//     firm-wide tables every member shares;
//   - the receiver reads, lists and signs the Storage objects and A can't read,
//     list, sign or delete them (20261116000001 re-points storage.objects.owner_id,
//     which the bucket's select/delete policies honour); scheduled messages and
//     parent alerts were cancelled, with why.
// Then A, with no students left, is removed with a plain Remove: the pipeline stage
// and lead A made go to the firm owner (20261116000001), the contact a student came
// from already went to its receiver, and closing A's account takes none of them.
import { ANON, SB, check, call as rawCall, rest, sql } from "./harness.mjs";
import { cleanupFirm, seedFirm, signIn, storageAccess, visible } from "./caseload-transfer-fixture.mjs";

// caseload-transfer.test.mjs, in the same run, hides caseload_transfer_students for a moment
// (rename + schema reload) to check the "isn't switched on yet" answer. A transfer route
// that lands in that window answers 503 caseload_transfer_unavailable: wait it out.
async function call(token, method, path, body) {
  for (let i = 0; ; i++) {
    const r = await rawCall(token, method, path, body);
    if (!(r.status === 503 && r.body?.code === "caseload_transfer_unavailable") || i >= 30) return r;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

const firm = await seedFirm({ studentCount: 10 });
const { A, B, O, students } = firm;
// Shared by every member of the firm (Management, results, the pipeline): not about A's caseload.
const FIRM_WIDE = new Set(["admission_outcomes", "consultant_tasks", "pipeline_contacts"]);

try {
  const before = new Map();
  for (const s of students) before.set(s.id, await visible(A, [s.id]));
  check("A reads every seeded table for a student", Object.values(before.get(students[0].id)).every((n) => typeof n === "number" && n > 0), JSON.stringify(before.get(students[0].id)));
  const pv = await call(O.token, "GET", `/management/consultants/${A.id}/transfer-preview`);
  check("the preview lists A's 10 students and what gets cancelled", pv.status === 200 && pv.body.students.length === 10 && pv.body.attention.scheduledMessages === 10 && pv.body.attention.queuedParentAlerts === 10 && pv.body.attention.calendarLinkedMeetings === 1, JSON.stringify(pv.body.attention));

  /** After a move: the receiver reads what A did, A reads nothing, files and sends are right. */
  async function verifyMoved(label, moved, to) {
    for (const u of [A, B, O]) await signIn(u);
    for (const s of moved) {
      const was = before.get(s.id);
      const got = await visible(to, [s.id]);
      const lost = await visible(A, [s.id]);
      const missing = Object.keys(was).filter((t) => got[t] !== was[t]);
      check(`${label}: ${to.name} reads all of ${s.name}'s rows`, missing.length === 0, missing.map((t) => `${t} ${got[t]}/${was[t]}`).join(", "));
      const kept = Object.keys(lost).filter((t) => !FIRM_WIDE.has(t) && lost[t] !== 0);
      check(`${label}: A reads none of ${s.name}'s rows`, kept.length === 0, kept.map((t) => `${t} ${lost[t]}`).join(", "));
    }
    const s = moved[0];
    const reads = [`/students/${s.id}`, `/student-page/${s.id}/info`, `/files/documents?studentId=${s.id}`, `/tasks?studentId=${s.id}`,
      `/application/college-list?studentId=${s.id}`, `/application/essays?studentId=${s.id}`, `/meetings?studentId=${s.id}`, `/communication/${s.id}/messages`];
    const aSt = [];
    const toSt = [];
    for (const p of reads) {
      aSt.push((await call(A.token, "GET", p)).status);
      toSt.push((await call(to.token, "GET", p)).status);
    }
    check(`${label}: the API answers 404 to A for ${s.name}`, aSt.every((x) => x === 404), aSt.join(","));
    check(`${label}: the API answers 200 to ${to.name}`, toSt.every((x) => x === 200), toSt.join(","));
    // Read during the other suite's hidden-table window, transferredFrom is null: ask again.
    let info = await call(to.token, "GET", `/student-page/${s.id}/info`);
    for (let i = 0; i < 30 && info.status === 200 && !info.body.transferredFrom; i++) {
      await new Promise((done) => setTimeout(done, 1000));
      info = await call(to.token, "GET", `/student-page/${s.id}/info`);
    }
    check(`${label}: the student page says who it came from`, info.body.transferredFrom?.name === A.name, JSON.stringify(info.body.transferredFrom));

    const edits = [
      (u) => call(u.token, "PATCH", `/application/essays/${s.essayId}`, { status: "review" }).then((r) => r.status === 200),
      (u) => call(u.token, "PATCH", `/tasks/${s.taskId}`, { status: "review" }).then((r) => r.status === 200),
      (u) => call(u.token, "PATCH", `/files/documents/${s.files[0].id}`, { title: `Transcript (${u.name})` }).then((r) => r.status === 200),
      (u) => rest(u.token, "PATCH", `/rest/v1/student_private_notes?student_id=eq.${s.id}`, { body: `Notes by ${u.name}` }, { Prefer: "return=representation" }).then((r) => Array.isArray(r.body) && r.body.length === 1),
      (u) => rest(u.token, "PATCH", `/rest/v1/guardians?student_id=eq.${s.id}&is_primary=eq.true`, { phone: "555-0100" }, { Prefer: "return=representation" }).then((r) => Array.isArray(r.body) && r.body.length === 1),
      (u) => rest(u.token, "PATCH", `/rest/v1/deliverable_stages?deliverable_id=eq.${s.taskId}&name=eq.First%20draft`, { done: true }, { Prefer: "return=representation" }).then((r) => Array.isArray(r.body) && r.body.length === 1),
    ];
    const toEdits = [];
    const aEdits = [];
    for (const e of edits) {
      aEdits.push(await e(A));
      toEdits.push(await e(to));
    }
    check(`${label}: ${to.name} edits the essay, task, file, private note, guardian and stage`, toEdits.every(Boolean), toEdits.join(","));
    check(`${label}: A edits none of them`, aEdits.every((x) => !x), aEdits.join(","));

    for (const st of moved) {
      const msgs = await sql(`select string_agg(status || ':' || (counselor_id = '${to.id}')::text, ',' order by status) from public.student_messages where student_id = '${st.id}'`);
      const alerts = await sql(`select string_agg(status || ':' || coalesce(suppressed_reason, ''), ',') from public.parent_alerts where student_id = '${st.id}'`);
      check(`${label}: ${st.name}'s scheduled message was cancelled and both moved`, msgs === "cancelled:true,sent:true", msgs);
      check(`${label}: ${st.name}'s queued parent alert was cancelled`, alerts === "cancelled:The student's counselor changed", alerts);
    }

    const counselorFile = await storageAccess(to, s.files[0].path);
    const subFile = await storageAccess(to, s.files[2].path);
    const ownFile = await storageAccess(to, s.ownFile.path);
    check(`${label}: ${to.name} downloads, lists and signs the moved files and the student's own`, [counselorFile, subFile, ownFile].every((x) => x.read && x.listed && x.sign), JSON.stringify([counselorFile, subFile, ownFile]));
    const stale = await Promise.all(s.files.map((f) => storageAccess(A, f.path)));
    check(`${label}: A no longer reads, lists or signs the moved files in Storage`, stale.every((x) => !x.read && !x.listed && !x.sign), JSON.stringify(stale));
    const owners = await sql(`select string_agg(distinct owner_id, ',') from storage.objects where bucket_id = 'student-documents' and name in (${s.files.map((f) => `'${f.path}'`).join(",")})`);
    check(`${label}: the moved objects belong to ${to.name} in Storage`, owners === to.id, owners);
    const del = await fetch(`${SB}/storage/v1/object/student-documents`, { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${A.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [s.files[1].path] }) });
    const deleted = del.ok ? await del.json() : [];
    const still = await storageAccess(to, s.files[1].path);
    check(`${label}: A can't delete a moved file`, Array.isArray(deleted) && deleted.length === 0 && still.read, `${del.status} ${JSON.stringify(deleted).slice(0, 120)} ${JSON.stringify(still)}`);
  }

  // 1) One student, A -> B ("Assign each student" with one row set).
  let r = await call(O.token, "POST", `/management/consultants/${A.id}/transfer`, { mode: "per_student", assignments: [{ studentId: students[0].id, toId: B.id }] });
  check("one student moves to B", r.status === 200 && r.body.studentCount === 1, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  check("…its upcoming calendar meeting, cancelled message and alert are reported", r.body.attention?.calendarMeetings?.length === 1 && r.body.attention.cancelledMessages === 1 && r.body.attention.cancelledAlerts === 1, JSON.stringify(r.body.attention));
  check("…the first student's pipeline contact is B's, creator included", (await sql(`select owner_id::text || '|' || counselor_id::text from public.pipeline_contacts where id = '${firm.contactId}'`)) === `${B.id}|${B.id}`);
  check("…and B is told", Number(await sql(`select count(*) from public.notifications where recipient_id = '${B.id}' and title like '1 student from Alex Avery%'`)) === 1);
  check("…the student is emailed (a delivery row, whatever the provider said)", Number(await sql(`select count(*) from public.message_deliveries where template = 'caseload-transfer-student' and student_id = '${students[0].id}'`)) === 1);
  await verifyMoved("one student", [students[0]], B);

  // 2) A split: one to B, one to the owner; the rest stay.
  r = await call(O.token, "POST", `/management/consultants/${A.id}/transfer`, { mode: "per_student", notifyStudents: false, assignments: [{ studentId: students[1].id, toId: B.id }, { studentId: students[2].id, toId: O.id }] });
  check("the split moves two students", r.status === 200 && r.body.studentCount === 2 && r.body.receivers.length === 2, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  check("…A keeps the other seven", Number(await sql(`select count(*) from public.profiles where counselor_id = '${A.id}'`)) === 7);
  await verifyMoved("split to B", [students[1]], B);
  await verifyMoved("split to the owner", [students[2]], O);

  // 3) The whole caseload, one person.
  r = await call(O.token, "POST", `/management/consultants/${A.id}/transfer`, { mode: "one_person", toId: B.id, notifyStudents: false });
  check("the rest of A's caseload moves to B", r.status === 200 && r.body.studentCount === 7, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  await verifyMoved("whole caseload", students.slice(3), B);
  const all = await visible(A, students.map((s) => s.id));
  check("A reads nothing about any of the ten", Object.entries(all).every(([t, n]) => FIRM_WIDE.has(t) || n === 0), JSON.stringify(all));
  const mgmt = await call(O.token, "GET", "/management");
  const aRow = (mgmt.body.consultants ?? []).find((c) => c.id === A.id);
  check("Management shows A with no students", aRow?.studentCount === 0, JSON.stringify(aRow));
  const hist = await call(O.token, "GET", "/management/transfers");
  check("the firm's history lists the three transfers", (hist.body ?? []).filter((t) => t.fromId === A.id).length === 3, JSON.stringify(hist.body).slice(0, 300));

  // 4) A plain Remove: A has no students, but made the firm's stage and still works a lead.
  r = await call(O.token, "DELETE", `/firms/mine/members/${A.id}`);
  check("the owner removes A", r.status === 204, `${r.status} ${JSON.stringify(r.body)}`);
  check("…A's stage and lead are the owner's now", (await sql(`select counselor_id from public.pipeline_stages where id = '${firm.stageId}'`)) === O.id && (await sql(`select counselor_id::text || '|' || owner_id::text from public.pipeline_contacts where id = '${firm.leadId}'`)) === `${O.id}|${O.id}`);
  check("…and the removal says so", (await sql(`select (metadata->>'pipeline_stages_to_owner') || '|' || (metadata->>'pipeline_contacts_to_owner') from public.audit_log where action = 'firm.member_removed' and entity_id = '${A.id}'`)) === "1|1");
  const aFiles = await storageAccess(A, students[5].files[0].path);
  check("…and A, out of the firm, still reads none of the moved files", !aFiles.read && !aFiles.listed && !aFiles.sign, JSON.stringify(aFiles));
  await signIn(A);
  const closed = await call(A.token, "DELETE", "/account", { confirm: "delete my account" });
  check("A closes the account", closed.status === 204, `${closed.status} ${JSON.stringify(closed.body)}`);
  check("…and the firm keeps the stage, both contacts and every moved student's files",
    (await sql(`select count(*) from public.pipeline_contacts where id in ('${firm.contactId}', '${firm.leadId}')`)) === "2" &&
      (await sql(`select count(*) from public.pipeline_stages where id = '${firm.stageId}'`)) === "1" &&
      Number(await sql(`select count(*) from public.documents where owner_id in ('${B.id}', '${O.id}') and storage_path like any (array[${students.map((s) => `'${s.id}/%'`).join(",")}])`)) === 30);
} finally {
  await cleanupFirm(firm);
}
