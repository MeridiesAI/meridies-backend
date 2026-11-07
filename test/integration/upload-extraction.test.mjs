// A counselor's upload on the Files page queues text extraction right away, as confirming a type does.
// Before this, the row stayed at parse_status "pending" with no request marker, so AxIS never got its text.
import { call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";
import { textPdf } from "../fixtures/pdf/build.ts";

const c = await user("upload-extract");
const s = await studentOf(c, "upload-extract-student");

/** Upload to Storage and register the row, the way the app's Files page does. */
async function upload(who, name, bytes, type, extra = {}) {
  const path = `${s.id}/up-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  const up = await rest(who.token, "POST", `/storage/v1/object/student-documents/${path}`, bytes, { "Content-Type": type });
  if (up.status !== 200) throw new Error(`upload ${up.status}`);
  return call(who.token, "POST", "/files/documents", {
    studentId: s.id, bucket: "student-documents", storagePath: path, filename: name, mimeType: type, sizeBytes: bytes.length, ...extra,
  });
}
const state = async (ids) => (await call(c.token, "GET", `/files/documents/extraction-status?ids=${ids.join(",")}`)).body;
async function until(ids, done, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(ids);
    if (done(st) || Date.now() > end) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 1. A counselor's upload the AI may read: its text is extracted without any further step.
const pdf = await upload(c, "transcript.pdf", textPdf(["Official Transcript", "Cumulative GPA 3.9"]), "application/pdf", { kind: "transcript" });
check("a counselor's upload is registered", pdf.status === 201, `status ${pdf.status}`);
const done = await until([pdf.body.id], (st) => st[0]?.state === "done");
check("a counselor's upload is read for AI with no type confirmation", done[0]?.state === "done", JSON.stringify(done));
check("its text is stored for AxIS",
  (await sql(`select parsed_data->>'text' from public.documents where id = '${pdf.body.id}'`)).includes("Official Transcript"));

// 2. An upload with no kind (the app sends one, but the API defaults to "other") is read too.
const plain = await upload(c, "notes.txt", new TextEncoder().encode("Notes from our meeting about the essay"), "text/plain");
const plainDone = await until([plain.body.id], (st) => st[0]?.state === "done");
check("an upload with the default kind is read too", plainDone[0]?.state === "done", JSON.stringify(plainDone));

// 3. Kept out of AI on upload: no request, no text.
const kept = await upload(c, "private.pdf", textPdf(["Private note"]), "application/pdf", { kind: "other", availableToLlm: false });
check("a kept-out upload is registered", kept.status === 201, `status ${kept.status}`);
check("a kept-out upload is not queued",
  (await sql(`select (extraction_requested_at is null)::text || ':' || parse_status from public.documents where id = '${kept.body.id}'`)) === "true:pending");
check("and reports as kept out", (await state([kept.body.id]))[0]?.state === "kept-out");

// 4. A student's own upload still works (the database refuses a student setting the queue columns) and is not queued.
const mine = await upload(s, "my-essay.pdf", textPdf(["My essay draft"]), "application/pdf", { kind: "essay" });
check("a student's upload still works", mine.status === 201, `status ${mine.status} ${JSON.stringify(mine.body)}`);
check("a student's upload is not queued",
  (await sql(`select (extraction_requested_at is null)::text from public.documents where id = '${mine.body.id}'`)) === "true");
