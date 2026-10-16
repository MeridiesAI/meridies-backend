import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("confirm");
const other = await user("confirm-other");
const s = await studentOf(c, "confirm-student");
const s2 = await studentOf(other, "confirm-other-student");

const unconfirmed = (studentId, owner, name) => sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind, kind_confirmed, available_to_llm, source, kind_guess)
  values ('${studentId}', '${owner}', 'x/${name}-${Date.now()}-${Math.random()}', '${name}', 'other', false, false, 'integration',
  '{"kind":"transcript","basis":"filename","matched":"transcript","textFound":false,"keepOut":false}') returning id) select id from d`);

const ten = [];
for (let i = 0; i < 10; i++) ten.push(await unconfirmed(s.id, c.id, `f${i}.pdf`));

// A skipped file is still excluded, and reported as one "not categorized" entry.
// GET /students/:id/ai-context answers { text, used, omitted }.
const ctx = await call(c.token, "GET", `/students/${s.id}/ai-context`);
const omitted = ctx.body?.omitted ?? [];
const nc = omitted.find((o) => o.section === "documents" && o.reason === "not-categorized");
check("unconfirmed files are one 'not categorized' entry with a count", nc?.count === 10, JSON.stringify(omitted));

const res = await call(c.token, "POST", "/files/documents/confirm-types", {
  items: ten.map((documentId, i) => ({ documentId, kind: i === 0 ? "financial" : "transcript", keepOut: i === 0 })),
});
check("confirm-all applies every row", res.status === 200 && res.body.results.length === 10 && res.body.results.every((r) => r.status === "confirmed"), JSON.stringify(res.body));
const rows = await sql(`select string_agg(kind || ':' || kind_confirmed::text || ':' || available_to_llm::text, ',' order by filename) from public.documents where id in (${ten.map((t) => `'${t}'`).join(",")})`);
check("each row has its kind, confirmed, and AI access from keepOut", rows.split(",")[0] === "financial:true:false" && rows.split(",").slice(1).every((r) => r === "transcript:true:true"), rows);

// Review Focus 4: one item the caller can't edit doesn't stop the rest.
const mine = await unconfirmed(s.id, c.id, "mine.pdf");
const theirs = await unconfirmed(s2.id, other.id, "theirs.pdf");
const mixed = await call(c.token, "POST", "/files/documents/confirm-types", {
  items: [{ documentId: theirs, kind: "transcript", keepOut: false }, { documentId: mine, kind: "resume", keepOut: false }],
});
const st = Object.fromEntries((mixed.body?.results ?? []).map((r) => [r.documentId, r.status]));
check("a refused item doesn't stop the rest", st[theirs] === "refused" && st[mine] === "confirmed", JSON.stringify(mixed.body));
check("the refused row is untouched", (await sql(`select kind_confirmed::text from public.documents where id = '${theirs}'`)) === "false");

const tooMany = await call(c.token, "POST", "/files/documents/confirm-types", { items: Array.from({ length: 51 }, () => ({ documentId: mine, kind: "resume", keepOut: false })) });
check("over 50 items is refused", tooMany.status === 400, `status ${tooMany.status}`);
const badKind = await call(c.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: mine, kind: "tax-return", keepOut: false }] });
check("an unknown kind is refused", badKind.status === 400, `status ${badKind.status}`);
const student = await call(s.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: mine, kind: "resume", keepOut: false }] });
check("a student can't confirm types", student.status === 403, `status ${student.status}`);

// "Couldn't read this file, try again": a failed file is re-queued; a scan (no text) is not a failure.
const failedDoc = await unconfirmed(s.id, c.id, "broken.pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'failed', parse_error = 'gave-up', extraction_attempts = 3 where id = '${failedDoc}'`);
const scanDoc = await unconfirmed(s.id, c.id, "scan.pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'skipped', parse_error = 'no-text' where id = '${scanDoc}'`);
const before = await call(c.token, "GET", `/files/documents/extraction-status?ids=${failedDoc},${scanDoc}`);
const states = Object.fromEntries((before.body ?? []).map((r) => [r.documentId, r.state]));
check("a scan and a failure are distinct states", states[failedDoc] === "failed" && states[scanDoc] === "empty", JSON.stringify(before.body));
const retry = await call(c.token, "POST", "/files/documents/extraction-retry", { ids: [failedDoc, scanDoc] });
check("retry re-queues only the failed file", retry.status === 200 && JSON.stringify(retry.body.retried) === JSON.stringify([failedDoc]), JSON.stringify(retry.body));
// The worker may already have claimed the re-queued row (it has no stored file, so it ends failed again at one
// attempt); either way the count restarted from the 3 it had given up at.
check("retry resets the attempts", Number(await sql(`select extraction_attempts::text from public.documents where id = '${failedDoc}'`)) <= 1);

const status = await call(c.token, "GET", `/files/documents/extraction-status?ids=${[mine, theirs].join(",")}`);
check("status omits files the caller can't see", status.status === 200 && status.body.length === 1 && status.body[0].documentId === mine, JSON.stringify(status.body));
