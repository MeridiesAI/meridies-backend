// Fixtures for the import-pipeline suites. Everything here writes as the
// postgres superuser through psql, the way step 2's staging code will write
// as the backend: the browser never inserts items or changes.
import { ANON, SB, call, sql, user } from "./harness.mjs";

export const q = (s) => String(s).replace(/'/g, "''");
export const lit = (v) => (v === null || v === undefined ? "null" : `'${q(JSON.stringify(v))}'::jsonb`);

/** A student account on `counselor`'s roster. */
export async function studentOf(counselor, tag = "student") {
  const s = await user(tag, "student");
  await sql(`update public.profiles set counselor_id = '${counselor.id}' where id = '${s.id}'`);
  return s;
}

/** A firm owned by `owner`, with `members` (seat 'counselor'); profiles.firm_id set for all. */
export async function firmWith(owner, members = []) {
  const firmId = await sql(`with f as (insert into public.firms (name, owner_id) values ('Test firm ${Date.now()}', '${owner.id}') returning id) select id from f`);
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${owner.id}', 'owner') on conflict do nothing`);
  for (const m of members) {
    await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${m.id}', 'counselor') on conflict do nothing`);
  }
  await sql(`update public.profiles set firm_id = '${firmId}' where id in (${[owner, ...members].map((u) => `'${u.id}'`).join(",")})`);
  return firmId;
}

/** A new-pipeline import in `status` (default 'review'). */
export async function makeImport(counselor, { status = "review", sourceSystem = "unknown" } = {}) {
  return sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status, source_system)
    values ('${counselor.id}', 'test.csv', 'csv', '${status}', '${sourceSystem}') returning id) select id from i`);
}

/** An item matched to `studentId` (or a new_invite when studentId is null). */
export async function addItem(importId, { studentId = null, status = "matched_email", name = "Test Student", invitationId = null } = {}) {
  return sql(`with i as (insert into public.import_items (import_id, match_status, student_id, invitation_id, imported_name, match_confidence)
    values ('${importId}', '${status}', ${studentId ? `'${studentId}'` : "null"}, ${invitationId ? `'${invitationId}'` : "null"}, '${q(name)}', 'high') returning id) select id from i`);
}

/**
 * A staged change. old_value is read from the database the way staging will
 * (private.import_current_value), unless `oldValue` is given explicitly.
 */
export async function addChange(importId, itemId, { target, field, value, op = "set_field", decision = "accept", studentId = null, oldValue }) {
  const old =
    oldValue !== undefined
      ? lit(oldValue)
      : op === "set_field" && studentId
        ? `private.import_current_value('${target}', '${field}', '${studentId}')`
        : "null";
  return sql(`with c as (insert into public.import_changes (import_id, item_id, target_table, field, op, old_value, new_value, decision, source_ref)
    values ('${importId}', '${itemId}', '${target}', '${field}', '${op}', ${old}, ${lit(value)}, '${decision}', 'Sheet1!A1') returning id) select id from c`);
}

export async function importRow(importId) {
  return JSON.parse(await sql(`select row_to_json(i) from public.roster_imports i where id = '${importId}'`));
}

export async function changeRow(changeId) {
  return JSON.parse(await sql(`select row_to_json(c) from public.import_changes c where id = '${changeId}'`));
}

export async function academics(studentId) {
  const raw = await sql(`select row_to_json(a) from public.student_academics a where student_id = '${studentId}'`);
  return raw ? JSON.parse(raw) : null;
}

// ---- step 2 ------------------------------------------------------------------

/** PUT bytes to a signed upload URL, as uploadToSignedUrl does. */
export async function putSigned(token, path, uploadToken, bytes, mime) {
  const r = await fetch(`${SB}/storage/v1/object/upload/sign/imports/${path}?token=${encodeURIComponent(uploadToken)}`, {
    method: "PUT",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": mime, "x-upsert": "false" },
    body: bytes,
  });
  return { status: r.status, body: await r.text() };
}

/** upload-url -> PUT -> register. Returns the register response. */
export async function addImportFile(user, importId, name, bytes, mime = "text/csv") {
  const u = await call(user.token, "POST", `/imports/${importId}/files/upload-url`, { fileName: name, mimeType: mime, sizeBytes: bytes.length });
  if (u.status !== 200) return { stage: "upload-url", ...u };
  const put = await putSigned(user.token, u.body.path, u.body.token, bytes, mime);
  if (put.status !== 200) return { stage: "put", ...put };
  return call(user.token, "POST", `/imports/${importId}/files`, { fileId: u.body.fileId, path: u.body.path, fileName: name });
}

/** Wait for GET /imports/:id to leave a status. */
export async function waitStatus(token, id, leaving) {
  for (let i = 0; i < 80; i++) {
    const r = await call(token, "GET", `/imports/${id}`);
    if (r.body?.status !== leaving) return r.body;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`timed out waiting for import ${id} to leave ${leaving}`);
}

export const enc = (s) => new TextEncoder().encode(s);
