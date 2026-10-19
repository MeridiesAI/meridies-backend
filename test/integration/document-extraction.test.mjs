// Extraction after confirming: stored copy -> parsed_data, two at a time, restart recovery, keep-out mid-queue.
import { API, CRON_SECRET, call, check, rest, sql } from "./harness.mjs";
import { user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";
import { textPdf } from "../fixtures/pdf/build.ts";

const c = await user("extract");
const s = await studentOf(c, "extract-student");

async function upload(name, bytes, type) {
  const path = `${s.id}/ex-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  const up = await rest(c.token, "POST", `/storage/v1/object/student-documents/${path}`, bytes, { "Content-Type": type });
  if (up.status !== 200) throw new Error(`upload ${up.status}`);
  return sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, mime_type, kind, kind_confirmed, available_to_llm, source)
    values ('${s.id}', '${c.id}', '${path}', '${name}', '${type}', 'other', false, false, 'integration') returning id) select id from d`);
}
const state = async (ids) => (await call(c.token, "GET", `/files/documents/extraction-status?ids=${ids.join(",")}`)).body;
async function until(ids, done, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(ids);
    if (done(st)) return st;
    if (Date.now() > end) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const pdf = await upload("t.pdf", textPdf(["Official Transcript", "Cumulative GPA 3.9"]), "application/pdf");
const txt = await upload("n.txt", new TextEncoder().encode("Notes from our meeting about the essay"), "text/plain");
const scan = await upload("scan.pdf", textPdf([""]), "application/pdf");

const confirm = await call(c.token, "POST", "/files/documents/confirm-types", { items: [
  { documentId: pdf, kind: "transcript", keepOut: false },
  { documentId: txt, kind: "other", keepOut: false },
  { documentId: scan, kind: "transcript", keepOut: false },
] });
check("confirm answers per item", confirm.status === 200 && confirm.body.results.every((r) => r.status === "confirmed"), JSON.stringify(confirm.body));

const final = await until([pdf, txt, scan], (st) => st.every((r) => !["queued", "reading"].includes(r.state)));
const by = Object.fromEntries(final.map((r) => [r.documentId, r.state]));
check("the PDF's text was extracted", by[pdf] === "done", JSON.stringify(final));
check("the text file's text was extracted", by[txt] === "done");
check("a PDF with no text layer ends empty", by[scan] === "empty");
check("the PDF's text is stored", (await sql(`select parsed_data->>'text' from public.documents where id = '${pdf}'`)).includes("Official Transcript"));
check("the request marker is cleared", (await sql(`select count(*) from public.documents where id in ('${pdf}','${txt}','${scan}') and extraction_requested_at is not null`)) === "0");

// Review Focus 1: a crashed in-progress item (expired lease) is retried; after 3 attempts it is failed.
const recover = () => fetch(`${API}/internal/documents/extraction-recover`, {
  method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` },
});
const anon = await call(c.token, "POST", "/internal/documents/extraction-recover", undefined);
check("recovery is a CRON_SECRET route", anon.status === 401 || anon.status === 403 || anon.status === 503, `status ${anon.status}`);

const orphan = await upload("o.pdf", textPdf(["Score Report"]), "application/pdf");
await sql(`update public.documents set kind = 'test-report', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now() - interval '10 minutes', extraction_attempts = 1, extraction_lease_until = now() - interval '1 minute' where id = '${orphan}'`);
const res = await recover();
check("recovery runs with the cron secret", res.status === 202, `status ${res.status}`);
const after = await until([orphan], (st) => st[0]?.state === "done");
check("a crashed in-progress item is retried after its lease expires", after[0]?.state === "done", JSON.stringify(after));
check("the retry counted as an attempt", (await sql(`select extraction_attempts::text from public.documents where id = '${orphan}'`)) === "2");

const doomed = await upload("d.pdf", textPdf(["x"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now() - interval '10 minutes', extraction_attempts = 3, extraction_lease_until = now() - interval '1 minute' where id = '${doomed}'`);
await recover();
const gaveUp = await until([doomed], (st) => st[0]?.state === "failed", 5_000);
check("after 3 attempts the item is marked failed", gaveUp[0]?.state === "failed"
  && (await sql(`select parse_error from public.documents where id = '${doomed}'`)) === "gave-up", JSON.stringify(gaveUp));

const held = await upload("h.pdf", textPdf(["Official Transcript"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now(), extraction_attempts = 1, extraction_lease_until = now() + interval '2 minutes' where id = '${held}'`);
await recover();
check("a live lease is left alone", (await sql(`select parse_status from public.documents where id = '${held}'`)) === "parsing");

// No backfill: an old pending PDF with no request marker is never touched.
const old = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, mime_type, kind)
  values ('${s.id}', '${c.id}', 'x/old-${Date.now()}.pdf', 'old.pdf', 'application/pdf', 'transcript') returning id) select id from d`);
await recover();
check("no backfill: an old document without a request stays as it was",
  (await sql(`select parse_status from public.documents where id = '${old}'`)) === "pending");

// Review Focus 2 (no race): a row already kept out, still carrying a marker, gets no text and loses the marker.
const keep = await upload("k.pdf", textPdf(["Private"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = false, parse_status = 'pending',
  extraction_requested_at = now() where id = '${keep}'`);
await recover();
await new Promise((r) => setTimeout(r, 3_000));
check("a file kept out while queued gets no text and its marker is cleared",
  (await sql(`select coalesce(parsed_data->>'text', '') from public.documents where id = '${keep}'`)) === ""
  && (await sql(`select extraction_requested_at is null from public.documents where id = '${keep}'`)) === "t");

// Fix 1: the queue reads only the documents bucket. A row naming another bucket ends failed with no text.
const imp = await upload("b.txt", new TextEncoder().encode("secret from another bucket"), "text/plain");
await sql(`update public.documents set bucket = 'imports' where id = '${imp}'`);
const badConfirm = await call(c.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: imp, kind: "resume", keepOut: false }] });
check("a row in another bucket can still be confirmed", badConfirm.body?.results?.[0]?.status === "confirmed", JSON.stringify(badConfirm.body));
const bad = await until([imp], (st) => st[0]?.state === "failed", 10_000);
check("a confirmed row in another bucket ends failed with no text", bad[0]?.state === "failed"
  && (await sql(`select coalesce(parse_error, '') || ':' || coalesce(parsed_data->>'text', '') || ':' || (extraction_requested_at is null)::text || ':' || (extraction_lease_until is null)::text from public.documents where id = '${imp}'`)) === "bad-bucket::true:true", JSON.stringify(bad));
// Round 3: a dot-segment path names another object (or bucket) than the row's own; the queue never follows it.
const dotted = await upload("d.txt", new TextEncoder().encode("the row's own text"), "text/plain");
const elsewhere = await sql(`select storage_path from public.documents where id = '${txt}'`);
await sql(`update public.documents set storage_path = '${s.id}/x/../../${elsewhere}' where id = '${dotted}'`);
await call(c.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: dotted, kind: "resume", keepOut: false }] });
const dottedState = await until([dotted], (st) => st[0]?.state === "failed", 10_000);
check("a confirmed row with a dot-segment path ends failed with no text", dottedState[0]?.state === "failed"
  && (await sql(`select coalesce(parse_error, '') || ':' || coalesce(parsed_data->>'text', '') from public.documents where id = '${dotted}'`)) === "bad-path:", JSON.stringify(dottedState));
for (const bucket of ["imports", "axis-attachments", "student-banners"]) {
  const reg = await call(c.token, "POST", "/files/documents", { studentId: s.id, bucket, storagePath: `${s.id}/x-${Date.now()}.pdf`, filename: "x.pdf" });
  check(`POST /files/documents with bucket ${bucket} is refused`, reg.status === 400, `status ${reg.status}`);
}
const okReg = await call(c.token, "POST", "/files/documents", { studentId: s.id, bucket: "student-documents", storagePath: `${s.id}/ok-${Date.now()}.pdf`, filename: "ok.pdf" });
check("POST /files/documents with the documents bucket still works", okReg.status === 201 && okReg.body.bucket === "student-documents", `status ${okReg.status}`);

// Fix 4: a request still pending after the 24-hour window is given up, so it can't sit at "queued" forever.
const stale = await upload("s.pdf", textPdf(["Official Transcript"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'pending',
  extraction_requested_at = now() - interval '25 hours', extraction_lease_until = null where id = '${stale}'`);
await recover();
await new Promise((r) => setTimeout(r, 1_000));
check("a request older than 24 hours is marked failed / gave-up with its marker cleared",
  (await sql(`select parse_status || ':' || coalesce(parse_error, '') || ':' || (extraction_requested_at is null)::text || ':' || (extraction_lease_until is null)::text from public.documents where id = '${stale}'`)) === "failed:gave-up:true:true");
check("and it reports as failed", (await state([stale]))[0]?.state === "failed");
