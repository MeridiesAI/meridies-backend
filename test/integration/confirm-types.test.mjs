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
const beforeRetry = await sql(`select clock_timestamp()::text`);
const retry = await call(c.token, "POST", "/files/documents/extraction-retry", { ids: [failedDoc, scanDoc] });
check("retry re-queues only the failed file", retry.status === 200 && JSON.stringify(retry.body.retried) === JSON.stringify([failedDoc]), JSON.stringify(retry.body));
// The worker may already have claimed the re-queued row (no stored file, so it ends failed again); either way
// the count restarted from the 3 it had given up at, and the request is newer than the retry call.
check("retry resets the attempts", Number(await sql(`select extraction_attempts::text from public.documents where id = '${failedDoc}'`)) < 3
  && (await sql(`select (extraction_requested_at is null or extraction_requested_at >= '${beforeRetry}'::timestamptz)::text from public.documents where id = '${failedDoc}'`)) === "true");

const status = await call(c.token, "GET", `/files/documents/extraction-status?ids=${[mine, theirs].join(",")}`);
check("status omits files the caller can't see", status.status === 200 && status.body.length === 1 && status.body[0].documentId === mine, JSON.stringify(status.body));

// confirm-types: keepOut stores a null marker; a repeated id is written once (last entry wins).
const ko = await unconfirmed(s.id, c.id, "keepout.pdf");
const dup = await call(c.token, "POST", "/files/documents/confirm-types", {
  items: [{ documentId: ko, kind: "transcript", keepOut: false }, { documentId: ko, kind: "resume", keepOut: true }],
});
check("a repeated id is applied once, the last entry wins", dup.status === 200 && dup.body.results.length === 1 && (await sql(`select kind || ':' || available_to_llm::text from public.documents where id = '${ko}'`)) === "resume:false", JSON.stringify(dup.body).slice(0, 300));
check("keepOut stores no extraction marker", (await sql(`select (extraction_requested_at is null)::text from public.documents where id = '${ko}'`)) === "true");

// PATCH /documents/:id with a kind.
const queued = (id) => sql(`select (extraction_requested_at is not null or parse_status <> 'pending')::text || ':' || kind_confirmed::text || ':' || extraction_attempts::text from public.documents where id = '${id}'`);
const p1 = await unconfirmed(s.id, c.id, "patch1.pdf");
await sql(`update public.documents set extraction_attempts = 2, available_to_llm = true where id = '${p1}'`);
const r1 = await call(c.token, "PATCH", `/files/documents/${p1}`, { kind: "transcript" });
const q1 = (await queued(p1)).split(":");
check("counselor kind PATCH confirms and queues", r1.status === 200 && q1[0] === "true" && q1[1] === "true" && Number(q1[2]) <= 1, `${r1.status} ${q1}`);
const p2 = await unconfirmed(s.id, c.id, "patch2.pdf");
const r2 = await call(c.token, "PATCH", `/files/documents/${p2}`, { kind: "financial", availableToLlm: false });
check("counselor kind PATCH with keep-out confirms with no marker", r2.status === 200
  && (await sql(`select kind_confirmed::text || ':' || (extraction_requested_at is null)::text from public.documents where id = '${p2}'`)) === "true:true", JSON.stringify(r2.body).slice(0, 200));
const p3 = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind, kind_confirmed, available_to_llm, source)
  values ('${s.id}', '${s.id}', 'x/own-${Date.now()}', 'own.pdf', 'other', false, true, 'upload') returning id) select id from d`);
const r3 = await call(s.token, "PATCH", `/files/documents/${p3}`, { kind: "resume" });
check("student kind PATCH on their own upload succeeds and leaves the queue alone", r3.status === 200
  && (await sql(`select kind || ':' || kind_confirmed::text || ':' || (extraction_requested_at is null)::text || ':' || parse_status from public.documents where id = '${p3}'`)) === "resume:false:true:pending", `${r3.status} ${JSON.stringify(r3.body).slice(0, 200)}`);

// An unconfirmed Drive pick can't be filed as an essay: its text would reach the tracker through essays.body.
const essayDoc = await unconfirmed(s.id, c.id, "essay-draft.txt");
await sql(`update public.documents set parsed_data = '{"text":"My unconfirmed essay text"}' where id = '${essayDoc}'`);
const fromDoc = await call(c.token, "POST", "/application/essays/from-document", { studentId: s.id, documentId: essayDoc });
check("from-document refuses an unconfirmed file with 409 document_unconfirmed",
  fromDoc.status === 409 && fromDoc.body?.code === "document_unconfirmed" && fromDoc.body?.error === "Choose a type for this file first.", JSON.stringify(fromDoc));
check("and no essay was created from it", (await sql(`select count(*) from public.essays where document_id = '${essayDoc}'`)) === "0");

// Confirming as kept out doesn't wipe a file's earlier result: parse_status is reset only when text is requested.
const parsedDoc = await unconfirmed(s.id, c.id, "parsed.pdf");
await sql(`update public.documents set parse_status = 'parsed', parsed_data = '{"text":"earlier"}' where id = '${parsedDoc}'`);
const keptOut = await call(c.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: parsedDoc, kind: "financial", keepOut: true }] });
check("a kept-out confirmation succeeds", keptOut.body?.results?.[0]?.status === "confirmed", JSON.stringify(keptOut.body));
check("a kept-out confirmation keeps parse_status and requests nothing",
  (await sql(`select parse_status || ':' || (extraction_requested_at is null)::text from public.documents where id = '${parsedDoc}'`)) === "parsed:true");
await sql(`update public.documents set kind_confirmed = false where id = '${parsedDoc}'`);
const patchKeep = await call(c.token, "PATCH", `/files/documents/${parsedDoc}`, { kind: "resume", availableToLlm: false });
check("a PATCH retype of a kept-out file keeps parse_status", patchKeep.status === 200
  && (await sql(`select parse_status || ':' || kind_confirmed::text || ':' || (extraction_requested_at is null)::text from public.documents where id = '${parsedDoc}'`)) === "parsed:true:true", JSON.stringify(patchKeep.body));
const patchRead = await call(c.token, "PATCH", `/files/documents/${parsedDoc}`, { kind: "resume", availableToLlm: true });
check("a PATCH that allows AI requests text and resets parse_status", patchRead.status === 200
  && (await sql(`select (parse_status <> 'parsed')::text from public.documents where id = '${parsedDoc}'`)) === "true");

// A student never sees the server's guess.
const guessed = await unconfirmed(s.id, c.id, "guessed.pdf");
const stList = await call(s.token, "GET", "/files/documents");
const stRow = (stList.body ?? []).find((d) => d.id === guessed);
check("a student's document list carries no kindGuess", stList.status === 200 && stRow && stRow.kindGuess === null, JSON.stringify(stRow));
const cList = await call(c.token, "GET", `/files/documents?studentId=${s.id}`);
check("the counselor's list carries the guess", (cList.body ?? []).find((d) => d.id === guessed)?.kindGuess?.kind === "transcript");
