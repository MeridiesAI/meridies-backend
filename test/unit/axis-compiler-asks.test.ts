import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { compileDirect, gradeOf, type CompileContext } from "../../src/lib/axis/compiler.js";
import { CollegeIndex, RosterIndex } from "../../src/lib/axis/entities.js";
import { SourceLedger } from "../../src/lib/axis/ledger.js";
import { nextState, understand, type DialogueState } from "../../src/lib/axis/nlu.js";

// The code's own questions back: which student, and when a school's break is. Then the reply finishes the lookup.

const COUNSELOR = "c0000000-0000-4000-8000-000000000001";
const CHEN = "00000000-0000-4000-8000-0000000000a1";
const PARK = "00000000-0000-4000-8000-0000000000a2";
const MAYA = "00000000-0000-4000-8000-0000000000a3";
const NOW = new Date("2026-10-11T15:00:00Z");

/** A database that answers selects from fixed rows, filtered by the .eq()s whose column a row has. */
function fakeRequest(tables: Record<string, Record<string, unknown>[]>): FastifyRequest {
  const db = {
    from(table: string) {
      let single = false;
      const eqs: [string, unknown][] = [];
      const chain: Record<string, unknown> = {
        then(resolve: (r: { data: unknown; error: null }) => unknown) {
          const rows = (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => !(c in r) || r[c] === v));
          return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(resolve);
        },
        maybeSingle() {
          single = true;
          return chain;
        },
        eq(c: string, v: unknown) {
          eqs.push([c, v]);
          return chain;
        },
      };
      for (const m of ["select", "order", "limit", "neq", "gte", "lte", "in", "is", "not", "range"]) chain[m] = () => chain;
      return chain;
    },
  };
  return {
    auth: { userId: COUNSELOR },
    profile: { role: "counselor" },
    db,
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
}

const roster = new RosterIndex([
  { id: CHEN, name: "Alex Chen", gradYear: "2027" },
  { id: PARK, name: "Alex Park", gradYear: "2028" },
  { id: MAYA, name: "Maya Brooks", gradYear: "2027" },
]);
const colleges = new CollegeIndex([
  { id: "c1", name: "Cornell University", search_name: "cornell university", search_aka_list: [], catalog_source: "meridies" },
  { id: "c2", name: "Brown University", search_name: "brown university", search_aka_list: [], catalog_source: "meridies" },
]);
const request = fakeRequest({
  profiles: [
    { id: CHEN, counselor_id: COUNSELOR, full_name: "Alex Chen", grad_year: "2027" },
    { id: PARK, counselor_id: COUNSELOR, full_name: "Alex Park", grad_year: "2028" },
  ],
  student_academics: [
    { student_id: CHEN, gpa_unweighted: 3.9 },
    { student_id: PARK, gpa_unweighted: 3.4 },
  ],
  colleges: [{ id: "c1", name: "Cornell University", city: "Ithaca", state: "NY", website: null }],
  college_stats: [{ college_id: "c1", admit_rate: 0.073, data_year: "2023-24", source_verified_at: new Date().toISOString() }],
});
const ctx = (chatStudentId: string | null = null): CompileContext => ({ request, chatStudentId, roster, ledger: new SourceLedger(), now: NOW });
const read = (text: string, state: DialogueState | null = null, chat: string | null = null) =>
  understand(text, { chatStudentId: chat, roster, colleges, state, now: NOW });

test("class year to grade, turning over in July", () => {
  assert.equal(gradeOf("2027", NOW), 12);
  assert.equal(gradeOf("2028", NOW), 11);
  assert.equal(gradeOf("2027", new Date("2026-05-01T00:00:00Z")), 11);
  assert.equal(gradeOf("2031", NOW), null, "not in high school");
  assert.equal(gradeOf("soon", NOW), null);
});

test("two students with one first name: asked in code, then the reply answers the original question", async () => {
  const u = read("What's Alex's GPA?");
  const ask = await compileDirect(u, ctx());
  assert.equal(ask?.frame, "ask-student");
  assert.equal(ask?.text, "Which Alex: Alex Chen (12th) or Alex Park (11th)?");
  assert.equal(ask?.pending?.kind, "student");
  // The engine keeps the question in the dialogue state for one turn.
  const state: DialogueState = { ...nextState(u, null, null, NOW), pending: ask!.pending! };
  for (const [reply, gpa] of [["Chen", "3.9"], ["the 12th grader", "3.9"], ["the first one", "3.9"], ["Park", "3.4"], ["the second", "3.4"]] as const) {
    const answer = await compileDirect(read(reply, state), ctx());
    assert.equal(answer?.frame, "student-facts", reply);
    assert.match(answer!.text, new RegExp(`GPA is ${gpa.replace(".", "\\.")}`), reply);
  }
  // A reply that picks nobody is its own message: no guess.
  const bare = read("Alex", state);
  assert.equal(bare.text, "Alex", "not taken as a reply");
  assert.equal(await compileDirect(bare, ctx()), null, "and never answered about either Alex");
});

test("what's due for a shared first name is asked too; a request that isn't a clean lookup is left to the model", async () => {
  assert.equal((await compileDirect(read("What's due for Alex this week?"), ctx()))?.frame, "ask-student");
  assert.equal(await compileDirect(read("Should Alex apply ED to Cornell?"), ctx()), null, "a judgement: the model asks");
  assert.equal(await compileDirect(read("What's due for Alex after the semester?"), ctx()), null, "a time the code can't read");
  assert.equal(await compileDirect(read("Compare Alex and Maya's GPA"), ctx()), null, "someone else named too");
});

test("a close spelling of a student is never answered about anyone, not even the chat's student", async () => {
  const u = read("What's Mayah's GPA?", null, CHEN);
  assert.equal(u.students[0]?.via, "fuzzy");
  assert.equal(await compileDirect(u, ctx(CHEN)), null);
});

test("a school's break: the code asks for the date, and the reply's date finishes the lookup", async () => {
  const u = read("What's due before winter break?");
  const ask = await compileDirect(u, ctx());
  assert.equal(ask?.frame, "ask-date");
  assert.match(ask!.text, /When does winter break start at your school\?/);
  assert.deepEqual(ask?.pending, { kind: "date", question: "What's due before winter break?", label: "winter break", mode: "by" });
  const during = await compileDirect(read("anything due over spring break?"), ctx());
  assert.match(during!.text, /What are the dates of spring break at your school\?/);
  assert.equal(await compileDirect(read("what's due after winter break"), ctx()), null, "after a break: left to the model");
  const state: DialogueState = { ...nextState(u, null, null, NOW), pending: ask!.pending! };
  const answer = await compileDirect(read("Dec 18", state), ctx());
  assert.equal(answer?.frame, "upcoming");
  assert.match(answer!.text, /before winter break \(Dec 18\)/);
});

test("fixed-rule holidays answer straight from the data", async () => {
  const answer = await compileDirect(read("What's due before Thanksgiving?"), ctx());
  assert.equal(answer?.frame, "upcoming");
  assert.match(answer!.text, /by Thanksgiving \(Nov 26\)/);
});

test("a misspelled school with one close match: 'Assuming you meant …'", async () => {
  const answer = await compileDirect(read("what's the admit rate at Cornel"), ctx());
  assert.equal(answer?.frame, "college-facts");
  assert.match(answer!.text, /^Assuming you meant Cornell University:\n/);
  const exact = await compileDirect(read("what's Cornell's admit rate"), ctx());
  assert.doesNotMatch(exact!.text, /Assuming/);
});
