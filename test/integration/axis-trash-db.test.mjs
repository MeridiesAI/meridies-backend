// AxIS deletes are kept 30 days and restorable by the counselor who confirmed them (20261108000003, AxIS security
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
  const t = await task("Unmarked");
  const before = await sql("select count(*) from private.axis_trash");
  await del(c.token, `deliverables?id=eq.${t}`);
  check("an unmarked delete keeps nothing", (await sql("select count(*) from private.axis_trash")) === before);
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
  const objects = Array.isArray(purged.body) ? purged.body : [];
  check("purge removes rows past 30 days", (await sql(`select count(*) from private.axis_trash where action_id = '${action}'`)) === "0", `status ${purged.status}`);
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
