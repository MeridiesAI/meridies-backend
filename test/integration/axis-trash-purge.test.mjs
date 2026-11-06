// The AxIS trash's upkeep (20261108000003, AxIS security PR B): the scheduled sweep purges what's past 30 days with
// the files it kept, at most once an hour (the axis-trash-purge lease); deleting an account removes the trash it
// made and the trash about it; the data export carries no trash.
import { randomUUID } from "node:crypto";
import { API, CRON_SECRET, SB, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const one = (q) => sql(q).then((o) => o.split("\n")[0]);
const marked = (action) => ({ "x-meridies-axis-action": action, Prefer: "return=representation" });
const del = (token, path, action) => rest(token, "DELETE", `/rest/v1/${path}`, undefined, marked(action));
const cron = (path) => fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const kept = (action, extra = "") => one(`select count(*) from private.axis_trash where action_id = '${action}' ${extra}`);
const objects = (path) => one(`select count(*) from storage.objects where bucket_id = 'student-documents' and name = '${path}'`);
const age = (action) => sql(`update private.axis_trash set deleted_at = now() - interval '31 days' where action_id = '${action}'`);

async function docFor(owner, student, name = "essay.pdf") {
  const path = `${student.id}/purge-${randomUUID()}-${name}`;
  const up = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/pdf" }, body: Buffer.from("%PDF-1.4 test"),
  });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  const id = await one(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by)
                        values ('${owner.id}', '${student.id}', '${name}', 'student-documents', '${path}', 'application/pdf', 13, '${owner.id}') returning id`);
  return { id, path };
}
async function deleteDoc(owner, d) {
  const action = randomUUID();
  const r = await del(owner.token, `documents?id=eq.${d.id}`, action);
  if (r.status !== 200) throw new Error(`delete document ${r.status} ${JSON.stringify(r.body)}`);
  return action;
}
const course = (student, name) => one(`insert into public.courses (student_id, name) values ('${student.id}', '${name}') returning id`);
const event = (by) => one(`insert into public.hub_events (name, kind, host, start_date, url, created_by) values ('Info night ${randomUUID().slice(0, 6)}', 'webinar', 'Our practice', '2026-12-14', 'https://example.org/info', '${by.id}') returning id`);

const c = await user("purge-c");
const s = await studentOf(c, "purge-s");

// ---- The hourly purge ----
{
  const old = await docFor(c, s);
  const oldAction = await deleteDoc(c, old);
  await age(oldAction);
  const freshAction = randomUUID();
  await del(c.token, `courses?id=eq.${await course(s, "AP Statistics")}`, freshAction);
  await sql(`delete from private.job_leases where name = 'axis-trash-purge'`);

  const r = await cron("/internal/accountability/sweep");
  const [left, file, fresh] = [await kept(oldAction), await objects(old.path), await kept(freshAction)];
  check("the sweep purges trash past 30 days and its kept files", r.status === 200 && left === "0" && file === "0" && fresh === "1",
    `sweep ${r.status} left=${left} file=${file} fresh=${fresh}`);

  const later = await docFor(c, s);
  const laterAction = await deleteDoc(c, later);
  await age(laterAction);
  const again = await cron("/internal/accountability/sweep");
  const [stillLeft, stillFile] = [await kept(laterAction), await objects(later.path)];
  check("the purge runs at most once an hour", again.status === 200 && stillLeft === "1" && stillFile === "1", `sweep ${again.status} left=${stillLeft} file=${stillFile}`);
  const lease = await one(`select (expires_at > now() + interval '50 minutes')::text from private.job_leases where name = 'axis-trash-purge'`);
  check("the purge holds its lease for the hour", lease === "true", lease);
}

// ---- Account deletion ----
{
  const c2 = await user("purge-forget-c");
  const s2 = await studentOf(c2, "purge-forget-s");
  const d = await docFor(c2, s2);
  const docAction = await deleteDoc(c2, d);
  const courseAction = randomUUID();
  await del(c2.token, `courses?id=eq.${await course(s2, "AP Spanish")}`, courseAction);
  const ev = await event(c2);
  await sql(`insert into public.hub_event_saves (event_id, profile_id, targets) values ('${ev}', '${s2.id}', '{meridies}')`);
  const eventAction = randomUUID();
  await del(c2.token, `hub_events?id=eq.${ev}`, eventAction);

  const gone = await call(s2.token, "DELETE", "/account", { confirm: "delete my account" });
  const about = await one(`select count(*) from private.axis_trash where action_id in ('${docAction}', '${courseAction}') or (action_id = '${eventAction}' and table_name = 'hub_event_saves')`);
  const file = await objects(d.path);
  check("deleting an account removes the trash about it and the files it kept", gone.status === 204 && about === "0" && file === "0",
    `${gone.status} ${JSON.stringify(gone.body ?? null).slice(0, 120)} about=${about} file=${file}`);
  check("and keeps others' trash that doesn't name it", (await kept(eventAction, "and table_name = 'hub_events'")) === "1");

  const c3 = await user("purge-forget-c3");
  const madeAction = randomUUID();
  await del(c3.token, `hub_events?id=eq.${await event(c3)}`, madeAction);
  const gone3 = await call(c3.token, "DELETE", "/account", { confirm: "delete my account" });
  check("deleting an account removes the trash it made", gone3.status === 204 && (await kept(madeAction)) === "0", `${gone3.status} ${JSON.stringify(gone3.body ?? null).slice(0, 120)}`);
}

// ---- Export ----
{
  const id = await course(s, "AP Art History");
  await del(c.token, `courses?id=eq.${id}`, randomUUID());
  const mine = await call(c.token, "GET", "/account/export");
  const theirs = await call(s.token, "GET", "/account/export");
  const text = JSON.stringify([mine.body, theirs.body]);
  check("the data export carries no trash", mine.status === 200 && theirs.status === 200 && !text.includes("axis_trash") && !text.includes(id),
    `${mine.status} ${theirs.status}`);
}
