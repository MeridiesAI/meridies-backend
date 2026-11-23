// "Both": one blast to the students AND their parents (lib/blasts.ts resolveAudience), on a fake database, so the
// rules run without one. test/integration/blasts-both.test.mjs sends the same roster through the real API.
//
//   a  own address; parent Ann          b  own address; parents Cy (shared with c, typed in two cases) and Off (alerts off)
//   c  own address; parent Cy           d  own address; a parent who typed the student's OWN address (in capitals)
//   e  NO own address; parent Eve       f  NO own address, no parent
//   g  own address, no parent
import assert from "node:assert/strict";
import { test } from "node:test";
import { audienceInput, resolveAudience } from "../../src/lib/blasts.js";

const names: Record<string, string> = { a: "Abe Archer", b: "Bea Baker", c: "Cal Baker", d: "Dee Dunn", e: "Eli Evans", f: "Fay Ford", g: "Gus Grant" };
const profiles = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
  id,
  full_name: names[id],
  email: ["e", "f"].includes(id) ? "" : `${id}@students.test`,
  grad_year: "2027",
}));
const guardians = [
  { student_id: "a", full_name: "Ann Archer", email: "ann@families.test", alerts_enabled: true, is_primary: true },
  { student_id: "b", full_name: "Cy Baker", email: "cy@families.test", alerts_enabled: true, is_primary: true },
  { student_id: "b", full_name: "Off Parent", email: "off@families.test", alerts_enabled: false, is_primary: false },
  { student_id: "c", full_name: "Cy Baker", email: "CY@families.test", alerts_enabled: true, is_primary: true },
  { student_id: "d", full_name: "Dad Dunn", email: "D@STUDENTS.TEST", alerts_enabled: true, is_primary: true },
  { student_id: "e", full_name: "Eve Evans", email: "eve@families.test", alerts_enabled: true, is_primary: true },
];

/** Every query chain answers with the whole table: with no filters resolveAudience asks only for the roster and the guardians. */
const fakeDb = (people: Record<string, unknown>[], parents: Record<string, unknown>[]) =>
  ({
    from(table: string) {
      const rows = table === "profiles" ? people : table === "guardians" ? parents : [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "in", "limit"]) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
      return q;
    },
  }) as never;
const db = fakeDb(profiles, guardians);

const resolve = (recipientType: "students" | "parents" | "both") => resolveAudience(db, "counselor", audienceInput.parse({ recipientType }));
const mailed = (r: Awaited<ReturnType<typeof resolve>>) => r.recipients.filter((x) => x.email).map((x) => x.email!.toLowerCase()).sort();
const skipped = (r: Awaited<ReturnType<typeof resolve>>) => r.recipients.filter((x) => !x.email).map((x) => x.fullName).sort();

test("students and parents on their own are what they were", async () => {
  const s = await resolve("students");
  assert.deepEqual(mailed(s), ["a@students.test", "b@students.test", "c@students.test", "d@students.test", "g@students.test"]);
  assert.deepEqual(skipped(s), [names.e, names.f]);

  const p = await resolve("parents");
  assert.deepEqual(mailed(p), ["ann@families.test", "cy@families.test", "d@students.test", "eve@families.test"]);
  assert.deepEqual(skipped(p), [names.f, names.g]);
});

test("both reaches every student address and every parent address, the shared one once (5 + 4 - 1)", async () => {
  const r = await resolve("both");
  assert.equal(r.selected, 7);
  assert.deepEqual(mailed(r), [
    "a@students.test", "ann@families.test", "b@students.test", "c@students.test", "cy@families.test",
    "d@students.test", "eve@families.test", "g@students.test",
  ]);
});

test("both: an address a student and a parent share is mailed once, as the student", async () => {
  const r = await resolve("both");
  const toD = r.recipients.filter((x) => x.email?.toLowerCase() === "d@students.test");
  assert.equal(toD.length, 1);
  assert.equal(toD[0].kind, "student");
});

test("both: a student with only a parent is reachable, and only a student nobody can reach is skipped", async () => {
  const r = await resolve("both");
  const reach = (id: string) => r.students.find((s) => s.id === id)?.reachable;
  assert.equal(reach("e"), true);
  assert.equal(reach("f"), false);
  assert.equal(reach("g"), true);
  assert.deepEqual(skipped(r), [names.f]);
});

test("both: siblings who share a parent get one email naming both, and a parent with alerts off none", async () => {
  const r = await resolve("both");
  const cy = r.recipients.filter((x) => x.email?.toLowerCase() === "cy@families.test");
  assert.equal(cy.length, 1);
  assert.equal(cy[0].kind, "guardian");
  assert.equal(cy[0].studentFirstName, "Bea and Cal");
  assert.equal(mailed(r).includes("off@families.test"), false);
});

test("both: a student on the list is reached under their own first name", async () => {
  const r = await resolve("both");
  assert.equal(r.recipients.find((x) => x.email === "a@students.test")?.studentFirstName, "Abe");
});

test("both: a parent who typed a sibling's own address is still named on that one email", async () => {
  // Xia's sign-in address is her mother's; Yan has none of his own and the same mother.
  const mine = fakeDb(
    [
      { id: "x", full_name: "Xia Lee", email: "Mom@Home.test", grad_year: "2027" },
      { id: "y", full_name: "Yan Lee", email: "", grad_year: "2027" },
    ],
    [{ student_id: "y", full_name: "Mom Lee", email: "mom@home.test", alerts_enabled: true, is_primary: true }]
  );
  const both = await resolveAudience(mine, "counselor", audienceInput.parse({ recipientType: "both" }));
  assert.deepEqual(mailed(both), ["mom@home.test"]);
  assert.equal(both.recipients.filter((r) => r.email).length, 1);
  assert.equal(both.recipients[0].studentFirstName, "Xia and Yan");
  assert.equal(both.students.find((s) => s.id === "y")?.reachable, true);
});
