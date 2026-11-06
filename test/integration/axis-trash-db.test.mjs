// AxIS deletes are kept 30 days and restorable by the counselor who confirmed them (20261110000004, AxIS security
// PR B). The database side: a delete PostgREST runs with the x-meridies-axis-action header keeps its rows (and
// what cascades or is set null) in private.axis_trash; axis_trash_restore puts them back, deny by default.
import { randomUUID } from "node:crypto";
import { call, check, rest, serviceRpc, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const marked = (action) => ({ "x-meridies-axis-action": action, Prefer: "return=representation" });
const del = (token, path, action) => rest(token, "DELETE", `/rest/v1/${path}`, undefined, action ? marked(action) : {});
const restore = (token, action) => rest(token, "POST", "/rest/v1/rpc/axis_trash_restore", { p_action: action });
const trashed = (action) => sql(`select coalesce(string_agg(table_name || ':' || kind, ',' order by id), '') from private.axis_trash where action_id = '${action}'`);
const exists = async (table, id) => (await sql(`select count(*) from public.${table} where id = '${id}'`)) === "1";

const c = await user("trash-c");
const s = await studentOf(c, "trash-s");
const other = await user("trash-other");

async function task(title = "Draft the activities list") {
  const r = await call(c.token, "POST", "/tasks", { studentId: s.id, title, dueDate: "2026-12-01" });
  if (r.status !== 201) throw new Error(`task ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function deadline(title = "UC application") {
  const r = await call(c.token, "POST", "/deadlines", { studentId: s.id, title, type: "application", dueDate: "2026-11-30" });
  if (r.status !== 201) throw new Error(`deadline ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// ---- Capture ----
{
  const t = await task();
  const stage = await sql(`insert into public.deliverable_stages (deliverable_id, student_id, name, sequence) values ('${t}', '${s.id}', 'Outline', 0) returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  const r = await del(c.token, `deliverables?id=eq.${t}`, action);
  check("a marked delete goes through", r.status === 200 && Array.isArray(r.body) && r.body.length === 1, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  const kept = await trashed(action);
  check("a marked delete keeps the row and its cascade children", /^deliverables:delete/.test(kept) && kept.includes("deliverable_stages:delete"), kept);
  const by = await sql(`select string_agg(distinct deleted_by::text, ',') || '|' || string_agg(distinct coalesce(student_id::text, '-'), ',') from private.axis_trash where action_id = '${action}' and table_name = 'deliverables'`);
  check("it is kept as the deleter's, about the student", by === `${c.id}|${s.id}`, by);

  // ---- Restore ----
  const back = await restore(c.token, action);
  check("restore answers ok with what it brought back", back.status === 200 && back.body?.ok === true && back.body?.restored >= 2, JSON.stringify(back.body));
  check("restore puts rows back with the same ids, parents first", (await exists("deliverables", t)) && (await exists("deliverable_stages", stage)));
  const again = await restore(c.token, action);
  check("a second restore says it was already done", again.body?.ok === false && again.body?.reason === "already", JSON.stringify(again.body));
}

{
  // Counted by this row's id: other suites keep trash at the same time, so a table-wide count races them.
  const t = await task("Unmarked");
  await del(c.token, `deliverables?id=eq.${t}`);
  const kept = await sql(`select count(*) from private.axis_trash where row_data->>'id' = '${t}' or row_data->>'deliverable_id' = '${t}'`);
  check("an unmarked delete keeps nothing", !(await exists("deliverables", t)) && kept === "0", `still there: ${await exists("deliverables", t)}, kept ${kept}`);
}

// A cascade that sets a child's key to null (Review Focus 1): restore puts the old key back.
{
  const d = await deadline();
  const t = await task("Linked to the deadline");
  await sql(`update public.deliverables set deadline_id = '${d}' where id = '${t}'`);
  const action = randomUUID();
  await del(c.token, `deadlines?id=eq.${d}`, action);
  check("the set-null child is kept too", (await trashed(action)).includes("deliverables:set-null"), await trashed(action));
  check("and its key really went null", (await sql(`select coalesce(deadline_id::text, 'null') from public.deliverables where id = '${t}'`)) === "null");
  const back = await restore(c.token, action);
  const key = await sql(`select coalesce(deadline_id::text, 'null') from public.deliverables where id = '${t}'`);
  check("a set-null child gets its key back", back.body?.ok === true && key === d, `${JSON.stringify(back.body)} ${key}`);
}

// ---- Refusals ----
{
  const t = await task("Theirs to restore");
  const action = randomUUID();
  await del(c.token, `deliverables?id=eq.${t}`, action);
  const theirs = await restore(other.token, action);
  check("only the deleter can restore", theirs.body?.ok === false && theirs.body?.reason === "not-yours" && !(await exists("deliverables", t)), JSON.stringify(theirs.body));
  const nothing = await restore(c.token, randomUUID());
  check("an action with nothing kept is not the caller's", nothing.body?.ok === false && nothing.body?.reason === "not-yours", JSON.stringify(nothing.body));

  await sql(`update private.axis_trash set deleted_at = now() - interval '31 days' where action_id = '${action}'`);
  const late = await restore(c.token, action);
  check("restore after 30 days is refused", late.body?.ok === false && late.body?.reason === "expired", JSON.stringify(late.body));
}

{
  const t = await task("Comes back twice");
  const action = randomUUID();
  await del(c.token, `deliverables?id=eq.${t}`, action);
  await sql(`insert into public.deliverables select (jsonb_populate_record(null::public.deliverables, row_data)).* from private.axis_trash where action_id = '${action}' and table_name = 'deliverables'`);
  const clash = await restore(c.token, action);
  check("restore over an existing row is refused", clash.body?.ok === false && clash.body?.reason === "conflict", JSON.stringify(clash.body));
}

{
  // A trash row for a table restore has no access rule for: refused, nothing written.
  const action = randomUUID();
  await sql(`insert into private.axis_trash (action_id, table_name, row_pk, row_data, kind, deleted_by)
             values ('${action}', 'sms_opt_outs', '{"phone":"+15550001111"}', '{"phone":"+15550001111"}', 'delete', '${c.id}')`);
  const refused = await restore(c.token, action);
  check("a row from a table with no access rule is refused", refused.body?.ok === false && refused.body?.reason === "no-access", JSON.stringify(refused.body));
}

{
  const orphan = await sql(`select coalesce(string_agg(c.relname, ','), '') from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
                            where p.proname = 'axis_trash_capture' and c.relname not in (select table_name from private.axis_trash_rules)`);
  check("every table with the capture trigger has an access rule", orphan === "", orphan);
  const attached = await sql(`select count(distinct t.tgrelid) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'axis_trash_capture'`);
  check("the capture trigger is on the covered tables", Number(attached) >= 40, attached);
}

{
  const forger = await user("trash-forger");
  const fs = await studentOf(forger, "trash-forger-s");
  const r = await call(forger.token, "POST", "/deadlines", { studentId: fs.id, title: "Forger's own", type: "application", dueDate: "2026-11-30" });
  const action = randomUUID();
  await del(forger.token, `deadlines?id=eq.${r.body.id}`, action);
  const owner = await sql(`select string_agg(distinct deleted_by::text, ',') from private.axis_trash where action_id = '${action}'`);
  const stolen = await restore(c.token, action);
  check("a forged mark keeps only the forger's own rows", owner === forger.id && stolen.body?.ok === false && stolen.body?.reason === "not-yours", `${owner} ${JSON.stringify(stolen.body)}`);
}

{
  const revoked = await user("trash-revoked");
  const rs = await studentOf(revoked, "trash-revoked-s");
  const r = await call(revoked.token, "POST", "/deadlines", { studentId: rs.id, title: "Before the revoke", type: "application", dueDate: "2026-11-30" });
  const action = randomUUID();
  await del(revoked.token, `deadlines?id=eq.${r.body.id}`, action);
  await sql(`select private.revoke_counselor_access('${revoked.id}')`);
  const refused = await restore(revoked.token, action);
  check("a counselor whose approval was revoked can't restore", refused.body?.ok === false && refused.body?.reason === "not-approved", JSON.stringify(refused.body));
}

{
  for (const [path, headers] of [["/rest/v1/axis_trash?select=*", {}], ["/rest/v1/axis_trash?select=*", { "Accept-Profile": "private" }], ["/rest/v1/axis_trash_rules?select=*", { "Accept-Profile": "private" }]]) {
    const r = await rest(c.token, "GET", path, undefined, headers);
    check(`private trash isn't readable through PostgREST (${path.split("?")[0].split("/").pop()} ${headers["Accept-Profile"] ?? "public"})`, r.status >= 400 && !Array.isArray(r.body), `status ${r.status}`);
  }
}

// ---- Sequences: an active enrollment comes back paused, so restoring sends nothing ----
{
  const board = (await call(c.token, "GET", "/pipeline")).body;
  const contact = await call(c.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: "Ada Lovelace", parentEmail: `ada-${Date.now()}@families.test` });
  const seq = await call(c.token, "POST", "/pipeline/sequences", { name: `Drip ${Date.now()}`, sendHour: 9, steps: [{ offsetDays: 1, to: "parent", subject: "Hi", body: "Hello." }] });
  const enrolled = await call(c.token, "POST", `/pipeline/contacts/${contact.body.id}/sequences`, { sequenceId: seq.body.id });
  const enrollmentId = enrolled.body?.id ?? (await sql(`select id from public.pipeline_sequence_enrollments where contact_id = '${contact.body.id}'`));
  const action = randomUUID();
  await del(c.token, `pipeline_contacts?id=eq.${contact.body.id}`, action);
  const back = await restore(c.token, action);
  const status = await sql(`select coalesce((select status from public.pipeline_sequence_enrollments where id = '${enrollmentId}'), 'missing')`);
  check("an active sequence enrollment comes back paused", back.body?.ok === true && status === "paused" && (back.body?.paused ?? []).includes("pipeline_sequence_enrollments"), `${JSON.stringify(back.body)} ${status}`);
  const created = await sql(`select count(*) from public.pipeline_activities where contact_id = '${contact.body.id}' and kind = 'created'`);
  check("restoring the contact doesn't log it as created twice", created === "1", created);
}

// ---- Purge and forget (service role) ----
{
  const path = `${s.id}/trash-${Date.now()}.pdf`;
  const doc = await sql(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by)
                         values ('${c.id}', '${s.id}', 'Old transcript.pdf', 'student-documents', '${path}', 'application/pdf', 10, '${c.id}') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `documents?id=eq.${doc}`, action);
  await sql(`update private.axis_trash set deleted_at = now() - interval '31 days' where action_id = '${action}'`);
  const purged = await serviceRpc("axis_trash_purge", {});
  const objects = Array.isArray(purged.body?.objects) ? purged.body.objects : [];
  check("purge removes rows past 30 days and counts them", (await sql(`select count(*) from private.axis_trash where action_id = '${action}'`)) === "0" && Number(purged.body?.rows) >= 1, `status ${purged.status} ${JSON.stringify(purged.body).slice(0, 120)}`);
  check("and returns the kept document objects", objects.some((o) => o.bucket === "student-documents" && o.storage_path === path), JSON.stringify(objects).slice(0, 200));

  const gone = await user("trash-gone");
  const gs = await studentOf(gone, "trash-gone-s");
  const r = await call(gone.token, "POST", "/deadlines", { studentId: gs.id, title: "Forgotten", type: "application", dueDate: "2026-11-30" });
  const a2 = randomUUID();
  await del(gone.token, `deadlines?id=eq.${r.body.id}`, a2);
  const forgot = await serviceRpc("axis_trash_forget", { p_user: gone.id });
  check("forget removes the trash someone made", forgot.status === 200 && (await sql(`select count(*) from private.axis_trash where action_id = '${a2}'`)) === "0", `status ${forgot.status}`);
  const denied = await rest(c.token, "POST", "/rest/v1/rpc/axis_trash_purge", {});
  check("a signed-in user can't purge", denied.status === 401 || denied.status === 403 || denied.status === 404, `status ${denied.status}`);
}

// ---- Checkpoint review fixes ----
const studentMoved = async (tag) => {
  const owner = await user(`${tag}-c`);
  const st = await studentOf(owner, `${tag}-s`);
  const next = await user(`${tag}-next`);
  return { owner, st, move: () => sql(`update public.profiles set counselor_id = '${next.id}' where id = '${st.id}'`) };
};

// Every row about a student needs the restorer to still be able to edit that student, whatever its table's rule.
for (const [label, insert, path] of [
  ["a work item", (o, st) => `insert into public.counselor_work_items (counselor_id, student_id, title) values ('${o.id}', '${st.id}', 'Call home') returning id`, "counselor_work_items"],
  ["a referral", (o, st) => `insert into public.referrals (from_student_id, counselor_id) values ('${st.id}', '${o.id}') returning id`, "referrals"],
  ["a calendar event", (o, st) => `insert into public.calendar_events (owner_id, student_id, title, on_date) values ('${o.id}', '${st.id}', 'Visit', '2026-12-05') returning id`, "calendar_events"],
]) {
  const m = await studentMoved(`trash-gate-${path.slice(0, 6)}`);
  const id = await sql(insert(m.owner, m.st)).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(m.owner.token, `${path}?id=eq.${id}`, action);
  await m.move();
  const refused = await restore(m.owner.token, action);
  check(`${label} about a student moved to another counselor isn't restored`, refused.body?.ok === false && refused.body?.reason === "no-access" && !(await exists(path, id)), JSON.stringify(refused.body));
}
{
  const kept = await sql(`select count(*) from private.axis_trash where table_name = 'referrals' and student_id is not null`);
  check("a referral's trash row knows its student (for account deletion)", Number(kept) >= 1, kept);
}

// The purge keeps a file a later trash entry still needs.
{
  const path = `${s.id}/twice-${Date.now()}.pdf`;
  const docId = await sql(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by)
                           values ('${c.id}', '${s.id}', 'Twice.pdf', 'student-documents', '${path}', 'application/pdf', 10, '${c.id}') returning id`).then((o) => o.split("\n")[0]);
  const first = randomUUID();
  await del(c.token, `documents?id=eq.${docId}`, first);
  await restore(c.token, first);
  const second = randomUUID();
  await del(c.token, `documents?id=eq.${docId}`, second);
  await sql(`update private.axis_trash set deleted_at = now() - interval '31 days' where action_id = '${first}'`);
  const purged = await serviceRpc("axis_trash_purge", {});
  const objects = Array.isArray(purged.body?.objects) ? purged.body.objects : null;
  check("the purge keeps a file a later trash entry still needs", objects !== null && !objects.some((o) => o.storage_path === path), JSON.stringify(purged.body).slice(0, 200));
}

// Parents come back first whatever order the rows were kept in.
{
  const t = await task("Order");
  await sql(`insert into public.deliverable_stages (deliverable_id, student_id, name, sequence) values ('${t}', '${s.id}', 'Step', 0)`);
  const first = randomUUID();
  await del(c.token, `deliverables?id=eq.${t}`, first);
  const reversed = randomUUID();
  await sql(`insert into private.axis_trash (action_id, table_name, row_pk, row_data, kind, student_id, deleted_by)
             select '${reversed}', table_name, row_pk, row_data, kind, student_id, deleted_by from private.axis_trash where action_id = '${first}' order by id desc`);
  await sql(`delete from private.axis_trash where action_id = '${first}'`);
  const back = await restore(c.token, reversed);
  check("parents come back first whatever order they were kept in", back.body?.ok === true && (await exists("deliverables", t)), JSON.stringify(back.body));
}

// A key set null isn't put back over what the counselor set since.
{
  const f = await sql(`insert into public.folders (owner_id, student_id, name) values ('${c.id}', '${s.id}', 'Old folder ${Date.now()}') returning id`).then((o) => o.split("\n")[0]);
  const g = await sql(`insert into public.folders (owner_id, student_id, name) values ('${c.id}', '${s.id}', 'New folder ${Date.now()}') returning id`).then((o) => o.split("\n")[0]);
  const d = await sql(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by, folder_id)
                       values ('${c.id}', '${s.id}', 'Moved.pdf', 'student-documents', '${s.id}/moved-${Date.now()}.pdf', 'application/pdf', 10, '${c.id}', '${f}') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `folders?id=eq.${f}`, action);
  await sql(`update public.documents set folder_id = '${g}' where id = '${d}'`);
  const back = await restore(c.token, action);
  const where = await sql(`select folder_id from public.documents where id = '${d}'`);
  check("a key set null isn't put back over what was set since", back.body?.ok === true && where === g, `${JSON.stringify(back.body)} ${where}`);
}

// A student's linked (Drive) file comes back for the counselor who deleted it.
{
  const d = await sql(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by, external_provider, external_file_id)
                       values ('${s.id}', '${s.id}', 'Linked.pdf', 'student-documents', '${s.id}/linked-${Date.now()}.pdf', 'application/pdf', 10, '${s.id}', 'google', 'file-${Date.now()}') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `documents?id=eq.${d}`, action);
  const back = await restore(c.token, action);
  check("a student's linked file comes back for the counselor who deleted it", back.body?.ok === true && (await exists("documents", d)), JSON.stringify(back.body));
}

// A restored meeting doesn't point at the calendar event its delete removed.
{
  const m = await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at, ends_at, calendar_provider, calendar_event_id)
                       values ('${s.id}', '${c.id}', 'Synced', now() + interval '2 days', now() + interval '2 days 30 minutes', 'google', 'evt-${Date.now()}') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `meetings?id=eq.${m}`, action);
  const back = await restore(c.token, action);
  const pointer = await sql(`select coalesce(calendar_provider, 'null') || '|' || coalesce(calendar_event_id, 'null') from public.meetings where id = '${m}'`);
  check("a restored meeting doesn't point at the calendar event its delete removed", back.body?.ok === true && pointer === "null|null", `${JSON.stringify(back.body)} ${pointer}`);
}

// Restoring a school the student had enrolled in doesn't change the one they chose since.
{
  const a = await sql(`insert into public.student_colleges (student_id, name, status) values ('${s.id}', 'First choice ${Date.now()}', 'enrolled') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `student_colleges?id=eq.${a}`, action);
  const b = await sql(`insert into public.student_colleges (student_id, name, status) values ('${s.id}', 'Second choice ${Date.now()}', 'enrolled') returning id`).then((o) => o.split("\n")[0]);
  const back = await restore(c.token, action);
  const states = await sql(`select (select status from public.student_colleges where id = '${a}') || '|' || (select status from public.student_colleges where id = '${b}')`);
  check("restoring an enrolled school keeps the one chosen since", back.body?.ok === true && states === "accepted|enrolled", `${JSON.stringify(back.body)} ${states}`);
}

// Every trigger that skips during a restore still does; the service role can't restore.
{
  const guarded = await sql(`select count(*) from pg_trigger where not tgisinternal and pg_get_triggerdef(oid) ilike '%meridies.axis_restore%'`);
  check("every trigger that must skip during a restore does", Number(guarded) === 19, guarded);
  const svcRestore = await serviceRpc("axis_trash_restore", { p_action: randomUUID() });
  check("the service role can't restore", svcRestore.status === 401 || svcRestore.status === 403 || svcRestore.status === 404, `status ${svcRestore.status}`);
}

// A row that goes with its parent comes back with it, whoever owns it: a student's saved copy of the counselor's event.
{
  const ev = await sql(`insert into public.hub_events (name, kind, host, start_date, url, created_by) values ('Open house ${Date.now()}', 'webinar', 'Our practice', '2026-12-12', 'https://example.org/open', '${c.id}') returning id`).then((o) => o.split("\n")[0]);
  await sql(`insert into public.hub_event_saves (event_id, profile_id, targets) values ('${ev}', '${s.id}', '{meridies}')`);
  const action = randomUUID();
  await del(c.token, `hub_events?id=eq.${ev}`, action);
  const back = await restore(c.token, action);
  const saves = await sql(`select count(*) from public.hub_event_saves where event_id = '${ev}' and profile_id = '${s.id}'`);
  check("someone else's saved copy comes back with the event", back.body?.ok === true && saves === "1", `${JSON.stringify(back.body)} saves=${saves}`);
}

// ---- Whole-branch review ----

// Every row a covered delete reaches is kept: no table that cascades from, or is set null by, a captured table is
// missing its capture trigger (a later migration adding one would otherwise lose rows for good on a restore).
{
  const missed = await sql(`
    with captured as (
      select distinct c.oid from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = 'zz_axis_trash_delete' and c.relnamespace = 'public'::regnamespace
    ),
    fks as (
      select ch.relname::text as child, k.conrelid, k.confdeltype::text as action,
             (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
              where a.attrelid = k.conrelid and a.attnum = any(coalesce(k.confdelsetcols, k.conkey))) as cols
      from pg_constraint k join captured p on p.oid = k.confrelid join pg_class ch on ch.oid = k.conrelid
      where k.contype = 'f' and k.confdeltype in ('c', 'n') and ch.relnamespace = 'public'::regnamespace
    )
    select coalesce(string_agg(child || ':' || action || ':' || cols, ', '), '') from fks f
    where (action = 'c' and not exists (select 1 from pg_trigger t where t.tgrelid = f.conrelid and t.tgname = 'zz_axis_trash_delete'))
       or (action = 'n' and not exists (
             select 1 from pg_trigger t where t.tgrelid = f.conrelid and t.tgname = 'zz_axis_trash_set_null'
               and pg_get_triggerdef(t.oid) ~ ('UPDATE OF [^O]*\\m' || f.cols || '\\M')))`);
  check("every child row a covered delete reaches is kept", missed === "", missed);
}

// A restored task gets its delivery records back, so a due-tomorrow reminder already sent isn't sent again.
{
  const t = await task("Reminded");
  const delivery = await sql(`insert into public.message_deliveries (student_id, recipient_kind, recipient_id, channel, provider, status, template, deliverable_id, to_email)
                              values ('${s.id}', 'student', '${s.id}', 'email', 'resend', 'sent', 'task-due-reminder:2026-12-01', '${t}', 's@example.com') returning id`).then((o) => o.split("\n")[0]);
  const action = randomUUID();
  await del(c.token, `deliverables?id=eq.${t}`, action);
  const back = await restore(c.token, action);
  const linked = await sql(`select coalesce(deliverable_id::text, 'null') from public.message_deliveries where id = '${delivery}'`);
  check("a restored task gets its delivery records back", back.body?.ok === true && linked === t, `${JSON.stringify(back.body)} ${linked}`);
}
