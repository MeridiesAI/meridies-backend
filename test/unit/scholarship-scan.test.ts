import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyScholarships,
  DEFAULT_PREFS,
  matchOne,
  type ScholarshipAttrs,
  type SchoolScope,
} from "../../src/lib/studentAid.js";

// School-specific scholarships (20261111000006): a row with a college_id is a school's own award. It reaches a
// student's scan only when that college is on their list, and a counselor's row only when it belongs to the
// student's own practice (their counselor, or that counselor's firm). Pure: no database.

const TODAY = "2026-11-08";
const COUNSELOR = "00000000-0000-4000-8000-0000000000c1";
const FIRM = "00000000-0000-4000-8000-0000000000f1";
const OTHER_COUNSELOR = "00000000-0000-4000-8000-0000000000c2";
const OTHER_FIRM = "00000000-0000-4000-8000-0000000000f2";
const STANFORD = "00000000-0000-4000-8000-00000000057a";
const MIT = "00000000-0000-4000-8000-000000000317";

const attrs: ScholarshipAttrs = {
  firstName: "Ana",
  majors: ["biology"],
  state: "CA",
  gpa: 3.9,
  grade: 12,
  gender: null,
  activityText: [],
  axes: [],
  audience: [],
};

const scope: SchoolScope = {
  rostered: new Map([[STANFORD, "Stanford University"]]),
  practice: { counselorId: COUNSELOR, firmId: FIRM },
};

let seq = 0;
function row(extra: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    name: `Award ${seq}`,
    eligibility: {},
    tags: [],
    is_active: true,
    deadline: "2027-02-01",
    opens_at: null,
    source: "catalog",
    college_id: null,
    owner_counselor_id: null,
    firm_id: null,
    source_verified_at: null,
    ...extra,
  };
}

const run = (rows: Record<string, unknown>[], s: SchoolScope = scope) =>
  classifyScholarships(rows, attrs, { today: TODAY, prefs: DEFAULT_PREFS, recommended: new Map(), school: s });

test("matchOne keeps its existing answers for a catalog row", () => {
  assert.equal(matchOne({ eligibility: {} }, attrs).matchedOn, "open");
  assert.equal(matchOne({ eligibility: { states: ["CA"] } }, attrs).matchedOn, "state");
  assert.equal(matchOne({ eligibility: { states: ["NY"] } }, attrs).ok, false);
});

test("a counselor's school row for a rostered college matches on 'school'", () => {
  const r = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: COUNSELOR });
  const out = run([r]);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].matchedOn, "school");
  assert.equal(out.matches[0].collegeId, STANFORD);
  assert.equal(out.matches[0].source, "counselor");
  assert.equal(out.matches[0].verified, false);
  assert.match(out.matches[0].fit, /Stanford University/);
});

test("a school row for a college not on the student's list is left out", () => {
  const r = row({ source: "counselor", college_id: MIT, owner_counselor_id: COUNSELOR });
  const out = run([r]);
  assert.equal(out.matches.length, 0);
  assert.equal(out.held.length, 0);
});

test("a firm colleague's row counts; another practice's row never does", () => {
  const firmRow = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: "00000000-0000-4000-8000-0000000000c3", firm_id: FIRM });
  const foreign = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: OTHER_COUNSELOR, firm_id: OTHER_FIRM });
  const foreignSolo = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: OTHER_COUNSELOR });
  const out = run([firmRow, foreign, foreignSolo]);
  assert.deepEqual(out.matches.map((m) => m.id), [firmRow.id]);
});

test("with no practice known (the lookup failed), counselor rows are left out and the catalog still matches", () => {
  const school = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: COUNSELOR });
  const national = row({});
  const out = run([school, national], { rostered: scope.rostered, practice: null });
  assert.deepEqual(out.matches.map((m) => m.id), [national.id]);
  assert.equal(out.matches[0].matchedOn, "open");
});

test("a closed school row is held, like any other", () => {
  const r = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: COUNSELOR, deadline: "2026-01-15" });
  const out = run([r]);
  assert.equal(out.matches.length, 0);
  assert.deepEqual(out.held.map((h) => [h.id, h.reason]), [[r.id, "closed"]]);
});

test("a school row's own eligibility gates still apply", () => {
  const r = row({ source: "counselor", college_id: STANFORD, owner_counselor_id: COUNSELOR, eligibility: { states: ["NY"] } });
  assert.equal(run([r]).matches.length, 0);
});

test("verified is the editor's stamp, nothing else", () => {
  const r = row({ source: "catalog", college_id: STANFORD, source_verified_at: "2026-10-01T00:00:00Z" });
  const out = run([r]);
  assert.equal(out.matches[0].matchedOn, "school");
  assert.equal(out.matches[0].verified, true);
});

test("rows from before the migration (no source or college columns) read as the catalog", () => {
  const legacy = { id: "00000000-0000-4000-8000-0000000000aa", name: "Old", eligibility: {}, tags: [], deadline: "2027-03-01" };
  const out = run([legacy]);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].source, "catalog");
  assert.equal(out.matches[0].collegeId, null);
});
