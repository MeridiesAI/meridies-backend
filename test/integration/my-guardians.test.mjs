// A student's own parents (/me/guardians, 20261122000001), against the real database and API.
// The rows are the counselor's guardians, so what must hold is: the student's addition shows on the counselor's
// screens (composer family, Parent contacts) labelled as theirs; a student touches only what they added, and never
// the address of a parent the counselor switched on; nothing a client sends sets who added a row; and the parent
// is emailed once per address. Each case is tried straight through PostgREST too, the way an attacker would.
import { API, CLIENT, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now().toString(36);
const c = await user("mg-counselor");
const s = await studentOf(c, "mg-student");
const other = await studentOf(c, "mg-other");
await sql(`update public.profiles set full_name = 'Maya Lee' where id = '${s.id}'`);
await sql(`update public.profiles set full_name = 'Jordan Park' where id = '${c.id}'`);
const one = (q) => sql(q);
const momEmail = `mom-${tag}@example.test`;

// ---- add ---------------------------------------------------------------------------------------------
const add = await call(s.token, "POST", "/me/guardians", { name: "Ana Ruiz", relationship: "Mother", email: momEmail.toUpperCase(), phone: "555 010 2000" });
const g = add.body?.guardian;
check("student adds a parent", add.status === 201 && g?.email === momEmail && g?.addedByMe === true && g?.editable === "all", `${add.status} ${JSON.stringify(add.body).slice(0, 200)}`);
check("…stamped as added by the student, alerts off", (await one(`select added_by::text || ':' || alerts_enabled from public.guardians where id = '${g?.id}'`)) === `${s.id}:false`);
check("…and the parent is emailed (delivery recorded, its own template)", add.body?.notice === "sent" && (await one(`select count(*) from public.message_deliveries where student_id = '${s.id}' and template = 'parent-added' and to_email = '${momEmail}' and recipient_kind = 'guardian' and recipient_id = '${g?.id}'`)) === "1", `notice ${add.body?.notice}`);

// ---- the counselor sees them ---------------------------------------------------------------------------
const composer = await call(c.token, "GET", `/communication/${s.id}/composer`);
const fam = composer.body?.family?.find((f) => f.id === g?.id);
check("counselor's Communication page lists the parent, labelled as the student's", composer.status === 200 && fam?.email === momEmail && fam?.addedByStudent === true && fam?.receivesMessages === false, JSON.stringify(fam));
const roster = await call(c.token, "GET", `/guardians/roster?q=${encodeURIComponent(momEmail)}`);
const entry = roster.body?.guardians?.find((r) => r.id === g?.id);
check("…and Parent contacts, with the email", roster.status === 200 && entry?.email === momEmail && entry?.addedByStudent === true, JSON.stringify(entry));

// ---- the student fixes their own addition (before the counselor switches it on) ---------------------------
const fix = await call(s.token, "PATCH", `/me/guardians/${g?.id}`, { phone: "555 010 3000", name: "Ana M. Ruiz" });
check("student edits their own parent", fix.status === 200 && fix.body?.guardian?.phone === "555 010 3000" && fix.body?.notice === null, JSON.stringify(fix.body).slice(0, 160));
const forged = await rest(s.token, "PATCH", `/rest/v1/guardians?id=eq.${g?.id}`, { alerts_enabled: true, added_by: c.id, is_primary: true, receives_reports: false }, { Prefer: "return=representation" });
check("PostgREST: the student can't switch alerts on, take primary or rewrite who added it", (await one(`select alerts_enabled || ':' || is_primary || ':' || receives_reports || ':' || added_by from public.guardians where id = '${g?.id}'`)) === `false:false:true:${s.id}`, `status ${forged.status}`);
const forgedInsert = await rest(s.token, "POST", "/rest/v1/guardians", { student_id: s.id, full_name: "Forged", email: `forged-${tag}@example.test`, added_by: c.id, alerts_enabled: true }, { Prefer: "return=representation" });
const fid = Array.isArray(forgedInsert.body) ? forgedInsert.body[0]?.id : null;
check("PostgREST: an insert can't claim the counselor added it, nor switch itself on", (await one(`select coalesce(added_by::text, 'null') || ':' || alerts_enabled from public.guardians where id = '${fid}'`)) === `${s.id}:false`, `status ${forgedInsert.status}`);
if (fid) await sql(`delete from public.guardians where id = '${fid}'`);

// ---- once the counselor switches it on, the address is theirs ----------------------------------------------
const on = await call(c.token, "PATCH", `/accountability/guardians/${g?.id}`, { alerts_enabled: true });
check("counselor switches the parent on", on.status === 200);
const redirect = await call(s.token, "PATCH", `/me/guardians/${g?.id}`, { email: `me-${tag}@student.test` });
check("API: the student can't redirect a switched-on parent", redirect.status === 403 && redirect.body?.code === "guardian_contact_locked", JSON.stringify(redirect.body));
const redirectDirect = await rest(s.token, "PATCH", `/rest/v1/guardians?id=eq.${g?.id}`, { email: `me-${tag}@student.test` });
check("PostgREST: nor straight through the table", redirectDirect.status >= 400 && (await one(`select email from public.guardians where id = '${g?.id}'`)) === momEmail, `status ${redirectDirect.status}`);
const rename = await call(s.token, "PATCH", `/me/guardians/${g?.id}`, { name: "Ana Ruiz" });
check("…but can still correct the name", rename.status === 200 && rename.body?.guardian?.editable === "name");
const delOn = await call(s.token, "DELETE", `/me/guardians/${g?.id}`);
await rest(s.token, "DELETE", `/rest/v1/guardians?id=eq.${g?.id}`);
check("the student can't remove a switched-on parent (API or PostgREST)", delOn.status === 403 && (await one(`select count(*) from public.guardians where id = '${g?.id}'`)) === "1", `status ${delOn.status}`);

// ---- a parent the counselor added is read-only to the student -------------------------------------------
const cAdd = await call(c.token, "POST", "/accountability/guardians", { studentId: s.id, full_name: "Luis Ruiz", email: `dad-${tag}@example.test` });
const cg = cAdd.body?.id;
check("counselor-added rows record the counselor", (await one(`select added_by from public.guardians where id = '${cg}'`)) === c.id, `status ${cAdd.status}`);
const mine = await call(s.token, "GET", "/me/guardians");
const dad = mine.body?.guardians?.find((x) => x.id === cg);
check("the student sees the counselor's parent, read-only", mine.status === 200 && dad?.addedByMe === false && dad?.editable === "none" && dad?.removable === false, JSON.stringify(dad));
const lockedEdit = await call(s.token, "PATCH", `/me/guardians/${cg}`, { name: "Changed" });
const directEdit = await rest(s.token, "PATCH", `/rest/v1/guardians?id=eq.${cg}`, { full_name: "Changed", email: `me-${tag}@student.test` });
await rest(s.token, "DELETE", `/rest/v1/guardians?id=eq.${cg}`);
check("…the API refuses (guardian_locked) and PostgREST changes nothing", lockedEdit.status === 403 && lockedEdit.body?.code === "guardian_locked" && (await one(`select full_name || ':' || email from public.guardians where id = '${cg}'`)) === `Luis Ruiz:dad-${tag}@example.test`, `status ${lockedEdit.status}/${directEdit.status}`);

// ---- another student --------------------------------------------------------------------------------
const theirs = await call(other.token, "GET", "/me/guardians");
check("another student lists none of these", theirs.status === 200 && Array.isArray(theirs.body?.guardians) && theirs.body.guardians.length === 0);
const theirsEdit = await call(other.token, "PATCH", `/me/guardians/${g?.id}`, { name: "x" });
const theirsDirect = await rest(other.token, "PATCH", `/rest/v1/guardians?id=eq.${g?.id}`, { full_name: "x" });
await rest(other.token, "DELETE", `/rest/v1/guardians?id=eq.${g?.id}`);
check("…and can't touch them", theirsEdit.status === 404 && (await one(`select full_name from public.guardians where id = '${g?.id}'`)) === "Ana Ruiz", `status ${theirsEdit.status}/${theirsDirect.status}`);
const counselorUse = await call(c.token, "GET", "/me/guardians");
check("counselors don't use /me/guardians", counselorUse.status === 403);

// ---- remove and add again: one email per address ------------------------------------------------------
const step = await call(s.token, "POST", "/me/guardians", { name: "Sam Step", relationship: "Guardian", email: `step-${tag}@example.test` });
const sg = step.body?.guardian?.id;
const removed = await call(s.token, "DELETE", `/me/guardians/${sg}`);
check("student removes a parent they added", removed.status === 200 && (await one(`select count(*) from public.guardians where id = '${sg}'`)) === "0");
const back = await call(s.token, "POST", "/me/guardians", { name: "Sam Step", relationship: "Guardian", email: `step-${tag}@example.test` });
check("added again: no second email", back.status === 201 && back.body?.notice === "already_sent" && (await one(`select count(*) from public.message_deliveries where student_id = '${s.id}' and template = 'parent-added' and to_email = 'step-${tag}@example.test'`)) === "1", `notice ${back.body?.notice}`);

// ---- the cap and the duplicates -----------------------------------------------------------------------
const dup = await call(s.token, "POST", "/me/guardians", { name: "Ana again", relationship: "Mother", email: momEmail });
check("an address already on the list is refused", dup.status === 409 && dup.body?.code === "guardian_exists");
// On file now: Ana, Luis, Sam = 3. One more fits, the fifth doesn't.
const fourth = await call(s.token, "POST", "/me/guardians", { name: "Gran", relationship: "Other", email: `gran-${tag}@example.test` });
const fifth = await call(s.token, "POST", "/me/guardians", { name: "Too many", relationship: "Other", email: `five-${tag}@example.test` });
check("four parents in all", fourth.status === 201 && fifth.status === 409 && fifth.body?.code === "guardians_full", `${fourth.status}/${fifth.status}`);

const bad = await fetch(`${API}/me/guardians`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", relationship: "Mother", email: "nope" }) });
check("validation: a bad email is a 400", bad.status === 400);
