// lib/studentExport.ts: the batched student export's pure parts. Which ids
// are on the caller's caseload (and that an id that isn't looks exactly like
// one that doesn't exist), what a batch costs against the hourly bucket, each
// student's CSVs and document list, the size cap, and the roster summary the
// Google Sheet is made from.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BATCH_EXPORT_UNITS_PER_HOUR,
  MAX_BATCH_BYTES,
  MAX_BATCH_ROWS,
  pageGuard,
  EXPORT_BATCH_MAX,
  ExportBudget,
  assembleStudent,
  exportCost,
  rosterSummaryCsv,
  splitByCaseload,
} from "../../src/lib/studentExport.js";
import { consumeUnits } from "../../src/lib/limits.js";
import { ReadStopped } from "../../src/lib/pagedRead.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";

test("a batch is at most 25 students, and the bucket holds a 120-student roster", () => {
  assert.equal(EXPORT_BATCH_MAX, 25);
  assert.equal(BATCH_EXPORT_UNITS_PER_HOUR, 200);
  assert.ok(5 * EXPORT_BATCH_MAX >= 120 && 120 <= BATCH_EXPORT_UNITS_PER_HOUR);
});

test("cost is one unit per distinct id asked for, caseload or not", () => {
  assert.equal(exportCost([A]), 1);
  assert.equal(exportCost([A, B, C]), 3);
  assert.equal(exportCost([A, A, A.toUpperCase()]), 1);
});

test("splitByCaseload keeps request order, drops repeats, and calls everything else not_found", () => {
  const r = splitByCaseload([B, C, A, B], [A, B, ME], ME);
  assert.deepEqual(r.allowed, [B, A]);
  assert.deepEqual(r.notFound, [C]);
});

test("the caller's own id (always in caseloadStudentIds) is never exported as a student", () => {
  const r = splitByCaseload([ME, A], [A, ME], ME);
  assert.deepEqual(r.allowed, [A]);
  assert.deepEqual(r.notFound, [ME]);
});

test("ids compare case-insensitively", () => {
  const r = splitByCaseload([A.toUpperCase()], [A], ME);
  assert.deepEqual(r.allowed, [A]);
});

const exported = {
  profile: { id: A, full_name: "Ana =Lopez", grad_year: 2027 },
  records: {
    activities: [
      { id: "x1", student_id: A, name: "Robotics", hours: 4 },
      { id: "x2", student_id: A, name: "=HYPERLINK(\"http://evil\")", hours: -1 },
    ],
    documents: [
      { id: "d1", student_id: A, filename: "transcript.pdf", title: "Transcript", kind: "transcript", source: "upload", storage_path: `${A}/d1-transcript.pdf`, external_web_url: null, parsed_data: { big: true } },
      { id: "d2", student_id: A, filename: "Essay", title: null, kind: "essay", source: "google", storage_path: "", external_web_url: "https://docs.google.com/document/d/abc/edit" },
    ],
  },
  notIncluded: ["research_runs"],
};

test("assembleStudent: the JSON is the per-student export, unchanged", () => {
  const s = assembleStudent(A, exported, "2026-11-07T00:00:00.000Z");
  assert.equal(s.status, "ok");
  assert.equal(s.id, A);
  assert.deepEqual(s.json, { exportedAt: "2026-11-07T00:00:00.000Z", kind: "student", ...exported });
});

test("assembleStudent: one CSV per table with rows, guarded against formulas", () => {
  const s = assembleStudent(A, exported, "2026-11-07T00:00:00.000Z");
  assert.deepEqual(Object.keys(s.csv).sort(), ["activities", "documents", "profile"]);
  const lines = s.csv.activities!.split("\r\n");
  assert.equal(lines[0], "id,student_id,name,hours");
  assert.equal(lines[1], `x1,${A},Robotics,4`);
  assert.equal(lines[2], `x2,${A},"'=HYPERLINK(""http://evil"")",-1`);
  assert.ok(s.csv.profile!.includes("Ana =Lopez"), "a sign mid-text is left");
});

test("assembleStudent: file bytes are not included, the documents are listed by name", () => {
  const s = assembleStudent(A, exported, "2026-11-07T00:00:00.000Z");
  assert.deepEqual(s.documents, [
    { id: "d1", filename: "transcript.pdf", title: "Transcript", kind: "transcript", source: "upload", storagePath: `${A}/d1-transcript.pdf`, externalUrl: null },
    { id: "d2", filename: "Essay", title: null, kind: "essay", source: "google", storagePath: null, externalUrl: "https://docs.google.com/document/d/abc/edit" },
  ]);
});

test("assembleStudent: counts rows (profile included) and bytes", () => {
  const s = assembleStudent(A, exported, "2026-11-07T00:00:00.000Z");
  assert.equal(s.rows, 5);
  assert.ok(s.bytes > 0);
});

test("ExportBudget refuses once the rows or the bytes would go over", () => {
  const b = new ExportBudget(10, 1000);
  assert.equal(b.take(6, 100), true);
  assert.equal(b.take(4, 100), true);
  assert.equal(b.take(1, 1), false);
  const c = new ExportBudget(100, 500);
  assert.equal(c.take(1, 400), true);
  assert.equal(c.take(1, 101), false);
});

test("rosterSummaryCsv: one row per student, fixed columns, guarded", () => {
  const csv = rosterSummaryCsv([
    { name: "Ana Lopez", email: "ana@example.com", gradYear: "2027", status: "active", colleges: 12, tasks: 4, documents: 3, essays: 2, meetings: 1 },
    { name: "=cmd|' /C calc'!A0", email: null, gradYear: null, status: "archived", colleges: 0, tasks: 0, documents: 0, essays: 0, meetings: 0 },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Name,Email,Grad year,Status,Colleges,Tasks,Documents,Essays,Meetings");
  assert.equal(lines[1], "Ana Lopez,ana@example.com,2027,active,12,4,3,2,1");
  assert.equal(lines[2], "'=cmd|' /C calc'!A0,,,archived,0,0,0,0,0");
});

test("consumeUnits spends one unit per student and refuses past the limit", async () => {
  const key = `test:units:${Math.random()}`;
  assert.equal(await consumeUnits(key, 3, 5, 3600), true);
  assert.equal(await consumeUnits(key, 2, 5, 3600), true);
  assert.equal(await consumeUnits(key, 1, 5, 3600), false);
});

test("consumeUnits: a zero cost is refused as a programming error", async () => {
  await assert.rejects(() => consumeUnits("test:zero", 0, 5, 3600));
});

test("a batch answer is at most 10 MB (JSON and CSV together) and 20,000 rows", () => {
  assert.equal(MAX_BATCH_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_BATCH_ROWS, 20_000);
});

test("assembleStudent: bytes count the JSON and every CSV", () => {
  const s = assembleStudent(A, exported, "2026-11-07T00:00:00.000Z");
  const csvBytes = Object.values(s.csv).reduce((n, c) => n + Buffer.byteLength(c), 0);
  assert.equal(s.bytes, Buffer.byteLength(JSON.stringify(s.json)) + csvBytes);
  assert.ok(csvBytes > 0);
});

test("assembleStudent: a truncated table list stays in the JSON", () => {
  const s = assembleStudent(A, { ...exported, truncated: ["courses"] }, "2026-11-07T00:00:00.000Z");
  assert.deepEqual(s.json.truncated, ["courses"]);
  assert.deepEqual(s.truncated, ["courses"]);
  assert.equal(assembleStudent(A, exported, "x").truncated, undefined);
});

test("pageGuard stops a student's read once rows or (JSON x2, for the CSV) bytes pass the cap", () => {
  const rows = (n: number, size = 10) => Array.from({ length: n }, () => ({ t: "x".repeat(size) }));
  const g = pageGuard(5, 1_000_000);
  g(rows(3));
  assert.throws(() => g(rows(3)), ReadStopped);
  const b = pageGuard(1000, 100);
  b(rows(1, 10)); // ~20 bytes of JSON, x2
  assert.throws(() => b(rows(1, 60)), ReadStopped);
});
